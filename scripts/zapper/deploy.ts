import { ethers } from 'ethers'
import hre from 'hardhat'
import { getChainId } from '#/common/blockchain-utils'
import { networkConfig } from '#/common/configuration'
import fs from 'fs'
async function main() {
  const chainId = await getChainId(hre)

  if (!networkConfig[chainId]) {
    throw new Error(`Missing network configuration for ${hre.network.name}`)
  }
  const config = networkConfig[chainId]
  const weth = config.tokens.WETH!
  const Zapper = await hre.ethers.getContractFactory('Zapper')
  const ZapperExecutorFactory = await hre.ethers.getContractFactory('ZapperExecutor')
  const deploymentFilename = './scripts/addresses/1-zapper-1.0.0.json'

  const permit2Address = config.PERMIT2 ?? ethers.constants.AddressZero
  console.log('Deploying zapper executor')
  const executorInst = await ZapperExecutorFactory.deploy()
  await executorInst.deployed()
  console.log('Zapper executor deployed to', executorInst.address)

  console.log('Deploying zapper')
  const zapperInst = await Zapper.deploy(weth, permit2Address, executorInst.address)

  console.log('Zapper deployed to', zapperInst.address)
  await zapperInst.deployed()
  fs.writeFileSync(
    deploymentFilename,
    JSON.stringify(
      {
        zapperExecutor: executorInst.address,
        zapper: zapperInst.address
      },
      null,
      2
    )
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
