import { ethers } from 'ethers'
import { formatEther, parseUnits } from 'ethers/lib/utils'
import hre from 'hardhat'
import { impersonateAccount } from '@nomicfoundation/hardhat-network-helpers'
import { searchForEUSDZap } from './zap-to-eUSD'
import { getChainId } from '#/common/blockchain-utils'
import { networkConfig } from '#/common/configuration'
import { getDeploymentFile, getDeploymentFilename, IDeployments } from '../deployment/common'

async function main() {
  const chainId = await getChainId(hre)

  if (!networkConfig[chainId]) {
    throw new Error(`Missing network configuration for ${hre.network.name}`)
  }
  const config = networkConfig[chainId]
  const weth = config.tokens.WETH!
  const Zapper = await hre.ethers.getContractFactory('Zapper')
  const ZapperExecutorFactory = await hre.ethers.getContractFactory('ZapperExecutor')
  const deploymentFilename = getDeploymentFilename(chainId)
  const deployments = <IDeployments>getDeploymentFile(deploymentFilename)

  const permit2Address = config.PERMIT2 ?? ethers.constants.AddressZero
  console.log('Deploying zapper executor')
  const executorInst = await ZapperExecutorFactory.deploy()
  console.log('Zapper executor deployed to', executorInst.address)
  deployments.zapperExecutor = executorInst.address

  console.log('Deploying zapper')
  const zapperInst = await Zapper.deploy(
    ethers.constants.AddressZero,
    weth,
    permit2Address,
    executorInst.address,
    {
      nonce: executorInst.deployTransaction.nonce + 1
    }
  )
  console.log('Zapper deployed to', zapperInst.address)
  deployments.zapper = zapperInst.address
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
