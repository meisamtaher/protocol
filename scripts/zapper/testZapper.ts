import { ethers } from "ethers";
import { formatEther, parseEther } from "ethers/lib/utils";
import hre from "hardhat";
import { impersonateAccount } from "@nomicfoundation/hardhat-network-helpers";
import { searchForEUSDZap } from "./zap-to-eUSD";

async function main() {
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

  const mainInst = await hre.ethers.getContractAt("IMain", mainAddr)
  const basketHandler = await hre.ethers.getContractAt("IBasketHandler", await mainInst.basketHandler())

  const rToken = await hre.ethers.getContractAt("IRToken", "0xA0d69E286B938e21CBf7E51D71F6A4c8918f482F")
  const rTokenSymbol = await rToken.symbol()

  const inputTokenAddr = "0xdac17f958d2ee523a2206206994597c13d831ec7"
  const user = "0xf28e1b06e00e8774c612e31ab3ac35d5a720085f"

  await impersonateAccount(user)
  const signer = await hre.ethers.getSigner(user)

  const userWantsRTokenSum = parseEther("20");
  const Zapper = await hre.ethers.getContractFactory("Zapper");
  const ZapperExecutorFactory = await hre.ethers.getContractFactory("ZapperExecutor")
  const permit2Address = "0x000000000022d473030f116ddee9f6b43ac78ba3";
  const executorInst = await ZapperExecutorFactory.deploy()
  const zapperInst = await Zapper.deploy(
    ethers.constants.AddressZero,
    weth,
    permit2Address,
    executorInst.address
  );
  const inputToken = ERC20.attach(inputTokenAddr)
  console.log("Approving", zapperInst.address, ethers.constants.MaxUint256.toString())
  await inputToken.connect(signer).approve(zapperInst.address, ethers.constants.MaxUint256, {
    gasLimit: 100000
  })
  console.log("Run")



  const inputTokenSymbol = await inputToken.symbol()
  const inputBal = await inputToken.balanceOf(user);
  console.log("Input token balance", inputBal, inputTokenSymbol)

  console.log(
    `User wants ${formatEther(userWantsRTokenSum)} ${rTokenSymbol}`
  )

  console.log(
    `User 'hodls' ${inputTokenSymbol} tokens`
  )

  const actions = await searchForEUSDZap({
    inputToken: inputTokenAddr,
    user: user,
    provider: hre.ethers.provider as any,
    executorAddress: executorInst.address,
    basketHandler: basketHandler,
    outputTokenAmount: userWantsRTokenSum.toBigInt()
  })

  const encodedCalls = actions.calls.map(i => ({ value: 0, to: i.to, data: i.payload }))
  console.log(encodedCalls)

  console.log("Setting up approvals up front to exclude them from gas calculations")
  await executorInst.execute([encodedCalls[0]])

  try {
    console.log("Executing")
    const tx = await zapperInst.connect(signer).zapERC20({
      tokenIn: inputToken.address,
      amountIn: inputBal,
      commands: encodedCalls.slice(1),
      amountOut: userWantsRTokenSum,
      tokenOut: rToken.address
    }, {
      gasLimit: 3000000
    })
    console.log((await tx.wait(1)).gasUsed.toBigInt())
  } catch (e) {
    console.log(e)
  }


}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
