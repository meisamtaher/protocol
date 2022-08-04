import { expect } from 'chai'
import { ethers } from 'hardhat'
import { Wallet } from 'ethers'
import * as helpers from '@nomicfoundation/hardhat-network-helpers'
import { whileImpersonating } from '../utils/impersonation'

import { fp } from '../../common/numbers'
import { advanceTime, advanceBlocks } from '../../test/utils/time'

import * as sc from '../../typechain' // All smart contract types

import { addr } from './common'

const user = (i: number) => addr((i + 1) * 0x10000)
const ConAt = ethers.getContractAt
const F = ethers.getContractFactory

const componentsOf = async (main: sc.IMain) => ({
  rsr: await ConAt('ERC20Fuzz', await main.rsr()),
  rToken: await ConAt('RTokenP1Fuzz', await main.rToken()),
  stRSR: await ConAt('StRSRP1Fuzz', await main.stRSR()),
  assetRegistry: await ConAt('AssetRegistryP1Fuzz', await main.assetRegistry()),
  basketHandler: await ConAt('BasketHandlerP1Fuzz', await main.basketHandler()),
  backingManager: await ConAt('BackingManagerP1Fuzz', await main.backingManager()),
  distributor: await ConAt('DistributorP1Fuzz', await main.distributor()),
  rsrTrader: await ConAt('RevenueTraderP1Fuzz', await main.rsrTrader()),
  rTokenTrader: await ConAt('RevenueTraderP1Fuzz', await main.rTokenTrader()),
  furnace: await ConAt('FurnaceP1Fuzz', await main.furnace()),
  broker: await ConAt('BrokerP1Fuzz', await main.broker()),
})
type Components = Awaited<ReturnType<typeof componentsOf>>

// { gasLimit: 0x1ffffffff }
describe('The Normal Operations scenario', () => {
  let scenario: sc.NormalOpsScenario
  let main: sc.MainP1Fuzz
  let comp: Components
  let startState: Awaited<ReturnType<typeof helpers.takeSnapshot>>

  let owner: Wallet
  let alice: Wallet

  before('deploy...', async () => {
    ;[owner, alice] = (await ethers.getSigners()) as unknown as Wallet[]
    scenario = await (await F('NormalOpsScenario')).deploy({ gasLimit: 0x1ffffffff })
    main = await ConAt('MainP1Fuzz', await scenario.main())
    comp = await componentsOf(main)
    startState = await helpers.takeSnapshot()
  })

  beforeEach(async () => {
    await startState.restore()
  })

  it('deploys as expected', async () => {
    // users
    expect(await main.numUsers()).to.equal(3)
    expect(await main.users(0)).to.equal(user(0))
    expect(await main.users(1)).to.equal(user(1))
    expect(await main.users(2)).to.equal(user(2))

    // tokens and user balances
    expect(await main.numTokens()).to.equal(6)
    for (let t = 0; t < 6; t++) {
      const token = await ConAt('ERC20Fuzz', await main.tokens(t))
      const sym = t < 3 ? 'C' + t : 'USD' + (t - 3)
      expect(await token.symbol()).to.equal(sym)

      for (let u = 0; u < 3; u++) {
        expect(await token.balanceOf(user(u))).to.equal(fp(1e6))
      }
    }

    for (let u = 0; u < 3; u++) {
      expect(await comp.rsr.balanceOf(user(u))).to.equal(fp(1e6))
    }

    // assets and collateral
    const erc20s = await comp.assetRegistry.erc20s()
    expect(erc20s.length).to.equal(8)
    for (const erc20 of erc20s) {
      if (erc20 === comp.rToken.address) await comp.assetRegistry.toAsset(erc20)
      else if (erc20 === comp.rsr.address) await comp.assetRegistry.toAsset(erc20)
      else await comp.assetRegistry.toColl(erc20)
    }

    // relations between components and their addresses
    expect(await comp.assetRegistry.isRegistered(comp.rsr.address)).to.be.true
    expect(await comp.assetRegistry.isRegistered(comp.rToken.address)).to.be.true
    expect(await comp.rToken.main()).to.equal(main.address)
    expect(await comp.stRSR.main()).to.equal(main.address)
    expect(await comp.assetRegistry.main()).to.equal(main.address)
    expect(await comp.basketHandler.main()).to.equal(main.address)
    expect(await comp.backingManager.main()).to.equal(main.address)
    expect(await comp.distributor.main()).to.equal(main.address)
    expect(await comp.rsrTrader.main()).to.equal(main.address)
    expect(await comp.rTokenTrader.main()).to.equal(main.address)
    expect(await comp.furnace.main()).to.equal(main.address)
    expect(await comp.broker.main()).to.equal(main.address)
  })

  it('lets users trade two fiatcoins', async () => {
    const usd0 = await ConAt('ERC20Fuzz', await main.tokens(3))
    const rsr = comp.rsr

    // Alice starts with 123 USD0
    await usd0.mint(alice.address, fp(123))
    expect(await usd0.balanceOf(alice.address)).to.equal(fp(123))
    expect(await rsr.balanceOf(alice.address)).to.equal(0)

    // Init the trade
    const tradeReq = {
      buy: await comp.assetRegistry.toAsset(comp.rsr.address),
      sell: await comp.assetRegistry.toAsset(usd0.address),
      minBuyAmount: fp(456),
      sellAmount: fp(123),
    }

    const trade = await (await F('TradeMock')).deploy()

    // Alice sends 123 USD0 to the trade
    await usd0.connect(alice).transfer(trade.address, fp(123))
    expect(await usd0.balanceOf(trade.address)).to.equal(fp(123))

    await trade.init(main.address, alice.address, 5, tradeReq)

    expect(await trade.canSettle()).to.be.false
    await expect(trade.settle()).to.be.reverted

    // Wait and settle the trade
    await advanceTime(5)

    expect(await trade.canSettle()).to.be.true

    // yeah, we could do this more simply with trade.connect(alice), but I'm testing spoof() too
    await main.spoof(owner.address, alice.address)
    await trade.settle()
    await main.unspoof(owner.address)

    // Alice now has no USD0 and 456 RSR.
    expect(await usd0.balanceOf(alice.address)).to.equal(0)
    expect(await rsr.balanceOf(alice.address)).to.equal(fp(456))
  })

  it('lets BackingManager buy and sell RTokens', async () => {
    const usd0 = await ConAt('ERC20Fuzz', await main.tokens(3))
    const bm_addr = comp.backingManager.address
    const rtoken_asset = await comp.assetRegistry.toAsset(comp.rToken.address)
    const usd0_asset = await comp.assetRegistry.toAsset(usd0.address)

    // This is a little bit confusing here -- we're pretending to be the backingManager here
    // just so that we are a trader registered with the Broker. RToken trader would work too, I
    // think, and would be a somewhat cleaner test.

    // As owner, mint 123 USD0 to BackingMgr
    await usd0.mint(bm_addr, fp(123))
    expect(await usd0.balanceOf(bm_addr)).to.equal(fp(123))
    expect(await comp.rToken.balanceOf(bm_addr)).to.equal(0)

    // As BackingMgr, approve the broker for 123 USD0
    await main.spoof(owner.address, bm_addr)
    await usd0.approve(comp.broker.address, fp(123))

    // As BackingMgr, init the trade
    const tradeReq = {
      buy: rtoken_asset,
      sell: usd0_asset,
      minBuyAmount: fp(456),
      sellAmount: fp(123),
    }

    await comp.broker.openTrade(tradeReq)

    // (trade has 123 usd0)
    const trade = await ConAt('TradeMock', await comp.broker.lastOpenedTrade())
    expect(await trade.origin()).to.equal(bm_addr)
    expect(await usd0.balanceOf(trade.address)).to.equal(fp(123))

    // Settle the trade.
    await advanceTime(31 * 60)
    await comp.broker.settleTrades()

    // (BackingMgr has no USD0 and 456 rToken.)
    expect(await usd0.balanceOf(bm_addr)).to.equal(0)
    expect(await comp.rToken.balanceOf(bm_addr)).to.equal(fp(456))

    // ================ Now, we sell the USD0 back, for RToken!

    // As BackingMgr, approve the broker for 456 RTokens
    await comp.rToken.approve(comp.broker.address, fp(456))

    // As BackingMgr, init the trade
    const tradeReq2 = {
      buy: usd0_asset,
      sell: rtoken_asset,
      minBuyAmount: fp(789),
      sellAmount: fp(456),
    }
    await comp.broker.openTrade(tradeReq2)

    // (new trade should have 456 rtoken)
    const trade2 = await ConAt('TradeMock', await comp.broker.lastOpenedTrade())
    expect(await trade2.origin()).to.equal(bm_addr)
    expect(await comp.rToken.balanceOf(trade2.address)).to.equal(fp(456))

    // As BackingMgr, settle the trade
    await advanceTime(31 * 60)
    await comp.broker.settleTrades()

    // (Backing Manager has no RTokens and 789 USD0)
    expect(await usd0.balanceOf(bm_addr)).to.equal(fp(789))
    expect(await comp.rToken.balanceOf(bm_addr)).to.equal(0)

    await main.unspoof(owner.address)
  })

  it('guarantees that someTokens = tokens and someAddr = users on their shared range', async () => {
    const numTokens = await main.numTokens()
    for (let i = 0; numTokens.gt(i); i++) {
      expect(await main.tokens(i)).to.equal(await main.someToken(i))
    }
    const numUsers = await main.numUsers()
    for (let i = 0; numUsers.gt(i); i++) {
      expect(await main.users(i)).to.equal(await main.someAddr(i))
    }
  })

  it('lets users transfer tokens', async () => {
    const zed_addr = user(0)
    const dest_addr = await main.someAddr(1)
    const token = await ConAt('ERC20Fuzz', await main.someToken(0))

    await whileImpersonating(zed_addr, async (zed) => {
      const dest_bal_0 = await token.balanceOf(dest_addr)
      const zed_bal_0 = await token.balanceOf(zed_addr)

      expect(await main.tokens(0)).to.equal(await main.someToken(0))
      expect(await main.someAddr(0)).to.equal(zed_addr)

      await scenario.connect(zed).transfer(1, 0, fp(3))

      const dest_bal = await token.balanceOf(dest_addr)
      const zed_bal = await token.balanceOf(zed_addr)

      expect(dest_bal.sub(dest_bal_0)).to.equal(fp(3))
      expect(zed_bal_0.sub(zed_bal)).to.equal(fp(3))
    })
  })
})
