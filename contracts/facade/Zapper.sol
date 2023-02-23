// SPDX-License-Identifier: BlueOak-1.0.0
pragma solidity 0.8.17;
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IWrappedNative } from "../interfaces/IWrappedNative.sol";

import { ZapERC20Params, IRTokenZapper } from "../interfaces/IRTokenZapper.sol";

contract Zapper is ReentrancyGuard {
    address internal immutable wrappedNative;
    address internal constant _1INCH = 0x1111111254EEB25477B68fb85Ed929f73A960582;

    constructor(address weth) {
        wrappedNative = weth;
    }

    function pullFunds(IERC20 token, uint256 amount) internal {
        SafeERC20.safeTransferFrom(token, msg.sender, address(this), amount);
    }

    function setupApprovalFor(IERC20 token, address spender) internal {
        uint256 allowance = token.allowance(address(this), spender);
        if (allowance != 0) {
            return;
        }
        SafeERC20.safeApprove(IERC20(token), spender, type(uint256).max);
    }

    function zapERC20_(ZapERC20Params calldata params) internal {
        // STEP 1: Pull cursor token
        uint256 initialBalance = params.tokenOut.balanceOf(msg.sender);
        pullFunds(params.tokenIn, params.amountIn);
        setupApprovalFor(params.tokenIn, _1INCH);

        // STEP 2: Purchase precursor tokens
        uint256 len = params.trades.length;
        for (uint256 i = 0; i < len; i++) {
            Address.functionCall(_1INCH, params.trades[i].aggregatorCall);
        }

        {
            // The input token may actually be part of the *precursor* token set.
            // IRTokenZapper refund the input token back to the sender if it is not used.
            uint256 inputTokenBalance = params.tokenIn.balanceOf(address(this));
            SafeERC20.safeTransfer(
                params.tokenIn,
                address(params.postTradeActionsAddress),
                inputTokenBalance
            );
        }

        // STEP 3: Post trade actions (Wrapping tokens etc)
        IRTokenZapper(params.postTradeActionsAddress).convertPrecursorTokensToRToken(
            msg.sender,
            params
        );

        uint256 difference = params.tokenOut.balanceOf(msg.sender) - initialBalance;
        // STEP 4: Issue rtokens 'amountOut' will make sure dynamic subcalls
        require(difference >= params.amountOut, "Insuficient RTokens minted");
    }

    receive() external payable {
        require(msg.sender == wrappedNative, "INVALID_CALLER");
    }

    function zapERC20(ZapERC20Params calldata params) external nonReentrant {
        require(params.amountIn != 0, "INVALID_INPUT_AMOUNT");
        require(params.amountOut != 0, "INVALIT_OUTPUT_AMOUNT");
        zapERC20_(params);
    }

    function zapETH(ZapERC20Params calldata params) external payable nonReentrant {
        require(address(params.tokenIn) == address(wrappedNative), "INVALID_INPUT_TOKEN");
        require(params.amountIn == msg.value, "INVALID_INPUT_AMOUNT");
        require(msg.value != 0, "INVALID_INPUT_AMOUNT");
        require(params.amountOut != 0, "INVALIT_OUTPUT_AMOUNT");
        IWrappedNative(wrappedNative).deposit{ value: msg.value }();
        zapERC20_(params);
    }
}
