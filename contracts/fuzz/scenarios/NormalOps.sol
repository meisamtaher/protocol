// SPDX-License-Identifier: BlueOak-1.0.0
pragma solidity 0.8.9;

import "@openzeppelin/contracts/utils/Strings.sol";

import "contracts/interfaces/IAsset.sol";
import "contracts/fuzz/IFuzz.sol";
import "contracts/fuzz/CollateralMock.sol";
import "contracts/fuzz/ERC20Fuzz.sol";
import "contracts/fuzz/PriceModel.sol";
import "contracts/fuzz/TradeMock.sol";
import "contracts/fuzz/Utils.sol";

import "contracts/fuzz/FuzzP1.sol";

// The "normal operations" fuzzing scenario, in which:
// - Tokens never default, or even threaten to default
// - The basket, once initialized, is never changed
// - No "significant" governance changes occur
contract NormalOpsScenario {
    MainP1Fuzz public main;

    PriceModel internal volatile =
        PriceModel({ kind: Kind.Walk, curr: 1e18, low: 0.5e18, high: 2e18 });
    PriceModel internal stable =
        PriceModel({ kind: Kind.Band, curr: 1e18, low: 0.995e18, high: 1.005e18 });
    PriceModel internal growing =
        PriceModel({ kind: Kind.Walk, curr: 1e18, low: 1e18, high: 1.1e18 });
    PriceModel internal justOne = PriceModel({ kind: Kind.Constant, curr: 1e18, low: 0, high: 0 });

    IERC20[] public collateralTokens;
    IERC20[] public backupTokens;

    // Once constructed, everything is set up for random echidna runs to happen:
    // - main and its components are up
    // - standard tokens, and their Assets and Collateral, exist
    // - standard basket is configured
    // - at least one user has plenty of starting tokens
    constructor() {
        main = new MainP1Fuzz();
        main.initFuzz(defaultParams(), defaultFreezeDuration(), new MarketMock(main));

        TradingRange memory tradingRange = defaultParams().tradingRange;

        // Create three "standard" collateral tokens
        for (uint256 i = 0; i < 3; i++) {
            string memory num = Strings.toString(i);
            ERC20Fuzz token = new ERC20Fuzz(concat("Collateral ", num), concat("C", num), main);
            main.addToken(token);

            main.assetRegistry().register(
                new CollateralMock(
                    IERC20Metadata(address(token)),
                    tradingRange,
                    0,
                    0,
                    IERC20Metadata(address(0)),
                    bytes32("USD"),
                    growing,
                    stable,
                    justOne,
                    stable
                )
            );
            collateralTokens.push(IERC20(token));
        }

        // Create three "standard" backup USD tokens
        for (uint256 i = 0; i < 3; i++) {
            string memory num = Strings.toString(i);
            ERC20Fuzz token = new ERC20Fuzz(concat("Stable USD ", num), concat("USD", num), main);
            main.addToken(token);

            main.assetRegistry().register(
                new CollateralMock(
                    IERC20Metadata(address(token)),
                    tradingRange,
                    0,
                    0,
                    IERC20Metadata(address(0)),
                    bytes32("USD"),
                    justOne,
                    stable,
                    justOne,
                    justOne
                )
            );
            backupTokens.push(IERC20(token));
        }

        // Configure basket
        uint192[] memory wts = new uint192[](3);
        wts[0] = 0.5e18;
        wts[1] = 0.3e18;
        wts[2] = 0.2e18;
        main.basketHandler().setPrimeBasket(collateralTokens, wts);
        main.basketHandler().setBackupConfig(bytes32("USD"), 3, backupTokens);
        main.basketHandler().refreshBasket();

        // Add a few users and give them initial tokens
        for (uint256 u = 1; u <= 3; u++) {
            address user = address(uint160(u * 0x10000));
            main.addUser(user);
            ERC20Fuzz(address(main.rsr())).mint(user, 1e24);
            for (uint256 t = 0; t < main.numTokens(); t++) {
                ERC20Fuzz(address(main.tokens(t))).mint(user, 1e24);
            }
        }

        // Complete deployment by unfreezing
        main.assetRegistry().refresh();
        main.unfreeze();

        // Grant max allowances from BackingManager for RToken
        for (uint256 t = 0; t < main.numTokens(); t++) {
            main.backingManager().grantRTokenAllowance(main.tokens(t));
        }
    }

    modifier asSender() {
        main.spoof(address(this), msg.sender);
        _;
        main.unspoof(address(this));
    }

    // ==== tiny, stupid-simple example of all this ====
    function startIssue() public {
        address alice = main.users(0);

        main.spoof(address(this), alice);
        ERC20Fuzz(address(main.tokens(0))).approve(address(main.rToken()), 1e24);
        ERC20Fuzz(address(main.tokens(1))).approve(address(main.rToken()), 1e24);
        ERC20Fuzz(address(main.tokens(2))).approve(address(main.rToken()), 1e24);

        main.rToken().issue(1e24);
        main.unspoof(address(this));
    }

    function finishIssue() public {
        main.rToken().vest(main.users(0), 1);
    }

    function redeem() public {
        main.spoof(address(this), main.users(0));

        main.backingManager().grantRTokenAllowance(main.tokens(0));
        main.backingManager().grantRTokenAllowance(main.tokens(1));
        main.backingManager().grantRTokenAllowance(main.tokens(2));
        main.rToken().redeem(1e24);

        main.unspoof(address(this));
    }

    // ================ real mutators ================

    // ==== user functions: token ops ====
    // Send some token as the calling user.
    function transfer(uint8 addrID, uint8 tokenID, uint256 amount) public asSender{
        IERC20 token = main.someToken(tokenID);
        address to = main.someAddr(addrID);
        token.transfer(to, amount);
    }
    /* function allow(address spender, uint8 tokenID, uint256 amount); */
    /* function transferFrom(address from, address to, uint8 tokenID, uint256 amount); */

    // user functions: rtoken
    /* function issueRToken(uint256 amount); */
    /* function cancelIssuance(uint256 endID, bool earliest); // filter endIDs mostly to valid IDs*/
    /* function vestIssuance(uint256 endID); // filter endIDs mostly to valid IDs */
    /* function issueAndVestRToken(uint256 amount); */
    /* function redeemRToken(uint256 amount); */

    // user functions: strsr
    /* function stake(uint256 amount); */
    /* function unstake(uint256 amount); */
    /* function withdraw(uint256 endID); */

    // ==== keeper functions ====
    // function claimRewards(uint256 tokenID)
    // function settleTrades()
    // function manageBackingToken(uint256 tokenID)
    // function grantAllowances(uint256 tokenID)
    // function payRSRRewards() // do strsr rewards
    // function payRTokenRewards() // do rtoken rewards

    // ==== governance changes ====
    /* function setDistribution(address dest, uint16 rTokenDist, uint16 rsrDist) */

    // ================ System Properties ================
    // A few example properties to start with:
    /* function echidna_isFullyCapitalized() //include "total redemption is affordable" */
    /* function echidna_quoteProportionalToBasket() */
    /* how would I check that prepareTradeRecacapitalize(), compromiseBasketsNeeded(),
     * and stRSR.seizeRSR() are never called? I could override them in the scenario with a function
     * that just reverts with echidna-stopping error */
    /* stRSR.exchangeRate only increases */
}
