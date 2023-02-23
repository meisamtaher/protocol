// SPDX-License-Identifier: BlueOak-1.0.0
pragma solidity 0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IRToken } from "../interfaces/IRToken.sol";

struct AggregatorTrade {
    // Encoded 1inch aggregator call
    bytes aggregatorCall;
}

struct TokenQuantity {
    address token;
    uint256 quantity;
}

interface IRTokenZapper {
    // Returns a list if tokens + quantities needed for some amount of
    function getPrecursorTokens(uint192 quantity) external returns (TokenQuantity[] memory);

    function convertPrecursorTokensToRToken(address receiver, ZapERC20Params calldata params)
        external;
}

struct ZapERC20Params {
    // Token to zap
    IERC20 tokenIn;
    // Total amount to zap / pull from user
    uint256 amountIn;
    // Aggregator trades to do to convert user tokens
    AggregatorTrade[] trades;
    // Will contain the RToken specific functionality
    IRTokenZapper postTradeActionsAddress;
    // Optional encoded data for 'postTradeActionsAddress' contract
    bytes postTradeActionsPayload;
    // RTokens the user requested
    uint256 amountOut;
    // RToken to issue
    IRToken tokenOut;
}
