// SPDX-License-Identifier: BlueOak-1.0.0
pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/Multicall.sol";
import "../../interfaces/ITrade.sol";
import "../../interfaces/ITrading.sol";
import "../../libraries/Fixed.sol";
import "./Component.sol";
import "./RewardableLib.sol";

/// Abstract trading mixin for all Traders, to be paired with TradingLib
/// @dev See docs/security for discussion of Multicall safety
abstract contract TradingP1 is Multicall, ComponentP1, ReentrancyGuardUpgradeable, ITrading {
    using FixLib for uint192;
    using SafeERC20 for IERC20;

    uint192 public constant MAX_TRADE_VOLUME = 1e29; // {UoA}
    uint192 public constant MAX_TRADE_SLIPPAGE = 1e18; // {1}
    uint192 public constant MAX_SWAP_PRICEPOINT = 1e18; // {1}

    // Peer contracts, immutable after init()
    IBroker private broker;

    // All open trades
    mapping(IERC20 => ITrade) public trades;
    uint48 public tradesOpen;

    // === Governance param ===
    uint192 public maxTradeSlippage; // {1}

    uint192 public minTradeVolume; // {UoA}
    // minTradeVolume should have been in BackingManager, but it's too late to move now

    // === Added in 3.0.0 ===

    // 0% = the lowest price estimate: a discount to the user of oracleError on each side
    // 50% = use the midpoint of the lowest and highest price estimates
    // 100% = the highest price estimate: a premium for the protocol of oracleError on each side
    uint192 public swapPricepoint; // {1} the percentile price to use within a swap

    // ==== Invariants ====
    // tradesOpen = len(values(trades))
    // trades[sell] != 0 iff trade[sell] has been opened and not yet settled

    // untestable:
    //      `else` branch of `onlyInitializing` (ie. revert) is currently untestable.
    //      This function is only called inside other `init` functions, each of which is wrapped
    //      in an `initializer` modifier, which would fail first.
    // solhint-disable-next-line func-name-mixedcase
    function __Trading_init(
        IMain main_,
        uint192 maxTradeSlippage_,
        uint192 minTradeVolume_,
        uint192 swapPricepoint_
    ) internal onlyInitializing {
        broker = main_.broker();
        setMaxTradeSlippage(maxTradeSlippage_);
        setMinTradeVolume(minTradeVolume_);
        setSwapPricepoint(swapPricepoint_);
    }

    /// Settle a single trade, expected to be used with multicall for efficient mass settlement
    /// @custom:interaction (only reads or writes trades, and is marked `nonReentrant`)
    // checks:
    //   !paused, !frozen
    //   trade[sell].canSettle()
    // actions:
    //   trade[sell].settle()
    // effects:
    //   trades.set(sell, 0)
    //   tradesOpen' = tradesOpen - 1
    // untested:
    //      OZ nonReentrant line is assumed to be working. cost/benefit of direct testing is high
    function settleTrade(IERC20 sell) external notPausedOrFrozen nonReentrant {
        ITrade trade = trades[sell];
        if (address(trade) == address(0)) return;
        require(trade.canSettle(), "cannot settle yet");

        delete trades[sell];
        tradesOpen--;

        // == Interactions ==
        (uint256 soldAmt, uint256 boughtAmt) = trade.settle();
        emit TradeSettled(trade, trade.sell(), trade.buy(), soldAmt, boughtAmt);
    }

    /// Claim all rewards
    /// Collective Action
    /// @custom:interaction CEI
    function claimRewards() external notPausedOrFrozen {
        RewardableLibP1.claimRewards(main.assetRegistry());
    }

    /// Claim rewards for a single asset
    /// Collective Action
    /// @param erc20 The ERC20 to claimRewards on
    /// @custom:interaction CEI
    function claimRewardsSingle(IERC20 erc20) external notPausedOrFrozen {
        RewardableLibP1.claimRewardsSingle(main.assetRegistry().toAsset(erc20));
    }

    /// Try to initiate a trade with a trading partner provided by the broker
    /// @custom:interaction (only reads or writes `trades`, and is marked `nonReentrant`)
    // checks:
    //   (not external, so we don't need auth or pause checks)
    //   trades[req.sell] == 0
    // actions:
    //   req.sell.increaseAllowance(broker, req.sellAmount) - two safeApprove calls to support USDT
    //   tradeID = broker.openTrade(req)
    // effects:
    //   trades' = trades.set(req.sell, tradeID)
    //   tradesOpen' = tradesOpen + 1
    //
    // untested:
    //      OZ nonReentrant line is assumed to be working. cost/benefit of direct testing is high
    // This is reentrancy-safe because we're using the `nonReentrant` modifier on every method of
    // this contract that changes state this function refers to.
    // slither-disable-next-line reentrancy-vulnerabilities-1
    /// @return The opened trade
    function openTrade(TradeRequest memory req) internal nonReentrant returns (ITrade) {
        IERC20 sell = req.sell.erc20();
        assert(address(trades[sell]) == address(0));

        IERC20(address(sell)).safeApprove(address(broker), 0);
        IERC20(address(sell)).safeApprove(address(broker), req.sellAmount);
        ITrade trade = broker.openTrade(req);

        trades[sell] = trade;
        tradesOpen++;
        emit TradeStarted(trade, sell, req.buy.erc20(), req.sellAmount, req.minBuyAmount);
        return trade;
    }

    /// Performs an atomic swap with the caller for exactly the provided Swap amounts
    function executeSwap(Swap memory s) internal nonReentrant {
        assert(
            address(s.sell) != address(0) &&
                address(s.buy) != address(0) &&
                s.buyAmount != 0 &&
                s.sellAmount != 0
        );

        uint256 sellBal = s.sell.balanceOf(address(this));
        uint256 buyBal = s.buy.balanceOf(address(this));

        // Transfer tokens in
        s.buy.safeTransferFrom(_msgSender(), address(this), s.buyAmount);
        assert(s.buy.balanceOf(address(this)) - buyBal == s.buyAmount);

        // Transfer tokens out
        s.sell.safeTransfer(_msgSender(), s.sellAmount);
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

    // Only BackingManager actually uses this param
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

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[45] private __gap;
}
