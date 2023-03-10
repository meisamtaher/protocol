import { BigNumber, ethers } from "ethers";
import { formatUnits } from "ethers/lib/utils";
import fetch from "isomorphic-fetch";
import { ZapperContractCall } from "./types";

interface OnceInchToken {
  symbol: string;
  address: string;
  decimals: number;
}
interface QuoteResponse {
  inputTokenAmount: BigNumber;
  inputToken: OnceInchToken;
  basketToken: OnceInchToken;
}
const oneInchQuote = async (
  tokenIn: string,
  tokenOut: string,
  amountIn: ethers.BigNumber
): Promise<QuoteResponse> => {
  const resp = await fetch(
    `https://api.1inch.io/v5.0/1/quote?fromTokenAddress=${tokenIn}&toTokenAddress=${tokenOut}&amount=${amountIn.toString()}`
  );
  const out: {
    fromToken: OnceInchToken;
    toToken: OnceInchToken;
    toTokenAmount: string;
    fromTokenAmount: string;
    estimatedGas: number;
  } = await resp.json();
  if ((out as any).error) {
    console.log(out);
    console.log(tokenIn, tokenOut);
  }
  return {
    inputTokenAmount: ethers.BigNumber.from(out.toTokenAmount),
    basketToken: out.fromToken,
    inputToken: out.toToken,
  };
};
interface SwapResponse {
  toTokenAmount: string;
  tx: {
    data: string;
    to: string;
  };
}
const oneInchSwap = async (
  userAddr: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: ethers.BigNumber,
  slippage: number,
  dest: string
) => {

  const url = `https://api.1inch.io/v5.0/1/swap?destReceiver=${dest}&fromAddress=${userAddr}&fromTokenAddress=${tokenIn}&toTokenAddress=${tokenOut}&amount=${amountIn.toString()}&disableEstimate=true&slippage=${slippage}`;
  const resp = await fetch(
    url
  );
  const out = await resp.json();
  if (out.tx == null) {
    console.log(url);
    console.log(out);
  }
  return out as SwapResponse;
};
export const findBestTrade = async (
  user: string,
  zapperExecutor: string,
  inputToken: string,
  outputTokens: { token: string; quantity: bigint; }[]
): Promise<{
  totalInputTokenAmount: bigint;
  trades: ZapperContractCall[];
}> => {
  const quoteTasks = outputTokens.map(async ({ token, quantity }) => oneInchQuote(token, inputToken, ethers.BigNumber.from(quantity)));
  const quotes = await Promise.all(quoteTasks);

  let totalInputTokenAmount = 0n;

  const generateTradesTasks = quotes.map(async ({ inputToken, basketToken, inputTokenAmount }) => {
    // apply 1% of input slippage
    const amount = inputTokenAmount.add(inputTokenAmount.div(100));
    totalInputTokenAmount += amount.toBigInt();
    const call = (await oneInchSwap(
      user,
      inputToken.address,
      basketToken.address,
      amount,
      0.5,
      zapperExecutor
    ));

    return {
      to: call.tx.to,
      payload: call.tx.data,
      comment: `Trade ${formatUnits(amount, inputToken.decimals)} ${inputToken.symbol} => ${basketToken.symbol}`
    };
  });

  const trades = await Promise.all(generateTradesTasks);

  return {
    totalInputTokenAmount,
    trades
  };
};
