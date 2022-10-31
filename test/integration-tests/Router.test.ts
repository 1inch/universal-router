import { Router, ERC721, ERC20, MockLooksRareRewardsDistributor } from '../../typechain'
import { BigNumber, BigNumberish } from 'ethers'
import { Pair } from '@uniswap/v2-sdk'
import { expect } from './shared/expect'
import { abi as TOKEN_ABI } from '../../artifacts/@openzeppelin/contracts/token/ERC20/IERC20.sol/IERC20.json'
import { abi as ERC721_ABI } from '../../artifacts/solmate/src/tokens/ERC721.sol/ERC721.json'
import NFTX_ZAP_ABI from './shared/abis/NFTXZap.json'
import deployRouter from './shared/deployRouter'
import {
  ALICE_ADDRESS,
  COVEN_ADDRESS,
  DEADLINE,
  OPENSEA_CONDUIT_KEY,
  NFTX_COVEN_VAULT,
  NFTX_COVEN_VAULT_ID,
  ROUTER_REWARDS_DISTRIBUTOR,
} from './shared/constants'
import {
  seaportOrders,
  seaportInterface,
  getOrderParams,
  getAdvancedOrderParams,
  AdvancedOrder,
  Order,
  defaultAvailableAdvancedOrders,
} from './shared/protocolHelpers/seaport'
import { resetFork, WETH, DAI } from './shared/mainnetForkHelpers'
import { CommandType, RoutePlanner } from './shared/planner'
import { makePair } from './shared/swapRouter02Helpers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { expandTo18DecimalsBN } from './shared/helpers'
import hre from 'hardhat'

const { ethers } = hre
const nftxZapInterface = new ethers.utils.Interface(NFTX_ZAP_ABI)

describe('Router', () => {
  let alice: SignerWithAddress
  let router: Router
  let daiContract: ERC20
  let mockLooksRareToken: ERC20
  let mockLooksRareRewardsDistributor: MockLooksRareRewardsDistributor
  let pair_DAI_WETH: Pair

  beforeEach(async () => {
    await resetFork()
    alice = await ethers.getSigner(ALICE_ADDRESS)
    await hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [ALICE_ADDRESS],
    })

    // mock rewards contracts
    const tokenFactory = await ethers.getContractFactory('MintableERC20')
    const mockDistributorFactory = await ethers.getContractFactory('MockLooksRareRewardsDistributor')
    mockLooksRareToken = (await tokenFactory.connect(alice).deploy(expandTo18DecimalsBN(5))) as ERC20
    mockLooksRareRewardsDistributor = (await mockDistributorFactory.deploy(
      ROUTER_REWARDS_DISTRIBUTOR,
      mockLooksRareToken.address
    )) as MockLooksRareRewardsDistributor

    daiContract = new ethers.Contract(DAI.address, TOKEN_ABI, alice) as ERC20
    pair_DAI_WETH = await makePair(alice, DAI, WETH)
    router = (await deployRouter(mockLooksRareRewardsDistributor.address, mockLooksRareToken.address)).connect(
      alice
    ) as Router
  })

  describe('#execute', () => {
    let planner: RoutePlanner

    beforeEach(async () => {
      planner = new RoutePlanner()
      await daiContract.transfer(router.address, expandTo18DecimalsBN(5000))
    })

    it('reverts if block.timestamp exceeds the deadline', async () => {
      planner.addCommand(CommandType.TRANSFER, [
        DAI.address,
        pair_DAI_WETH.liquidityToken.address,
        expandTo18DecimalsBN(1),
      ])
      planner.addCommand(CommandType.V2_SWAP_EXACT_IN, [1, [DAI.address, WETH.address], alice.address])
      const invalidDeadline = 10

      const { commands, inputs } = planner

      await expect(router['execute(bytes,bytes[],uint256)'](commands, inputs, invalidDeadline)).to.be.revertedWith(
        'TransactionDeadlinePassed()'
      )
    })

    it('reverts for an invalid command at index 0', async () => {
      const commands = '0xff'
      const inputs: string[] = ['0x12341234']

      await expect(router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE)).to.be.revertedWith(
        'InvalidCommandType(31)'
      )
    })

    it('reverts for an invalid command at index 1', async () => {
      const invalidCommand = 'ff'
      planner.addCommand(CommandType.TRANSFER, [
        DAI.address,
        pair_DAI_WETH.liquidityToken.address,
        expandTo18DecimalsBN(1),
      ])
      let commands = planner.commands
      let inputs = planner.inputs

      commands = commands.concat(invalidCommand)
      inputs.push('0x21341234')

      await expect(router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE)).to.be.revertedWith(
        'InvalidCommandType(31)'
      )
    })

    describe('partial fills', async () => {
      let covenContract: ERC721
      let nftxValue: BigNumber
      let numCovens: number
      let value: BigNumber
      let invalidSeaportCalldata: string
      let seaportValue: BigNumber

      beforeEach(async () => {
        covenContract = new ethers.Contract(COVEN_ADDRESS, ERC721_ABI, alice) as ERC721
        // add valid nftx order to planner
        nftxValue = expandTo18DecimalsBN(4)
        numCovens = 2
        const calldata = nftxZapInterface.encodeFunctionData('buyAndRedeem', [
          NFTX_COVEN_VAULT_ID,
          numCovens,
          [],
          [WETH.address, NFTX_COVEN_VAULT],
          alice.address,
        ])
        planner.addCommand(CommandType.NFTX, [nftxValue, calldata])

        let invalidSeaportOrder = JSON.parse(JSON.stringify(seaportOrders[0]))
        invalidSeaportOrder.protocol_data.signature = '0xdeadbeef'
        let seaportOrder: Order
        ;({ order: seaportOrder, value: seaportValue } = getOrderParams(invalidSeaportOrder))
        invalidSeaportCalldata = seaportInterface.encodeFunctionData('fulfillOrder', [
          seaportOrder,
          OPENSEA_CONDUIT_KEY,
        ])

        value = seaportValue.add(nftxValue)
      })

      it('reverts if no commands are allowed to revert', async () => {
        planner.addCommand(CommandType.SEAPORT, [seaportValue, invalidSeaportCalldata])

        const { commands, inputs } = planner

        await expect(
          router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE, { value })
        ).to.be.revertedWith('ExecutionFailed(1, "0x8baa579f")')
      })

      it('does not revert if invalid seaport transaction allowed to fail', async () => {
        planner.addCommand(CommandType.SEAPORT, [seaportValue, invalidSeaportCalldata], true)
        const { commands, inputs } = planner

        const covenBalanceBefore = await covenContract.balanceOf(alice.address)
        await router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE, { value })
        const covenBalanceAfter = await covenContract.balanceOf(alice.address)
        expect(covenBalanceAfter.sub(covenBalanceBefore)).to.eq(numCovens)
      })
    })

    describe('ERC20 --> NFT', () => {
      let advancedOrder: AdvancedOrder
      let value: BigNumber
      let covenContract: ERC721

      beforeEach(async () => {
        covenContract = new ethers.Contract(COVEN_ADDRESS, ERC721_ABI, alice) as ERC721
        ;({ advancedOrder, value } = getAdvancedOrderParams(seaportOrders[0]))
      })

      it('completes a trade for ERC20 --> ETH --> Seaport NFT', async () => {
        const maxAmountIn = expandTo18DecimalsBN(100_000)
        await daiContract.transfer(router.address, maxAmountIn)
        const calldata = seaportInterface.encodeFunctionData('fulfillAdvancedOrder', [
          advancedOrder,
          [],
          OPENSEA_CONDUIT_KEY,
          alice.address,
        ])

        planner.addCommand(CommandType.V2_SWAP_EXACT_OUT, [
          value,
          maxAmountIn,
          [DAI.address, WETH.address],
          router.address,
        ])
        planner.addCommand(CommandType.UNWRAP_WETH, [router.address, value])
        planner.addCommand(CommandType.SEAPORT, [value.toString(), calldata])
        const { commands, inputs } = planner
        const covenBalanceBefore = await covenContract.balanceOf(alice.address)
        await router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE)
        const covenBalanceAfter = await covenContract.balanceOf(alice.address)
        expect(covenBalanceAfter.sub(covenBalanceBefore)).to.eq(1)
      })

      it('completes a trade for ERC20 --> ETH --> NFTs, invalid Seaport order', async () => {
        const maxAmountIn = expandTo18DecimalsBN(100_000)
        // in this case there is leftover dai in the router, and the unspent eth gets sent to alice
        await daiContract.transfer(router.address, maxAmountIn)

        let invalidSeaportOrder = JSON.parse(JSON.stringify(seaportOrders[0]))
        const { order: seaportOrder, value: seaportValue } = getOrderParams(invalidSeaportOrder)
        let nftxValue: BigNumber = expandTo18DecimalsBN(4)
        let totalValue = seaportValue.add(nftxValue)

        // invalidate Seaport order
        invalidSeaportOrder.protocol_data.signature = '0xdeadbeef'
        const calldataOpensea = seaportInterface.encodeFunctionData('fulfillOrder', [seaportOrder, OPENSEA_CONDUIT_KEY])

        // valid NFTX order
        let numCovensNFTX = 2
        const calldataNFTX = nftxZapInterface.encodeFunctionData('buyAndRedeem', [
          NFTX_COVEN_VAULT_ID,
          numCovensNFTX,
          [],
          [WETH.address, NFTX_COVEN_VAULT],
          alice.address,
        ])

        planner.addCommand(CommandType.V2_SWAP_EXACT_OUT, [
          totalValue,
          maxAmountIn,
          [DAI.address, WETH.address],
          router.address,
        ])
        planner.addCommand(CommandType.UNWRAP_WETH, [router.address, totalValue])
        planner.addCommand(CommandType.SEAPORT, [seaportValue.toString(), calldataOpensea], true)

        planner.addCommand(CommandType.NFTX, [nftxValue, calldataNFTX])

        const { commands, inputs } = planner

        const routerEthBalanceBefore = await ethers.provider.getBalance(router.address)
        const covenBalanceBefore = await covenContract.balanceOf(alice.address)

        await router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE)

        const covenBalanceAfter = await covenContract.balanceOf(alice.address)
        const routerEthBalanceAfter = await ethers.provider.getBalance(router.address)

        expect(covenBalanceAfter.sub(covenBalanceBefore)).to.eq(numCovensNFTX)
        expect(routerEthBalanceAfter).to.eq(routerEthBalanceBefore)
      })

      it('completes a trade for ERC20 --> ETH --> NFTs with Seaport, fulfillAvailableAdvancedOrders fill', async () => {
        const maxAmountIn = expandTo18DecimalsBN(100_000)
        // in this case there is leftover dai in the router and all eth gets spent on the nfts
        await daiContract.transfer(router.address, maxAmountIn)

        const { advancedOrder: advancedOrder0, value: value1 } = getAdvancedOrderParams(seaportOrders[0])
        const { advancedOrder: advancedOrder1, value: value2 } = getAdvancedOrderParams(seaportOrders[1])
        const params0 = advancedOrder0.parameters
        const params1 = advancedOrder1.parameters
        const totalValue = value1.add(value2)

        const calldata = defaultAvailableAdvancedOrders(alice.address, advancedOrder0, advancedOrder1)

        planner.addCommand(CommandType.V2_SWAP_EXACT_OUT, [
          totalValue,
          maxAmountIn,
          [DAI.address, WETH.address],
          router.address,
        ])
        planner.addCommand(CommandType.UNWRAP_WETH, [router.address, totalValue])

        planner.addCommand(CommandType.SEAPORT, [totalValue, calldata])
        const { commands, inputs } = planner

        const nftId0 = params0.offer[0].identifierOrCriteria
        const nftId1 = params1.offer[0].identifierOrCriteria

        const owner0Before = await covenContract.ownerOf(nftId0)
        const owner1Before = await covenContract.ownerOf(nftId1)
        const ethBefore = await ethers.provider.getBalance(alice.address)
        const routerEthBalanceBefore = await ethers.provider.getBalance(router.address)

        const receipt = await (await router['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE)).wait()

        const owner0After = await covenContract.ownerOf(nftId0)
        const owner1After = await covenContract.ownerOf(nftId1)
        const ethAfter = await ethers.provider.getBalance(alice.address)
        const routerEthBalanceAfter = await ethers.provider.getBalance(router.address)
        const gasSpent = receipt.gasUsed.mul(receipt.effectiveGasPrice)
        const ethDelta = ethBefore.sub(ethAfter)

        expect(owner0Before.toLowerCase()).to.eq(params0.offerer)
        expect(owner1Before.toLowerCase()).to.eq(params1.offerer)
        expect(owner0After).to.eq(alice.address)
        expect(owner1After).to.eq(alice.address)
        expect(ethDelta).to.eq(gasSpent) // eth spent only on gas bc trade came from DAI
        expect(routerEthBalanceBefore).to.eq(routerEthBalanceAfter) // ensure no eth is left in the router
      })
    })
  })

  describe('#collectRewards', () => {
    let amountRewards: BigNumberish
    beforeEach(async () => {
      amountRewards = expandTo18DecimalsBN(0.5)
      mockLooksRareToken.connect(alice).transfer(mockLooksRareRewardsDistributor.address, amountRewards)
    })

    it('transfers owed rewards into the distributor contract', async () => {
      const balanceBefore = await mockLooksRareToken.balanceOf(ROUTER_REWARDS_DISTRIBUTOR)
      await router.collectRewards('0x00')
      const balanceAfter = await mockLooksRareToken.balanceOf(ROUTER_REWARDS_DISTRIBUTOR)
      expect(balanceAfter.sub(balanceBefore)).to.eq(amountRewards)
    })
  })
})
