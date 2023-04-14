// SPDX-License-Identifier: BlueOak-1.0.0
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../interfaces/IBroker.sol";
import "../../interfaces/IMain.sol";
import "../../interfaces/ITrade.sol";
import "../../libraries/Fixed.sol";
import "./Rewardable.sol";

/// Abstract trading mixin for all Traders, to be paired with TradingLib
abstract contract TradingP0 is RewardableP0, ITrading {
    using FixLib for uint192;
    using SafeERC20 for IERC20Metadata;

    uint192 public constant MAX_TRADE_VOLUME = 1e29; // {UoA}
    uint192 public constant MAX_TRADE_SLIPPAGE = 1e18; // {%}
    uint192 public constant MAX_SWAP_PRICEPOINT = 1e18; // {1}

    // All trades
    mapping(IERC20 => ITrade) public trades;
    uint48 public tradesOpen;

    // === Governance params ===
    uint192 public maxTradeSlippage; // {%}

    uint192 public minTradeVolume; // {UoA}

    // 0% = the lowest price estimate: a discount to the user of oracleError on each side
    // 50% = use the midpoint of the lowest and highest price estimates
    // 100% = the highest price estimate: a premium for the protocol of oracleError on each side
    uint192 public swapPricepoint; // {1} the percentile price to use within a swap

    // untestable:
    //      `else` branch of `onlyInitializing` (ie. revert) is currently untestable.
    //      This function is only called inside other `init` functions, each of which is wrapped
    //      in an `initializer` modifier, which would fail first.
    // solhint-disable-next-line func-name-mixedcase
    function __Trading_init(
        uint192 maxTradeSlippage_,
        uint192 minTradeVolume_,
        uint192 swapPricepoint_
    ) internal onlyInitializing {
        setMaxTradeSlippage(maxTradeSlippage_);
        setMinTradeVolume(minTradeVolume_);
        setSwapPricepoint(swapPricepoint_);
    }

    /// Settle a single trade, expected to be used with multicall for efficient mass settlement
    /// @custom:interaction
    function settleTrade(IERC20 sell) public notPausedOrFrozen {
        ITrade trade = trades[sell];
        if (address(trade) == address(0)) return;
        require(trade.canSettle(), "cannot settle yet");

        delete trades[sell];
        tradesOpen--;
        (uint256 soldAmt, uint256 boughtAmt) = trade.settle();
        emit TradeSettled(trade, trade.sell(), trade.buy(), soldAmt, boughtAmt);
    }

    /// Try to initiate a trade with a trading partner provided by the broker
    function openTrade(TradeRequest memory req) internal {
        IBroker broker = main.broker();
        assert(address(trades[req.sell.erc20()]) == address(0));
        require(!broker.disabled(), "broker disabled");

        req.sell.erc20().safeApprove(address(broker), 0);
        req.sell.erc20().safeApprove(address(broker), req.sellAmount);

        ITrade trade = broker.openTrade(req);

        trades[req.sell.erc20()] = trade;
        tradesOpen++;
        emit TradeStarted(
            trade,
            req.sell.erc20(),
            req.buy.erc20(),
            req.sellAmount,
            req.minBuyAmount
        );
    }

    /// Performs an atomic swap with the caller for exactly the provided Swap amounts
    function executeSwap(Swap memory s) internal {
        assert(
            address(s.sell) != address(0) &&
                address(s.buy) != address(0) &&
                s.buyAmount != 0 &&
                s.sellAmount != 0
        );

        uint256 sellBal = s.sell.balanceOf(address(this));
        uint256 buyBal = s.buy.balanceOf(address(this));

        // Transfer tokens in
        IERC20Metadata(address(s.buy)).safeTransferFrom(_msgSender(), address(this), s.buyAmount);
        assert(s.buy.balanceOf(address(this)) - buyBal == s.buyAmount);

        // Transfer tokens out
        IERC20Metadata(address(s.sell)).safeTransfer(_msgSender(), s.sellAmount);
        assert(sellBal - s.sell.balanceOf(address(this)) == s.sellAmount);

        emit SwapCompleted(s.sell, s.buy, s.sellAmount, s.buyAmount);
    }

    // === Setters ===

    /// @custom:governance
    function setMaxTradeSlippage(uint192 val) public governance {
        require(val < MAX_TRADE_SLIPPAGE, "invalid maxTradeSlippage");
        emit MaxTradeSlippageSet(maxTradeSlippage, val);
        maxTradeSlippage = val;
    }

    /// @custom:governance
    function setMinTradeVolume(uint192 val) public governance {
        require(val <= MAX_TRADE_VOLUME, "invalid minTradeVolume");
        emit MinTradeVolumeSet(minTradeVolume, val);
        minTradeVolume = val;
    }

    /// @custom:governance
    function setSwapPricepoint(uint192 val) public governance {
        require(val <= MAX_SWAP_PRICEPOINT, "invalid swapPricepoint");
        emit SwapPricepointSet(swapPricepoint, val);
        swapPricepoint = val;
    }

    // === FixLib Helper ===

    /// Light wrapper around FixLib.mulDiv to support try-catch
    function mulDivCeil(
        uint192 x,
        uint192 y,
        uint192 z
    ) external pure returns (uint192) {
        return x.mulDiv(y, z, CEIL);
    }
}
