import { BigNumber, ethers } from "ethers";
import { formatEther, formatUnits, parseEther, parseUnits } from "ethers/lib/utils";
import hre from "hardhat";
import fetch from "isomorphic-fetch";
import { impersonateAccount, mine, setCode, setNextBlockBaseFeePerGas } from "@nomicfoundation/hardhat-network-helpers";


interface OnceInchToken {
  symbol: string
  address: string
  decimals: number
}

interface QuoteResponse {
  inputTokenAmount: BigNumber,
  inputToken: OnceInchToken
  basketToken: OnceInchToken
}

const oneInchQuote = async (
  tokenIn: string,
  tokenOut: string,
  amountIn: ethers.BigNumber
): Promise<QuoteResponse> => {
  console.log(`${tokenIn} => ${tokenOut}`)
  const resp = await fetch(
    `https://api.1inch.io/v5.0/1/quote?fromTokenAddress=${tokenIn}&toTokenAddress=${tokenOut}&amount=${amountIn.toString()}`
  )
  const out: {
    fromToken: OnceInchToken,
    toToken: OnceInchToken,
    toTokenAmount: string
    fromTokenAmount: string
    estimatedGas: number
  } = await resp.json()
  if ((out as any).error) {
    console.log(out);
    console.log(tokenIn, tokenOut);
  }
  return {
    inputTokenAmount: ethers.BigNumber.from(out.toTokenAmount),
    basketToken: out.fromToken,
    inputToken: out.toToken,
  }
}

interface SwapResponse {
  toTokenAmount: string
  tx: {
    data: string
  }
}

const bannedTokens = new Set([
  "0xc11b1268c1a384e55c48c2391d8d480264a3a7f4"
])

const oneInchSwap = async (
  userAddr: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: ethers.BigNumber,
  slippage: number,
  dest: string
) => {

  const url = `https://api.1inch.io/v5.0/1/swap?destReceiver=${dest}&fromAddress=${userAddr}&fromTokenAddress=${tokenIn}&toTokenAddress=${tokenOut}&amount=${amountIn.toString()}&disableEstimate=true&slippage=${slippage}`
  const resp = await fetch(
    url
  )
  const out = await resp.json()
  if (out.tx == null) {
    console.log(url)
    console.log(out)
  }
  return out as SwapResponse
}

const basketTokensToAmountIn = async (
  inputToken: string,
  basketAmounts: { basketToken: string, amount: ethers.BigNumber }[]
) => {
  let totalAmountIn = ethers.constants.Zero
  const quotes = await Promise.all(basketAmounts.filter(i => {
    if (i.basketToken.toLowerCase() === inputToken.toLowerCase()) {
      totalAmountIn = totalAmountIn.add(i.amount)
      return false
    }
    return true
  }).map(async ({ basketToken, amount }) => {
    return oneInchQuote(
      basketToken,
      inputToken,
      amount
    )
  }))

  for (const quote of quotes) {
    totalAmountIn = totalAmountIn.add(quote.inputTokenAmount)
  }
  return {
    totalAmountIn,
    quote: quotes
  }
}

async function main() {
  await setNextBlockBaseFeePerGas(parseUnits("0.1", "gwei"))
  await mine(1);
  const provider = new ethers.providers.JsonRpcProvider(process.env.MAINNET_RPC_URL)
  const network = await provider.getNetwork()
  if (hre.network.name !== 'hardhat') {
    throw new Error("Pls only test against forked network")
  }
  await hre.network.provider.request({
    method: "hardhat_reset",
    params: [
      {
        forking: {
          jsonRpcUrl:
            process.env.MAINNET_RPC_URL,
          // block: 16684800
        },
      },
    ],
  });
  const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"

  const mainAddr = "0x4280E823ac98fD216acC122c487D69064F5F7c87"

  const FrictionlessZapperFactory = await hre.ethers.getContractFactory("FrictionlessZapper");
  const rToken = await hre.ethers.getContractAt("IRToken", "0xF618492E7cd4145214D4668D569CA3BcBCa69074")
  const frictionlessZapper = await FrictionlessZapperFactory.deploy(
    mainAddr,
    "0xF618492E7cd4145214D4668D569CA3BcBCa69074",
    weth,
    {
      tokens: [
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        "0x8E870D67F660D95d5be530380D0eC0bd388289E1",
        "0x0000000000085d4780B73119b644AE5ecd22b376",
        "0x4Fabb145d64652a948d72533023f6E7A623C7C53",
        "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
        "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "0xC581b735A1688071A1746c968e0798D642EDE491"
      ],
      saTokens: [
        "0x8f471832C6d35F2a51606a60f482BCfae055D986",
        "0x83DAc0593BD7dE8fa7137D65Fb898B7b7FF6ede6",
        "0xF6147b4B44aE6240F7955803B2fD5E15c77bD7ea",
        "0x21fe646D1Ed0733336F2D4d9b2FE67790a6099D9"
      ],
      cTokens: [
        { cToken: "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643", underlying: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
        { cToken: "0x39AA39c021dfbaE8faC545936693aC917d5E7563", underlying: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
        { cToken: "0xf650C3d88D12dB855b8bf7D11Be6C55A4e07dCC9", underlying: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
        { cToken: "0xccf4429db6322d5c611ee964527d42e5d685dd6a", underlying: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
        { cToken: "0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5", underlying: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" }
      ]
    }
  );

  const inputTokenAddr = "0xdac17f958d2ee523a2206206994597c13d831ec7"
  const user = "0xF28E1B06E00e8774C612e31aB3Ac35d5a720085f"

  const userWantsRTokenSum = parseEther("20");
  const basketAmounts = await frictionlessZapper.callStatic.getPrecursorTokens(
    userWantsRTokenSum
  );

  // Hack to work around (old)cbtc for now
  console.log("(hack) funding FrictionlessZapper")
  const cbtcOldWhale = "0x49D5df7773936deCc72e0E305F28190Bc1A13E08"
  await impersonateAccount(cbtcOldWhale)
  const wbtcWhaleSigner = await hre.ethers.getSigner(cbtcOldWhale)

  const ERC20 = await hre.ethers.getContractFactory("ERC20Mock")
  await ERC20.attach("0xc11b1268c1a384e55c48c2391d8d480264a3a7f4").connect(wbtcWhaleSigner).transfer(
    frictionlessZapper.address,
    parseUnits("0.03260663", 8),
    {
      gasLimit: 150000
    }
  )

  const Zapper = await hre.ethers.getContractFactory("Zapper");
  const zapperInst = await Zapper.deploy(
    weth
  );


  const inputToken = ERC20.attach(inputTokenAddr)
  const inputTokenSymbol = await inputToken.symbol()
  const inputTokenDecimals = await inputToken.decimals()
  const inputBal = await inputToken.balanceOf(user);
  console.log("Input token balance", inputBal, inputTokenSymbol)

  console.log(
    `User wants ${formatEther(userWantsRTokenSum)} RTokens`
  )

  console.log(
    `User 'hodls' ${inputTokenSymbol} tokens`
  )

  console.log(basketAmounts)
  const reverseQuoteInput = basketAmounts.map(({ token, quantity }) => ({ basketToken: token, amount: quantity }));
  for (const reserveQuote of reverseQuoteInput) {
    const symbol = await ERC20.attach(reserveQuote.basketToken).symbol()
    const decimals = await ERC20.attach(reserveQuote.basketToken).decimals()
    console.log(`We will be swapping for ${formatUnits(reserveQuote.amount, decimals)} ${symbol}`)
  }

  console.log("Calculating approximate input quantity")
  const reverseQuoteSum = await basketTokensToAmountIn(inputToken.address, reverseQuoteInput)

  // Add 2% slippage
  const slippageAmount = reverseQuoteSum.totalAmountIn.div(40);
  const amountIn = reverseQuoteSum.totalAmountIn.add(slippageAmount);

  console.log(
    `User would have to pay approx ~${formatUnits(amountIn, inputTokenDecimals)} ${inputTokenSymbol} (slippage 1% ${formatUnits(slippageAmount, inputTokenDecimals)})`
  )


  console.log("Generating trades")
  const trades = await Promise.all(
    reverseQuoteSum.quote.filter(t => !bannedTokens.has(t.basketToken.address.toLowerCase())).map(async i => {
      const amountIn = i.inputTokenAmount.add(i.inputTokenAmount.div(50));

      const call = (await oneInchSwap(
        user,
        i.inputToken.address,
        i.basketToken.address,
        amountIn,
        0.5,
        frictionlessZapper.address
      ))
      return {
        aggregatorCall: call.tx.data.toLowerCase(),
        inputTokenAmount: amountIn,
        basketTokenAmount: ethers.BigNumber.from(call.toTokenAmount),
        inputToken: i.inputToken,
        basketToken: i.basketToken
      }
    })
  );

  // console.log("Trades generated:")
  for (const trade of trades) {
    console.log(
      `${formatUnits(trade.inputTokenAmount, trade.inputToken.decimals)} ${trade.inputToken.symbol} => ${formatUnits(trade.basketTokenAmount, trade.basketToken.decimals)} ${trade.basketToken.symbol}`
    )
    console.log(
      "payload: " + trade.aggregatorCall
    )
  }


  // console.log(`Balance before: ${formatEther(await rToken.balanceOf(user))} RSV`)

  await impersonateAccount(user)
  const signer = await hre.ethers.getSigner(user)
  console.log("Approving tokens for use with Zapper")
  await inputToken.connect(signer).approve(zapperInst.address, ethers.constants.MaxUint256, {
    gasLimit: 200000
  })
  console.log("Zapping")
  console.log("block: ", await hre.ethers.provider.getBlockNumber())
  const payload = {
    amountIn: amountIn,
    tokenIn: inputToken.address,
    tokenOut: rToken.address,
    postTradeActionsPayload: Buffer.alloc(0),
    postTradeActionsAddress: frictionlessZapper.address,
    trades: trades.map(i => ({
      aggregatorCall: i.aggregatorCall
    })),
    amountOut: userWantsRTokenSum,
  }
  console.log("payload", zapperInst.interface.encodeFunctionData(
    "zapERC20",
    [payload]
  ))
  
  const tx = await zapperInst.connect(signer).zapERC20(payload, {
    gasLimit: 20000000
  })
  console.log(tx)

  console.log(`Balance after: ${formatEther(await rToken.balanceOf(user))} RSV`)
  console.log(`Input token balance ${formatUnits(await inputToken.balanceOf(user), inputTokenDecimals)} ${inputTokenSymbol}`)
  console.log("Gas used needed", (await tx.wait()).gasUsed.toString())

}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
