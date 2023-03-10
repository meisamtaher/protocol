import { providers } from "ethers";
import { IBasketHandler } from "@typechain/IBasketHandler";
import { ICToken__factory, IERC20__factory, IRToken__factory, IStaticATokenLM__factory, IStaticAToken__factory, ZapperExecutor__factory } from "@typechain/index";
import { findBestTrade } from "./1inch-utils";
import { ZapperContractCall } from "./types";

const eUSDAddresses = {
  rTokenAddress: "0xa0d69e286b938e21cbf7e51d71f6a4c8918f482f",
  usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  usdt: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  cusdc: "0x39aa39c021dfbae8fac545936693ac917d5e7563",
  cusdt: "0xf650c3d88d12db855b8bf7d11be6c55a4e07dcc9",
  sausdc: "0x8f471832c6d35f2a51606a60f482bcfae055d986",
  sausdt: "0x21fe646d1ed0733336f2d4d9b2fe67790a6099d9"
};
const ray = 10n ** 27n;
const halfRay = ray / 2n;
const rayMul = (a: bigint, b: bigint) => {
  return (halfRay + a * b) / ray;
};
const createCall = (to: string, payload: string, comment = ""): ZapperContractCall => ({ comment, to, payload });
interface EUSDZapParams {
  user: string;
  executorAddress: string;
  provider: providers.Provider;
  inputToken: string;
  outputTokenAmount: bigint;
  basketHandler: IBasketHandler;
}
export const searchForEUSDZap = async (
  { user, executorAddress, provider, inputToken, outputTokenAmount: eUSDAmount, basketHandler }: EUSDZapParams
): Promise<{
  inputTokenAmount: bigint;
  calls: ZapperContractCall[];
}> => {
  const actions: ZapperContractCall[] = [];

  const isCToken = eUSDAddresses.cusdc == inputToken || eUSDAddresses.cusdt == inputToken;
  const isSaToken = eUSDAddresses.sausdc == inputToken || eUSDAddresses.sausdt == inputToken;
  if (isSaToken || isCToken) {
    throw "NOT HANDLED";
  }
  const isPrecursor = eUSDAddresses.usdc == inputToken || eUSDAddresses.usdt == inputToken;
  const quote = await basketHandler.callStatic.quote(eUSDAmount, 0);
  const quantitiesMap: Record<string, bigint> = {};
  for (let index = 0; index < quote.erc20s.length; index++) {
    const erc20 = quote.erc20s[index];
    const quantity = quote.quantities[index];
    quantitiesMap[erc20.toLowerCase()] = quantity.toBigInt();
  }

  let usdcNeeded = 0n;
  const rateCUSDC = (await ICToken__factory.connect(eUSDAddresses.cusdc, provider).callStatic.exchangeRateCurrent()).toBigInt();
  const rateSAUSDC = (await IStaticAToken__factory.connect(eUSDAddresses.sausdc, provider).callStatic.rate()).toBigInt();
  const cusdcMintInput = quantitiesMap[eUSDAddresses.cusdc] * rateCUSDC / 10n ** 18n;
  const sauscMintInput = rayMul(
    quantitiesMap[eUSDAddresses.sausdc],
    rateSAUSDC
  );
  usdcNeeded += cusdcMintInput;
  usdcNeeded += sauscMintInput;


  let usdtNeeded = 0n;
  const rateCUSDT = (await ICToken__factory.connect(eUSDAddresses.cusdt, provider).callStatic.exchangeRateCurrent()).toBigInt();
  const rateSAUSDT = (await IStaticAToken__factory.connect(eUSDAddresses.sausdt, provider).callStatic.rate()).toBigInt();
  const cusdtMintInput = quantitiesMap[eUSDAddresses.cusdt] * rateCUSDT / 10n ** 18n;
  const saustMintInput = rayMul(
    quantitiesMap[eUSDAddresses.sausdt],
    rateSAUSDT
  );
  usdtNeeded += cusdtMintInput;
  usdtNeeded += saustMintInput;

  // swaps
  let tradeActions: ZapperContractCall[] = [];
  let inputTokenAmount = 0n;
  if (!isPrecursor) {
    const startTrades = await findBestTrade(user, executorAddress, inputToken, [{
      token: eUSDAddresses.usdc,
      quantity: usdcNeeded
    }, {
      token: eUSDAddresses.usdt,
      quantity: usdtNeeded
    }]);
    inputTokenAmount = startTrades.totalInputTokenAmount;
    tradeActions.push(...startTrades.trades);
  } else if (isPrecursor) {
    const trade = inputToken == eUSDAddresses.usdt ? {
      token: eUSDAddresses.usdc,
      quantity: usdcNeeded
    } : {
      token: eUSDAddresses.usdt,
      quantity: usdtNeeded
    };
    const startTrades = await findBestTrade(user, executorAddress, inputToken, [trade]);
    inputTokenAmount = startTrades.totalInputTokenAmount;
    tradeActions.push(...startTrades.trades);
  }
  const initialTradesTos = [...new Set(tradeActions.map(i => i.to))];

  // approvals
  const tokens: string[] = [];
  const spenders: string[] = [];

  const addApproval = async (token: string, spender: string) => {
    const tokenInstance = IERC20__factory.connect(token, provider);
    const allowance = await tokenInstance.allowance(executorAddress, spender);
    if (!allowance.isZero()) {
      return;
    }

    tokens.push(token);
    spenders.push(spender);
  };
  const eUSDAddress = eUSDAddresses.rTokenAddress;
  const approvalTasks = [
    ...initialTradesTos.map(tradeContract => addApproval(inputToken, tradeContract)),
    addApproval(eUSDAddresses.usdc, eUSDAddresses.cusdc),
    addApproval(eUSDAddresses.usdc, eUSDAddresses.sausdc),
    addApproval(eUSDAddresses.usdt, eUSDAddresses.cusdt),
    addApproval(eUSDAddresses.usdt, eUSDAddresses.sausdt),
    addApproval(eUSDAddresses.cusdc, eUSDAddress),
    addApproval(eUSDAddresses.cusdt, eUSDAddress),
    addApproval(eUSDAddresses.sausdc, eUSDAddress),
    addApproval(eUSDAddresses.sausdt, eUSDAddress)
  ];

  await Promise.all(approvalTasks);

  actions.push(
    createCall(
      executorAddress,
      ZapperExecutor__factory.createInterface().encodeFunctionData(
        "setupApprovals",
        [
          tokens,
          spenders
        ]
      ),
      "initial approvals"
    )
  );
  actions.push(...tradeActions);

  // mint basket tokens
  const icTokenInterface = ICToken__factory.createInterface();
  actions.push(
    createCall(
      eUSDAddresses.cusdc,
      icTokenInterface.encodeFunctionData("mint", [cusdcMintInput]),
      "mint cusdc"
    )

  );
  actions.push(
    createCall(
      eUSDAddresses.cusdt,
      icTokenInterface.encodeFunctionData("mint", [cusdtMintInput]),
      "mint cusdt"
    )
  );

  const iSAInterface = IStaticATokenLM__factory.createInterface();
  actions.push(
    createCall(
      eUSDAddresses.sausdc,
      iSAInterface.encodeFunctionData("deposit", [executorAddress, sauscMintInput, 0, true]),
      "mint sausdc"
    )
  );
  actions.push(
    createCall(
      eUSDAddresses.sausdt,
      iSAInterface.encodeFunctionData("deposit", [executorAddress, saustMintInput, 0, true]),
      "mint sausdt"
    )
  );

  // Issue rTokens
  actions.push(
    createCall(
      eUSDAddress,
      IRToken__factory.createInterface().encodeFunctionData("issueTo", [
        user,
        eUSDAmount
      ]),
      "issue RTokens"
    )
  );

  // cleanup
  actions.push(
    createCall(
      executorAddress,
      ZapperExecutor__factory.createInterface().encodeFunctionData(
        "drainERC20s",
        [
          [eUSDAddresses.usdc, eUSDAddresses.usdc, eUSDAddresses.cusdc, eUSDAddresses.cusdt, eUSDAddresses.cusdt, eUSDAddresses.sausdt],
          user
        ]
      ),
      "refund residual tokens"
    )
  );

  return {
    inputTokenAmount,
    calls: actions
  };
};
