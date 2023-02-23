// SPDX-License-Identifier: BlueOak-1.0.0
pragma solidity 0.8.17;

// import { IStaticATokenLM } from "../../plugins/aave/IStaticATokenLM.sol";

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

    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
}

interface CEther {
    function mint() external payable;
}

struct CTokenMapping {
    ICToken cToken;
    IERC20 underlying;
}

struct TokenBasket {
    IERC20[] tokens;
    IStaticATokenLM[] saTokens;
    ICToken[] cTokens;
}

struct TokenBasketInput {
    IERC20[] tokens;
    IStaticATokenLM[] saTokens;
    CTokenMapping[] cTokens;
}

contract FrictionlessZapper is IRTokenZapper {
    using FixLib for uint192;
    IMain public main;
    IRToken public rToken;
    IBasketHandler public basketHandler;
    IWrappedNative public wrappedNative;
    TokenBasket private basket;

    mapping(address => address) public saTokens;
    mapping(address => address) public cTokens;

    constructor(
        IMain main_,
        IRToken rToken_,
        IWrappedNative wrappedNative_,
        TokenBasketInput memory tokenBasket
    ) {
        main = main_;
        wrappedNative = wrappedNative_;
        rToken = rToken_;
        basketHandler = main_.basketHandler();
        basket.tokens = tokenBasket.tokens;
        basket.saTokens = tokenBasket.saTokens;

        // Soldity does not support
        ICToken[] memory arrayWeCopyToStorage = new ICToken[](tokenBasket.cTokens.length);

        for (uint256 index = 0; index < tokenBasket.saTokens.length; index++) {
            IStaticATokenLM saToken = tokenBasket.saTokens[index];
            saTokens[address(saToken)] = saToken.UNDERLYING_ASSET_ADDRESS();
        }
        for (uint256 index = 0; index < tokenBasket.cTokens.length; index++) {
            ICToken cToken = tokenBasket.cTokens[index].cToken;
            IERC20 underlying = tokenBasket.cTokens[index].underlying;
            arrayWeCopyToStorage[index] = cToken;
            cTokens[address(cToken)] = address(underlying);
        }
        basket.cTokens = arrayWeCopyToStorage;
    }

    function getBasket() external view returns (TokenBasket memory output) {
        output = basket;
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
        // rate has scale 10 + token.decimals
        uint256 rate = ctoken.exchangeRateCurrent();

        // So to convert into orignal token precision we need
        // to divide by 10^(10 + token.decimals)

        // quantity = rate * quantity / 10**10/10**token.decimals;
        // ^ little bit concerned about precision here. The (rate * quantity) hits 46 digits
        // by inverting quantity you can you can avoid large numbers
        uint256 quantityScale = 10**(ctoken.decimals() + 10);
        quantity = quantityScale / quantity; // quantity is scale 10 now
        return rate / quantity;
    }

    // Returns a list if tokens + quantities needed
    // for some amount of RTokens
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
                if (!IComptroller(cToken.comptroller()).mintGuardianPaused(address(cToken))) {
                    quantityNeeded = cTokenQuantityToUnderlyingQuantity(quantityNeeded, cToken);
                    outAsset = underlying;
                }
            }
            updateTokenQuantityArray(out, outAsset, quantityNeeded);
        }

        for (uint256 i; i < out.length; i++) {
            if (out[i].token != address(0)) {
                continue;
            }
            // solhint-disable no-inline-assembly
            assembly {
                // Resizes out
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

                if (!IComptroller(cToken.comptroller()).mintGuardianPaused(address(cToken))) {
                    setupApprovalFor(underlying, address(cToken));
                    quantity = cTokenQuantityToUnderlyingQuantity(quantity, cToken);
                    if (underlying == wrappedNative) {
                        wrappedNative.withdraw(quantity);

                        CEther(address(cToken)).mint{ value: quantity }();
                    } else {
                        cToken.mint(quantity);
                    }
                }
            }
            setupApprovalFor(IERC20(erc20s[i]), address(rToken));
        }
        rToken.issueTo(receiver, params.amountOut);

        cleanup(receiver);
    }

    function cleanup(address receiver) internal {
        for (uint256 index = 0; index < basket.tokens.length; index++) {
            uint256 quantity = basket.tokens[index].balanceOf(address(this));
            if (quantity != 0) {
                SafeERC20.safeTransfer(IERC20(basket.tokens[index]), receiver, quantity);
            }
        }
        for (uint256 index = 0; index < basket.saTokens.length; index++) {
            uint256 quantity = basket.saTokens[index].balanceOf(address(this));
            if (quantity != 0) {
                SafeERC20.safeTransfer(IERC20(basket.saTokens[index]), receiver, quantity);
            }
        }
        for (uint256 index = 0; index < basket.cTokens.length; index++) {
            ICToken token = basket.cTokens[index];
            uint256 quantity = token.balanceOf(address(this));
            if (quantity != 0) {
                SafeERC20.safeTransfer(IERC20(token), receiver, quantity);
            }
        }
    }
}
