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
  if (hre.network.name !== 'hardhat') {
    throw new Error("Pls only test against forked network")
  }
  const ERC20 = await hre.ethers.getContractFactory("ERC20Mock")

  console.log(process.env.MAINNET_RPC_URL)
  
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

  const mainAddr = "0x7697aE4dEf3C3Cd52493Ba3a6F57fc6d8c59108a"
  
  const FrictionlessZapperFactory = await hre.ethers.getContractFactory("FrictionlessZapper");
  const rToken = await hre.ethers.getContractAt("IRToken", "0xA0d69E286B938e21CBf7E51D71F6A4c8918f482F")
  const frictionlessZapper = await FrictionlessZapperFactory.deploy(
    mainAddr,
    rToken.address,
    weth,
    {
      tokens: [],
      saTokens: [
        "0x8f471832C6d35F2a51606a60f482BCfae055D986",
        "0x21fe646D1Ed0733336F2D4d9b2FE67790a6099D9",
      ],
      cTokens: [
        { cToken: "0x39AA39c021dfbaE8faC545936693aC917d5E7563", underlying: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
        { cToken: "0xf650C3d88D12dB855b8bf7D11Be6C55A4e07dCC9", underlying: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
      ]
    }
  );

  const inputTokenAddr = "0xdac17f958d2ee523a2206206994597c13d831ec7"
  const user = "0xf28e1b06e00e8774c612e31ab3ac35d5a720085f"

  const userWantsRTokenSum = parseEther("20");
  const basketAmounts = await frictionlessZapper.callStatic.getPrecursorTokens(
    userWantsRTokenSum
  );


  const Zapper = await hre.ethers.getContractFactory("Zapper");
  const permit2Address = "0x000000000022d473030f116ddee9f6b43ac78ba3";
  const zapperInst = await Zapper.deploy(
    ethers.constants.AddressZero,
    weth,
    permit2Address
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
      target: "0x1111111254eeb25477b68fb85ed929f73a960582",
      input: i.aggregatorCall
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
