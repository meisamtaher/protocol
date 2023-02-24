// SPDX-License-Identifier: BlueOak-1.0.0
pragma solidity 0.8.17;

// import { IStaticATokenLM } from "../../plugins/aave/IStaticATokenLM.sol";
import "hardhat/console.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ZapERC20Params, TokenQuantity, IRTokenZapper } from "../../interfaces/IRTokenZapper.sol";
import { IMain } from "../../interfaces/IMain.sol";
import { IRToken } from "../../interfaces/IRToken.sol";
import { IBasketHandler } from "../../interfaces/IBasketHandler.sol";
import { FixLib, shiftl_toFix, RoundingMode } from "../../libraries/Fixed.sol";
import { ICToken, IComptroller } from "../../plugins/assets/ICToken.sol";
import { IWrappedNative } from "../../interfaces/IWrappedNative.sol";

interface IStaticATokenLM is IERC20 {
    function deposit(
        address recipient,
        uint256 amount,
        uint16 referralCode,
        bool fromUnderlying
    ) external returns (uint256);

    function staticToDynamicAmount(uint256 amount) external view returns (uint256);

    // solhint-disable func-name-mixedcase
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
}

interface CEther {
    function mint() external payable;
}

struct CTokenMapping {
    ICToken cToken;
    IERC20 underlying;
}

struct FrictionLessZapperConfig {
    IERC20[] tokens;
    IStaticATokenLM[] saTokens;
    CTokenMapping[] cTokens;
}

/**
 * @title FrictionlessZapper
 * @notice Implements Zapping functionality for tokens consisting of ERC20s, CTokens and SATokens
 */
contract FrictionlessZapper is IRTokenZapper {
    using FixLib for uint192;
    IRToken public rToken;

    IBasketHandler public basketHandler;
    IWrappedNative public wrappedNative;

    struct Config {
        IERC20[] tokens;
        IStaticATokenLM[] saTokens;
        ICToken[] cTokens;
    }
    Config private config;

    mapping(address => address) public saTokens;
    mapping(address => address) public cTokens;

    /// @param main_ The instance of IMain used for rToken
    /// @param rToken_ What rToken this implementation will mint
    /// @param wrappedNative_ The wrapped gas asset for the network.
    /// (weth for eth, arbi, optimism, wmatic for polygon)
    /// @param config_ Defines raw ERC20 tokens in the token basket, and the SA/CTokens.
    constructor(
        IMain main_,
        IRToken rToken_,
        IWrappedNative wrappedNative_,
        FrictionLessZapperConfig memory config_
    ) {
        wrappedNative = wrappedNative_;
        rToken = rToken_;
        basketHandler = main_.basketHandler();
        config.tokens = config_.tokens;
        config.saTokens = config_.saTokens;

        // Soldity does not support copying arrays of structs to storage for some reason
        // So we manually store the CTokens
        ICToken[] memory arrayWeCopyToStorage = new ICToken[](config_.cTokens.length);

        for (uint256 index = 0; index < config_.saTokens.length; index++) {
            IStaticATokenLM saToken = config_.saTokens[index];
            saTokens[address(saToken)] = saToken.UNDERLYING_ASSET_ADDRESS();
        }
        for (uint256 index = 0; index < config_.cTokens.length; index++) {
            ICToken cToken = config_.cTokens[index].cToken;
            IERC20 underlying = config_.cTokens[index].underlying;
            arrayWeCopyToStorage[index] = cToken;
            cTokens[address(cToken)] = address(underlying);
        }
        config.cTokens = arrayWeCopyToStorage;
    }

    function updateTokenQuantityArray(
        TokenQuantity[] memory container,
        address token,
        uint256 quantity
    ) internal pure {
        uint256 len = container.length;
        for (uint256 i; i < len; i++) {
            if (container[i].token == address(0)) {
                container[i].token = token;
                container[i].quantity = quantity;
                break;
            }
            if (container[i].token == token) {
                container[i].quantity += quantity;
                break;
            }
        }
    }

    function cTokenQuantityToUnderlyingQuantity(uint256 quantity, ICToken ctoken)
        internal
        returns (uint256)
    {
        // Note: rate has scale (10 + token.decimals)
        uint256 rate = ctoken.exchangeRateCurrent();

        // To convert into original token precision we need
        // quantity = rate * quantity / 10**10/10**token.decimals;
        //              ^ little bit concerned about precision here.
        //                The (rate * quantity) hits 46 digits for Dai!
        // by inverting quantity you can you can avoid large numbers
        uint256 numerator = 10**(ctoken.decimals() + 10);
        quantity = numerator / quantity; // quantity is scale 10 now
        return rate / quantity; // Output has token.decimals
    }

    /// @dev Returns a list if tokens + quantities needed
    /// for some amount of RTokens.
    /// While not marked as view, this method is meant to be called off-chain via
    /// an staticCall/eth_call.
    ///
    /// The inner loop has a quadratic time complexity, so can probably spend
    /// a lot of gas if there is a lot of tokens
    /// @param quantity The amount of RTokens we want to issue
    function getPrecursorTokens(uint192 quantity)
        external
        override
        returns (TokenQuantity[] memory)
    {
        uint256 rTokenSupply = rToken.totalSupply();
        uint192 baskets = (rTokenSupply > 0)
            ? rToken.basketsNeeded().muluDivu(quantity, rTokenSupply, RoundingMode.CEIL)
            : shiftl_toFix(quantity, -int8(rToken.decimals()));
        (address[] memory erc20s, uint256[] memory quantities) = basketHandler.quote(
            baskets,
            RoundingMode.CEIL
        );

        TokenQuantity[] memory out = new TokenQuantity[](erc20s.length);
        for (uint256 i = 0; i < erc20s.length; i++) {
            uint256 quantityNeeded = quantities[i];
            if (quantity == 0) {
                continue;
            }
            address outAsset = erc20s[i];
            if (saTokens[outAsset] != address(0)) {
                quantityNeeded = IStaticATokenLM(outAsset).staticToDynamicAmount(quantityNeeded);
                outAsset = saTokens[outAsset];
            } else if (cTokens[outAsset] != address(0)) {
                ICToken cToken = ICToken(outAsset);
                address underlying = cTokens[outAsset];
                require(
                    !IComptroller(cToken.comptroller()).mintGuardianPaused(address(cToken)),
                    "CTOKEN_MINTING_PAUSED"
                );
                quantityNeeded = cTokenQuantityToUnderlyingQuantity(quantityNeeded, cToken);
                outAsset = underlying;
            }
            updateTokenQuantityArray(out, outAsset, quantityNeeded);
        }

        for (uint256 i; i < out.length; i++) {
            if (out[i].token != address(0)) {
                continue;
            }
            // solhint-disable no-inline-assembly
            assembly {
                // Dangerous assembly here means:
                // Resize 'out' to be length 'i'.
                mstore(out, i)
            }
            break;
        }
        return out;
    }

    function setupApprovalFor(IERC20 token, address spender) internal {
        uint256 allowance = token.allowance(address(this), spender);
        if (allowance != 0) {
            return;
        }
        SafeERC20.safeApprove(IERC20(token), spender, type(uint256).max);
    }

    receive() external payable {
        require(msg.sender == address(wrappedNative), "INVALID_CALLER");
    }

    /// @param receiver Who to issue RTokens to, and send refunds
    /// @param params Parameters of the Zap
    function convertPrecursorTokensToRToken(address receiver, ZapERC20Params calldata params)
        external
        override
    {
        uint256 rTokenSupply = params.tokenOut.totalSupply();

        uint192 baskets = (rTokenSupply > 0)
            ? params.tokenOut.basketsNeeded().muluDivu(
                params.amountOut,
                rTokenSupply,
                RoundingMode.CEIL
            )
            : shiftl_toFix(params.amountOut, -int8(params.tokenOut.decimals()));
        (address[] memory erc20s, uint256[] memory quantities) = basketHandler.quote(
            baskets,
            RoundingMode.CEIL
        );
        for (uint256 i = 0; i < erc20s.length; i++) {
            uint256 quantity = quantities[i];
            if (quantity == 0) {
                continue;
            }
            if (saTokens[erc20s[i]] != address(0)) {
                IERC20 underlying = IERC20(saTokens[erc20s[i]]);
                IStaticATokenLM saToken = IStaticATokenLM(erc20s[i]);
                quantity = saToken.staticToDynamicAmount(quantity);

                setupApprovalFor(underlying, address(saToken));
                saToken.deposit(address(this), quantity, 0, true);
            } else if (cTokens[erc20s[i]] != address(0)) {
                IERC20 underlying = IERC20(cTokens[erc20s[i]]);
                ICToken cToken = ICToken(erc20s[i]);
                require(
                    !IComptroller(cToken.comptroller()).mintGuardianPaused(address(cToken)),
                    "CTOKEN_MINTING_PAUSED"
                );
                setupApprovalFor(underlying, address(cToken));
                quantity = cTokenQuantityToUnderlyingQuantity(quantity, cToken);

                if (underlying == wrappedNative) {
                    wrappedNative.withdraw(quantity);
                    CEther(address(cToken)).mint{ value: quantity }();
                } else {
                    cToken.mint(quantity);
                }
            }
            setupApprovalFor(IERC20(erc20s[i]), address(rToken));
        }
        rToken.issueTo(receiver, params.amountOut);

        refundResiduals(receiver, params);
    }

    function refundResiduals(address receiver, ZapERC20Params calldata params) internal {
        for (uint256 index = 0; index < config.tokens.length; index++) {
            uint256 quantity = config.tokens[index].balanceOf(address(this));
            if (quantity != 0) {
                SafeERC20.safeTransfer(IERC20(config.tokens[index]), receiver, quantity);
            }
        }
        uint256 quantity = params.tokenIn.balanceOf(address(this));
        if (quantity != 0) {
            SafeERC20.safeTransfer(IERC20(params.tokenIn), receiver, quantity);
        }
        for (uint256 index = 0; index < config.saTokens.length; index++) {
            uint256 quantity = config.saTokens[index].balanceOf(address(this));
            if (quantity != 0) {
                SafeERC20.safeTransfer(IERC20(config.saTokens[index]), receiver, quantity);
            }
        }
        for (uint256 index = 0; index < config.cTokens.length; index++) {
            ICToken token = config.cTokens[index];
            uint256 quantity = token.balanceOf(address(this));
            if (quantity != 0) {
                SafeERC20.safeTransfer(IERC20(token), receiver, quantity);
            }
        }
    }
}
