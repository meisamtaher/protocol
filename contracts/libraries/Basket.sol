// SPDX-License-Identifier: BlueOak-1.0.0
pragma solidity 0.8.9;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "contracts/interfaces/IBasket.sol";
import "contracts/libraries/Fixed.sol";

/*
 * @title BasketLib
 * Provides simple implementation methods for the Basket datatype
 */
library BasketLib {
    using BasketLib for Basket;
    using FixLib for uint192;

    // Empty self
    function empty(Basket storage self) internal {
        for (uint256 i = 0; i < self.erc20s.length; i++) {
            self.refAmts[self.erc20s[i]] = FIX_ZERO;
        }
        delete self.erc20s;
        self.nonce++;
        self.timestamp = uint48(block.timestamp);
        self.disabled = false;
    }

    /// Set `self` equal to `other`
    function copy(Basket storage self, Basket storage other) internal {
        empty(self);
        for (uint256 i = 0; i < other.erc20s.length; i++) {
            self.erc20s.push(other.erc20s[i]);
            self.refAmts[other.erc20s[i]] = other.refAmts[other.erc20s[i]];
        }
        self.nonce++;
        self.timestamp = uint48(block.timestamp);
        self.disabled = other.disabled;
    }

    /// Add `weight` to the refAmount of collateral token `tok` in the basket `self`
    function add(
        Basket storage self,
        IERC20 tok,
        uint192 weight
    ) internal {
        if (self.refAmts[tok].eq(FIX_ZERO)) {
            self.erc20s.push(tok);
            self.refAmts[tok] = weight;
        } else {
            self.refAmts[tok] = self.refAmts[tok].plus(weight);
        }
        self.nonce++;
        self.timestamp = uint48(block.timestamp);
    }
}
