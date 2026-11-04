// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BscFixture} from "./utils/Fixtures.sol";
import {WantosFixture} from "./utils/WantosFixture.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {BridgeBase} from "../src/BridgeBase.sol";
import {BridgeTimelock} from "../src/BridgeTimelock.sol";
import {BscVaultV2} from "../src/BscVaultV2.sol";
import {WantosBridgeV2} from "../src/WantosBridgeV2.sol";

contract Rejector {
    receive() external payable {
        revert("no");
    }
}

/// a recipient that burns all the gas it is given
contract GasBurner {
    receive() external payable {
        assembly {
            invalid()
        }
    }
}

/// a fee recipient that tries to re-enter deposit() from its receive hook and swallows the failure
contract ReenteringRecipient {
    BscVaultV2 public vault;
    bytes public caught;
    bool public attempted;

    constructor(BscVaultV2 v) {
        vault = v;
    }

    receive() external payable {
        attempted = true;
        try vault.deposit{value: msg.value}(1, address(this)) {}
        catch (bytes memory r) {
            caught = r;
        }
    }
}

/// a depositor that re-enters deposit() when its refund arrives (fee off) and swallows the failure
contract ReenteringDepositor {
    bool public attempted;
    bytes public caught;

    function go(BscVaultV2 v, IERC20 t, uint256 amt) external payable {
        t.approve(address(v), amt);
        v.deposit{value: msg.value}(amt, address(this));
    }

    receive() external payable {
        attempted = true;
        try BscVaultV2(payable(msg.sender)).deposit{value: msg.value}(1, address(this)) {}
        catch (bytes memory r) {
            caught = r;
        }
    }
}

/// a WANTOS fee recipient that tries to re-enter bridgeOut() from its receive hook and swallows the failure
contract ReenteringBridgeRecipient {
    WantosBridgeV2 public bridge;
    bytes public caught;
    bool public attempted;

    constructor(WantosBridgeV2 b) {
        bridge = b;
    }

    receive() external payable {
        attempted = true;
        try bridge.bridgeOut{value: msg.value}(1) {}
        catch (bytes memory r) {
            caught = r;
        }
    }
}

/// a depositor that cannot receive native coin back
contract NoReceiveDepositor {
    function go(BscVaultV2 v, IERC20 t, uint256 amt) external payable {
        t.approve(address(v), amt);
        v.deposit{value: msg.value}(amt, address(this));
    }
}

// =================================================================== BSC: client attaches the fee, the contract keeps it within [MIN_FEE, MAX_FEE]
contract NativeFeeBscTest is BscFixture {
    address recipient = address(0xADCDe89431978C79ef66956Cfed67ac925426957);
    uint256 constant GWEI = 1e9;
    uint256 constant FLOOR = 0.05 gwei; // BSC's minimum gas price

    function setUp() public {
        _deployBsc();
    }

    function _set(address to, uint256 m) internal {
        _viaTimelock(address(vault), abi.encodeCall(BscVaultV2.setNativeFeeConfig, (to, m)));
    }

    function _dep(address from, uint256 amt, uint256 value) internal {
        token.mint(from, amt);
        vm.deal(from, 1 ether);
        vm.startPrank(from);
        token.approve(address(vault), amt);
        vault.deposit{value: value}(amt, makeAddr("wantosRecipient"));
        vm.stopPrank();
    }

    function test_defaultOff() public {
        assertEq(vault.quoteNativeFee(FLOOR), 0);
        _dep(alice, 100 * U, 0);
        assertEq(vault.depositNonce(), 1);
    }

    function test_defaultOff_overpaymentReturned() public {
        uint256 before = alice.balance;
        _dep(alice, 100 * U, 0.5 ether);
        assertEq(alice.balance, 1 ether); // dealt 1 ether, got the 0.5 back
        before;
        assertEq(address(vault).balance, 0);
    }

    function test_quoteFollowsGasPrice_sameForAnyAmount() public {
        _set(recipient, 10);
        assertEq(vault.quoteNativeFee(FLOOR), 0.0005 ether); // 10x gives 0.0001, the floor lifts it to 0.0005
        assertEq(vault.quoteNativeFee(0.5 gwei), 0.001 ether);
        assertEq(vault.quoteNativeFee(0.25 gwei), 0.0005 ether); // exactly the floor
        assertEq(vault.quoteNativeFee(0.35 gwei), 0.0007 ether);
        assertEq(vault.quoteNativeFee(0), 0.0005 ether); // gas price 0 cannot dodge the fee
        assertEq(vault.quoteNativeFee(100 gwei), 0.002 ether); // cap
        (address r, uint256 m) = vault.nativeFeeConfig();
        assertEq(r, recipient);
        assertEq(m, 10);
    }

    function test_attachedFeeForwardedWhole_noDependenceOnTxGasPrice() public {
        _set(recipient, 10);
        uint256 fee = vault.quoteNativeFee(0.5 gwei); // the client quotes at the gas price it estimated
        assertEq(fee, 0.001 ether);
        uint256[3] memory prices = [uint256(0), 0.05 gwei, 100 gwei]; // whatever price the wallet actually uses
        for (uint256 k; k < prices.length; ++k) {
            vm.txGasPrice(prices[k]);
            uint256 r0 = recipient.balance;
            _dep(alice, 300 * U, fee);
            assertEq(recipient.balance - r0, fee);
            assertEq(address(vault).balance, 0);
            assertEq(1 ether - alice.balance, fee); // _dep deals 1 ether first: she paid the fee and nothing else
        }
        assertEq(vault.depositNonce(), 3);
    }

    function test_anyValueInTheBandIsKeptWhole_noRefund() public {
        _set(recipient, 10);
        uint256 v = 0.0012 ether; // between the floor and the cap, not a quote
        uint256 r0 = recipient.balance;
        token.mint(alice, 300 * U);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        token.approve(address(vault), 300 * U);
        vault.deposit{value: v}(300 * U, alice);
        vm.stopPrank();
        assertEq(recipient.balance - r0, v);
        assertEq(1 ether - alice.balance, v); // nothing came back
        assertEq(address(vault).balance, 0);
    }

    function test_valueOutsideTheBandReverts() public {
        _set(recipient, 10);
        token.mint(alice, 400 * U);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        token.approve(address(vault), 400 * U);
        uint256 lo = vault.MIN_FEE(); // read before expectRevert: it applies to the very next external call
        uint256 hi = vault.MAX_FEE();
        vm.expectRevert(BscVaultV2.WrongNativeFee.selector);
        vault.deposit(300 * U, alice); // nothing attached
        vm.expectRevert(BscVaultV2.WrongNativeFee.selector);
        vault.deposit{value: lo - 1}(300 * U, alice);
        vm.expectRevert(BscVaultV2.WrongNativeFee.selector);
        vault.deposit{value: hi + 1}(300 * U, alice); // a buggy client cannot overpay
        vault.deposit{value: lo}(300 * U, alice); // both ends are accepted
        vault.deposit{value: hi}(100 * U, alice);
        vm.stopPrank();
        assertEq(vault.depositNonce(), 2);
    }

    function test_rejectingRecipientRevertsWholeDeposit() public {
        _set(address(new Rejector()), 10);
        token.mint(alice, 300 * U);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        token.approve(address(vault), 300 * U);
        vm.expectRevert(BscVaultV2.NativeFeeTransferFailed.selector);
        vault.deposit{value: 0.0005 ether}(300 * U, alice);
        vm.stopPrank();
        assertEq(vault.depositNonce(), 0);
    }

    function test_contractWalletDepositsWhenFeeOn_noRefundNeeded() public {
        _set(recipient, 10);
        NoReceiveDepositor d = new NoReceiveDepositor();
        token.mint(address(d), 100 * U);
        vm.deal(address(this), 1 ether);
        d.go{value: 0.0005 ether}(vault, token, 100 * U); // the whole value is the fee: nothing to send back
        assertEq(vault.depositNonce(), 1);
    }

    function test_feeOff_contractWalletThatCannotReceiveRefundReverts() public {
        NoReceiveDepositor d = new NoReceiveDepositor();
        token.mint(address(d), 100 * U);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(BscVaultV2.NativeFeeTransferFailed.selector);
        d.go{value: 0.5 ether}(vault, token, 100 * U); // off: a value is sent back, and this wallet cannot take it
        d.go(vault, token, 100 * U);
        assertEq(vault.depositNonce(), 1);
    }

    function test_configBoundsAndAuth() public {
        bytes memory data = abi.encodeCall(BscVaultV2.setNativeFeeConfig, (recipient, 101));
        bytes32 salt = _propose(address(vault), data);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.ParamOutOfRange.selector, 0));
        _execute(address(vault), data, salt);

        data = abi.encodeCall(BscVaultV2.setNativeFeeConfig, (address(0), 10));
        salt = _propose(address(vault), data);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(BridgeBase.ZeroAddress.selector);
        _execute(address(vault), data, salt);

        _set(address(0), 0); // off needs no recipient
        assertEq(vault.quoteNativeFee(FLOOR), 0);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTimelock.selector, admin));
        vault.setNativeFeeConfig(recipient, 10); // admin cannot set, only the timelock
    }

    function test_killSwitch() public {
        _set(recipient, 10);
        vm.expectEmit(true, true, false, true);
        emit BscVaultV2.NativeFeeConfigUpdated(recipient, 0, admin);
        vm.prank(admin);
        vault.disableNativeFee();
        assertEq(vault.quoteNativeFee(10 gwei), 0);
        (address r, uint256 m) = vault.nativeFeeConfig();
        assertEq(r, recipient);
        assertEq(m, 0);
        _dep(alice, 100 * U, 0);
        _dep(bob, 100 * U, 0.0006 ether); // a client that quoted just before the switch-off still succeeds: its value comes back
        assertEq(bob.balance, 1 ether);
        assertEq(vault.depositNonce(), 2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdmin.selector, alice));
        vault.disableNativeFee();
    }

    // ---- review follow-ups (independent review, 2026-11-04) ----

    function test_configRevertsWhilePaused() public {
        vm.prank(pauser);
        vault.pause();
        bytes memory data = abi.encodeCall(BscVaultV2.setNativeFeeConfig, (recipient, 10));
        bytes32 salt = _propose(address(vault), data);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        _execute(address(vault), data, salt);
    }

    function test_configRevertsDuringRecovery() public {
        vm.prank(admin);
        vault.startWhitelistRecovery(makeAddr("wl2"));
        vm.prank(address(tl));
        vm.expectRevert(BridgeBase.RecoveryInProgress.selector);
        vault.setNativeFeeConfig(recipient, 10);
    }

    function test_killSwitchWorksWhilePaused() public {
        _set(recipient, 10);
        vm.prank(pauser);
        vault.pause();
        vm.prank(admin);
        vault.disableNativeFee();
        (, uint256 m) = vault.nativeFeeConfig();
        assertEq(m, 0);
    }

    function test_timelockCanSwitchOffWithZeroMultiplier_feeStaysOff() public {
        _set(recipient, 10);
        _set(recipient, 0);
        assertEq(vault.quoteNativeFee(10 gwei), 0);
        uint256 r0 = recipient.balance;
        _dep(alice, 100 * U, 0.0007 ether); // value is sent back, nothing reaches the recipient
        assertEq(recipient.balance, r0);
        assertEq(alice.balance, 1 ether);
    }

    function test_gasBurningRecipientBlocksDeposits_killSwitchRecovers() public {
        _set(address(new GasBurner()), 10);
        token.mint(alice, 300 * U);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        token.approve(address(vault), 300 * U);
        vm.expectRevert(BscVaultV2.NativeFeeTransferFailed.selector);
        vault.deposit{value: 0.0005 ether}(100 * U, alice);
        vm.stopPrank();
        vm.prank(admin);
        vault.disableNativeFee(); // the multiplier-0 path never calls the recipient
        vm.prank(alice);
        vault.deposit(100 * U, alice);
        assertEq(vault.depositNonce(), 1);
    }

    function test_recipientCannotReenterDeposit() public {
        ReenteringRecipient rr = new ReenteringRecipient(vault);
        _set(address(rr), 10);
        _dep(alice, 100 * U, 0.0005 ether);
        assertTrue(rr.attempted());
        assertEq(bytes4(rr.caught()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(vault.depositNonce(), 1); // only the outer deposit happened
        assertEq(address(rr).balance, 0.0005 ether); // and it kept exactly the fee
    }

    function test_refundCallbackCannotReenterDeposit_feeOff() public {
        ReenteringDepositor d = new ReenteringDepositor();
        token.mint(address(d), 100 * U);
        vm.deal(address(this), 1 ether);
        d.go{value: 0.3 ether}(vault, token, 100 * U);
        assertTrue(d.attempted());
        assertEq(bytes4(d.caught()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(vault.depositNonce(), 1);
        assertEq(address(d).balance, 0.3 ether); // the value came back whole
    }

    function test_forcedBnbIsNeverUsedAsRefundOrFee() public {
        vm.deal(address(vault), 1 ether); // what a selfdestruct would leave behind
        // fee off: exactly msg.value comes back, not the vault balance
        _dep(alice, 100 * U, 0.3 ether);
        assertEq(alice.balance, 1 ether);
        assertEq(address(vault).balance, 1 ether);
        // fee on: exactly msg.value reaches the recipient
        _set(recipient, 10);
        uint256 r0 = recipient.balance;
        _dep(bob, 100 * U, 0.0007 ether);
        assertEq(recipient.balance - r0, 0.0007 ether);
        assertEq(address(vault).balance, 1 ether);
    }

    function test_collectedEventAndExactBalances() public {
        _set(recipient, 10);
        uint256 fee = 0.0009 ether;
        token.mint(alice, 100 * U);
        vm.deal(alice, 1 ether);
        uint256 r0 = recipient.balance;
        vm.startPrank(alice);
        token.approve(address(vault), 100 * U);
        vm.expectEmit(true, true, false, true, address(vault));
        emit BscVaultV2.NativeFeeCollected(alice, recipient, fee);
        vault.deposit{value: fee}(100 * U, alice);
        vm.stopPrank();
        assertEq(1 ether - alice.balance, fee);
        assertEq(recipient.balance - r0, fee);
        assertEq(address(vault).balance, 0);
    }

    function test_quoteExactEdgesForMultiplierExtremes() public {
        _set(recipient, 50);
        assertEq(vault.quoteNativeFee(0.05 gwei), vault.MIN_FEE()); // 5e7 * 2e5 * 50 = MIN_FEE exactly
        assertEq(vault.quoteNativeFee(0.05 gwei + 1), vault.MIN_FEE() + 1e7); // one wei of gas price above the floor
        assertEq(vault.quoteNativeFee(0.2 gwei), vault.MAX_FEE()); // 2e8 * 2e5 * 50 = MAX_FEE exactly
        assertEq(vault.quoteNativeFee(0.2 gwei + 1), vault.MAX_FEE()); // clamped
        _set(recipient, 1);
        assertEq(vault.quoteNativeFee(100 gwei), vault.MAX_FEE()); // 100 gwei * 2e5 * 1 is far above the cap
        assertEq(vault.quoteNativeFee(0), vault.MIN_FEE());
        _set(recipient, 100);
        assertEq(vault.quoteNativeFee(0.1 gwei), vault.MAX_FEE()); // 1e8 * 2e5 * 100 = MAX_FEE exactly
        assertEq(vault.quoteNativeFee(0.1 gwei - 1), vault.MAX_FEE() - 2e7);
    }

    // ---- the real rollout path: ONE timelock batch [upgradeToAndCall, setNativeFeeConfig] (review, 2026-11-04) ----

    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function _impl() internal view returns (address) {
        return address(uint160(uint256(vm.load(address(vault), IMPL_SLOT))));
    }

    function _batch(address newImpl, uint256 delay)
        internal
        returns (address[] memory t, uint256[] memory v, bytes[] memory p, bytes32 salt)
    {
        t = new address[](2);
        v = new uint256[](2);
        p = new bytes[](2);
        t[0] = address(vault);
        t[1] = address(vault);
        p[0] = abi.encodeCall(vault.upgradeToAndCall, (newImpl, ""));
        p[1] = abi.encodeCall(BscVaultV2.setNativeFeeConfig, (recipient, 50));
        salt = bytes32(uint256(0xBA7C4));
        vm.prank(tl.adminWallet());
        tl.scheduleBatch(t, v, p, bytes32(0), salt, delay);
    }

    function test_batch_upgradeThenConfig_bothApplied() public {
        address newImpl = address(new BscVaultV2());
        (address[] memory t, uint256[] memory v, bytes[] memory p, bytes32 salt) = _batch(newImpl, 48 hours);
        vm.warp(block.timestamp + 48 hours);
        tl.executeBatch(t, v, p, bytes32(0), salt);
        assertEq(_impl(), newImpl);
        (address r, uint256 m) = vault.nativeFeeConfig();
        assertEq(r, recipient);
        assertEq(m, 50);
        assertEq(vault.quoteNativeFee(0.05 gwei), 0.0005 ether);
    }

    function test_batch_delayLongerThanMinimumIsAccepted_executableOnlyThen() public {
        address newImpl = address(new BscVaultV2());
        (address[] memory t, uint256[] memory v, bytes[] memory p, bytes32 salt) = _batch(newImpl, 6 days);
        vm.warp(block.timestamp + 48 hours); // the minimum has passed, the chosen go-live has not
        vm.expectRevert(); // TimelockUnexpectedOperationState: not ready yet
        tl.executeBatch(t, v, p, bytes32(0), salt);
        assertTrue(_impl() != newImpl);
        vm.warp(block.timestamp + 4 days);
        tl.executeBatch(t, v, p, bytes32(0), salt);
        assertEq(_impl(), newImpl);
    }

    function test_batch_whilePaused_wholeBatchReverts_upgradeNotApplied() public {
        address old = _impl();
        address newImpl = address(new BscVaultV2());
        (address[] memory t, uint256[] memory v, bytes[] memory p, bytes32 salt) = _batch(newImpl, 48 hours);
        vm.prank(pauser);
        vault.pause();
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector); // the config step refuses, the upgrade rolls back with it
        tl.executeBatch(t, v, p, bytes32(0), salt);
        assertEq(_impl(), old);
        vm.prank(admin);
        vault.unpause();
        tl.executeBatch(t, v, p, bytes32(0), salt); // after the unpause it goes through (the relayer retries every minute)
        assertEq(_impl(), newImpl);
    }

    function test_batch_duringWhitelistRecovery_reverts() public {
        address old = _impl();
        (address[] memory t, uint256[] memory v, bytes[] memory p, bytes32 salt) = _batch(address(new BscVaultV2()), 48 hours);
        vm.prank(admin);
        vault.startWhitelistRecovery(makeAddr("wl2"));
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(BridgeTimelock.RecoveryInProgress.selector);
        tl.executeBatch(t, v, p, bytes32(0), salt);
        assertEq(_impl(), old);
    }

    function test_batch_afterExpiry_reverts() public {
        address old = _impl();
        (address[] memory t, uint256[] memory v, bytes[] memory p, bytes32 salt) = _batch(address(new BscVaultV2()), 48 hours);
        bytes32 id = tl.hashOperationBatch(t, v, p, bytes32(0), salt);
        vm.warp(block.timestamp + 48 hours + 14 days + 1);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.OperationExpired.selector, id));
        tl.executeBatch(t, v, p, bytes32(0), salt);
        assertEq(_impl(), old);
    }

    function test_batch_cancelledByWhitelistWalletCannotExecute() public {
        address old = _impl();
        (address[] memory t, uint256[] memory v, bytes[] memory p, bytes32 salt) = _batch(address(new BscVaultV2()), 48 hours);
        bytes32 id = tl.hashOperationBatch(t, v, p, bytes32(0), salt);
        vm.prank(vault.whitelistManager());
        tl.cancel(id);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        tl.executeBatch(t, v, p, bytes32(0), salt);
        assertEq(_impl(), old);
    }

    function test_batch_staleAfterAdminRecovery() public {
        address old = _impl();
        (address[] memory t, uint256[] memory v, bytes[] memory p, bytes32 salt) = _batch(address(new BscVaultV2()), 48 hours);
        bytes32 id = tl.hashOperationBatch(t, v, p, bytes32(0), salt);
        address newAdmin = makeAddr("newAdmin");
        vm.prank(vault.whitelistManager());
        tl.startAdminRecovery(newAdmin);
        vm.warp(block.timestamp + 14 days);
        vm.prank(newAdmin);
        tl.acceptAdmin(); // epoch + 1
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.OperationStaleEpoch.selector, id));
        tl.executeBatch(t, v, p, bytes32(0), salt);
        assertEq(_impl(), old);
    }

    function test_storageMatchesLayoutSnapshot() public {
        string memory j = vm.readFile("contracts/test/layout/BscNativeFee.namespace.json");
        uint256 base = vm.parseJsonUint(j, ".base");
        assertEq(
            bytes32(base),
            keccak256(abi.encode(uint256(keccak256("wantos.bridge.v2.BscNativeFee")) - 1)) & ~bytes32(uint256(0xff))
        );
        assertEq(vm.parseJsonKeys(j, ".fields").length, 2);
        _set(recipient, 10);
        assertEq(
            uint256(vm.load(address(vault), bytes32(base + vm.parseJsonUint(j, ".fields.feeRecipient.slot")))),
            uint256(uint160(recipient))
        );
        assertEq(uint256(vm.load(address(vault), bytes32(base + vm.parseJsonUint(j, ".fields.multiplier.slot")))), 10);
    }
}

// =================================================================== WANTOS: tiered by amount
contract NativeFeeWantosTest is WantosFixture {
    address recipient = address(0xADCDe89431978C79ef66956Cfed67ac925426957);

    function setUp() public {
        _deployWantos();
        _fundUser(alice, 10_000 * U);
        vm.deal(alice, 1000 ether);
        _applyBatch(bridge, _one(alice), true);
    }

    function _cfg(uint256[4] memory f, address to) internal pure returns (WantosBridgeV2.FeeStorage memory) {
        return WantosBridgeV2.FeeStorage({
            feeRecipient: to,
            l0: 200 * U,
            l1: 1000 * U,
            l2: 5000 * U,
            f0: f[0],
            f1: f[1],
            f2: f[2],
            f3: f[3]
        });
    }

    function _fees() internal pure returns (uint256[4] memory f) {
        f = [uint256(2.5 ether), 12 ether, 50 ether, 120 ether];
    }

    function _set() internal {
        _viaTimelock(address(bridge), abi.encodeCall(WantosBridgeV2.setNativeFeeTiers, (_cfg(_fees(), recipient))));
    }

    function _rejects(WantosBridgeV2.FeeStorage memory c, bytes memory expected) internal {
        bytes memory data = abi.encodeCall(WantosBridgeV2.setNativeFeeTiers, (c));
        bytes32 salt = _propose(address(bridge), data);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(expected); // the exact validator that must fire, not just "something reverted"
        _execute(address(bridge), data, salt);
        assertEq(bridge.quoteNativeFee(10 * U), 0);
    }

    function test_defaultOff_unchanged() public {
        vm.prank(alice);
        bridge.bridgeOut(100 * U);
        assertEq(bridge.orderNonce(), 1);
        vm.prank(alice);
        vm.expectRevert(WantosBridgeV2.WrongNativeFee.selector);
        bridge.bridgeOut{value: 1}(100 * U);
    }

    function test_quoteTiers() public {
        _set();
        assertEq(bridge.quoteNativeFee(10 * U), 2.5 ether);
        assertEq(bridge.quoteNativeFee(200 * U - 1), 2.5 ether);
        assertEq(bridge.quoteNativeFee(200 * U), 12 ether);
        assertEq(bridge.quoteNativeFee(1000 * U - 1), 12 ether);
        assertEq(bridge.quoteNativeFee(1000 * U), 50 ether);
        assertEq(bridge.quoteNativeFee(5000 * U - 1), 50 ether);
        assertEq(bridge.quoteNativeFee(5000 * U), 120 ether);
        assertEq(bridge.quoteNativeFee(type(uint128).max), 120 ether);
        assertEq(bridge.feeRecipient(), recipient);
    }

    function test_feeForwarded_contractHoldsNothing() public {
        _set();
        uint256 before = recipient.balance;
        vm.prank(alice);
        bridge.bridgeOut{value: 12 ether}(300 * U);
        assertEq(recipient.balance - before, 12 ether);
        assertEq(address(bridge).balance, 0);
        assertEq(bridge.orderNonce(), 1);
    }

    function test_wrongValueReverts() public {
        _set();
        vm.startPrank(alice);
        vm.expectRevert(WantosBridgeV2.WrongNativeFee.selector);
        bridge.bridgeOut(300 * U);
        vm.expectRevert(WantosBridgeV2.WrongNativeFee.selector);
        bridge.bridgeOut{value: 2.5 ether}(300 * U); // lower tier's fee
        vm.expectRevert(WantosBridgeV2.WrongNativeFee.selector);
        bridge.bridgeOut{value: 12 ether + 1}(300 * U);
        vm.stopPrank();
        assertEq(bridge.orderNonce(), 0);
    }

    function test_rejectingRecipientReverts() public {
        _viaTimelock(
            address(bridge),
            abi.encodeCall(WantosBridgeV2.setNativeFeeTiers, (_cfg(_fees(), address(new Rejector()))))
        );
        vm.prank(alice);
        vm.expectRevert(WantosBridgeV2.NativeFeeTransferFailed.selector);
        bridge.bridgeOut{value: 12 ether}(300 * U);
        assertEq(bridge.orderNonce(), 0);
    }

    function test_floorCapOrderingAndRecipient() public {
        bytes memory belowFloor = abi.encodeWithSelector(BridgeBase.ParamOutOfRange.selector, 1);
        bytes memory aboveCap = abi.encodeWithSelector(BridgeBase.ParamOutOfRange.selector, 0);
        bytes memory constraint = abi.encodeWithSelector(BridgeBase.ParamConstraint.selector);
        _rejects(_cfg([uint256(1.2 ether - 1), 12 ether, 50 ether, 120 ether], recipient), belowFloor);
        _rejects(_cfg([uint256(2.5 ether), 12 ether, 50 ether, 250 ether + 1], recipient), aboveCap);
        _rejects(_cfg([uint256(0), 0, 0, 0], recipient), belowFloor); // all zero: use the kill switch
        _rejects(_cfg([uint256(5 ether), 2.5 ether, 50 ether, 120 ether], recipient), constraint); // decreasing
        _rejects(_cfg([uint256(2.5 ether), 12 ether, 50 ether, 40 ether], recipient), constraint); // decreasing
        WantosBridgeV2.FeeStorage memory c = _cfg(_fees(), recipient);
        c.l2 = c.l1;
        _rejects(c, constraint); // limits not ascending
        c = _cfg(_fees(), recipient);
        c.l0 = c.l1;
        _rejects(c, constraint); // limits not strictly ascending (l0 == l1)
        _rejects(_cfg(_fees(), address(0)), abi.encodeWithSelector(BridgeBase.ZeroAddress.selector));
        // exactly the floor is fine
        _viaTimelock(
            address(bridge),
            abi.encodeCall(
                WantosBridgeV2.setNativeFeeTiers,
                (_cfg([uint256(1.2 ether), 1.2 ether, 50 ether, 120 ether], recipient))
            )
        );
        assertEq(bridge.quoteNativeFee(10 * U), 1.2 ether);
    }

    function test_killSwitch() public {
        _set();
        vm.expectEmit(true, true, false, false);
        emit WantosBridgeV2.NativeFeeConfigUpdated(recipient, admin);
        vm.prank(admin);
        bridge.disableNativeFee();
        assertEq(bridge.quoteNativeFee(6000 * U), 0);
        assertEq(bridge.feeRecipient(), recipient);
        vm.prank(alice);
        bridge.bridgeOut(100 * U);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTimelock.selector, admin));
        bridge.setNativeFeeTiers(_cfg(_fees(), recipient));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdmin.selector, alice));
        bridge.disableNativeFee();
    }

    // ---- review follow-ups (two independent reviews, 2026-11-04) ----

    function test_tiersGetterReturnsTheWholeTable() public {
        _set();
        WantosBridgeV2.FeeStorage memory t = bridge.nativeFeeTiers();
        assertEq(t.feeRecipient, recipient);
        assertEq(t.l0, 200 * U);
        assertEq(t.l1, 1000 * U);
        assertEq(t.l2, 5000 * U);
        assertEq(t.f0, 2.5 ether);
        assertEq(t.f1, 12 ether);
        assertEq(t.f2, 50 ether);
        assertEq(t.f3, 120 ether);
        vm.prank(admin);
        bridge.disableNativeFee();
        t = bridge.nativeFeeTiers();
        assertEq(t.f0 + t.f1 + t.f2 + t.f3, 0); // off
        assertEq(t.feeRecipient, recipient);
        assertEq(t.l1, 1000 * U); // limits are kept
    }

    function test_disableThenReenableRestoresTheTable() public {
        _set();
        vm.prank(admin);
        bridge.disableNativeFee();
        assertEq(bridge.quoteNativeFee(300 * U), 0);
        _set(); // a new timelock round
        assertEq(bridge.quoteNativeFee(300 * U), 12 ether);
        assertEq(bridge.quoteNativeFee(6000 * U), 120 ether);
    }

    function test_firstTierBoundaryZeroMakesTierZeroUnreachable() public {
        WantosBridgeV2.FeeStorage memory c = _cfg(_fees(), recipient);
        c.l0 = 0;
        _viaTimelock(address(bridge), abi.encodeCall(WantosBridgeV2.setNativeFeeTiers, (c)));
        assertEq(bridge.quoteNativeFee(0), 12 ether); // amount < 0 never holds: tier 0 is dead, nothing breaks
        assertEq(bridge.quoteNativeFee(1), 12 ether);
    }

    function test_recipientCannotReenterBridgeOut() public {
        ReenteringBridgeRecipient rr = new ReenteringBridgeRecipient(bridge);
        _viaTimelock(address(bridge), abi.encodeCall(WantosBridgeV2.setNativeFeeTiers, (_cfg(_fees(), address(rr)))));
        vm.prank(alice);
        bridge.bridgeOut{value: 12 ether}(300 * U);
        assertTrue(rr.attempted());
        assertEq(bytes4(rr.caught()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(bridge.orderNonce(), 1);
        assertEq(address(rr).balance, 12 ether);
    }

    // ---- the real rollout path on WANTOS: ONE timelock batch [upgradeToAndCall, setNativeFeeTiers] ----

    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function _impl() internal view returns (address) {
        return address(uint160(uint256(vm.load(address(bridge), IMPL_SLOT))));
    }

    function _batch(address newImpl)
        internal
        returns (address[] memory t, uint256[] memory v, bytes[] memory p, bytes32 salt)
    {
        t = new address[](2);
        v = new uint256[](2);
        p = new bytes[](2);
        t[0] = address(bridge);
        t[1] = address(bridge);
        p[0] = abi.encodeCall(bridge.upgradeToAndCall, (newImpl, ""));
        p[1] = abi.encodeCall(WantosBridgeV2.setNativeFeeTiers, (_cfg(_fees(), recipient)));
        salt = bytes32(uint256(0xBA7C5));
        vm.prank(tl.adminWallet());
        tl.scheduleBatch(t, v, p, bytes32(0), salt, 48 hours);
    }

    function test_batch_upgradeThenTiers_bothApplied() public {
        address newImpl = address(new WantosBridgeV2());
        (address[] memory t, uint256[] memory v, bytes[] memory p, bytes32 salt) = _batch(newImpl);
        vm.warp(block.timestamp + 48 hours);
        tl.executeBatch(t, v, p, bytes32(0), salt);
        assertEq(_impl(), newImpl);
        assertEq(bridge.quoteNativeFee(300 * U), 12 ether);
        assertEq(bridge.nativeFeeTiers().feeRecipient, recipient);
    }

    function test_batch_whilePaused_wholeBatchReverts_upgradeNotApplied() public {
        address old = _impl();
        address newImpl = address(new WantosBridgeV2());
        (address[] memory t, uint256[] memory v, bytes[] memory p, bytes32 salt) = _batch(newImpl);
        vm.prank(pauser);
        bridge.pause();
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        tl.executeBatch(t, v, p, bytes32(0), salt);
        assertEq(_impl(), old);
        assertEq(bridge.quoteNativeFee(300 * U), 0);
    }

    function test_batch_afterExpiry_reverts() public {
        address old = _impl();
        (address[] memory t, uint256[] memory v, bytes[] memory p, bytes32 salt) = _batch(address(new WantosBridgeV2()));
        bytes32 id = tl.hashOperationBatch(t, v, p, bytes32(0), salt);
        vm.warp(block.timestamp + 48 hours + 14 days + 1);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.OperationExpired.selector, id));
        tl.executeBatch(t, v, p, bytes32(0), salt);
        assertEq(_impl(), old);
    }

    function test_storageMatchesLayoutSnapshot() public {
        string memory j = vm.readFile("contracts/test/layout/NativeFee.namespace.json");
        uint256 base = vm.parseJsonUint(j, ".base");
        assertEq(
            bytes32(base),
            keccak256(abi.encode(uint256(keccak256("wantos.bridge.v2.NativeFee")) - 1)) & ~bytes32(uint256(0xff))
        );
        assertEq(vm.parseJsonKeys(j, ".fields").length, 8);
        _set();
        string[8] memory names = ["feeRecipient", "l0", "l1", "l2", "f0", "f1", "f2", "f3"];
        uint256[8] memory want = [
            uint256(uint160(recipient)), 200 * U, 1000 * U, 5000 * U, 2.5 ether, 12 ether, 50 ether, 120 ether
        ];
        for (uint256 i; i < 8; ++i) {
            uint256 slot = vm.parseJsonUint(j, string.concat(".fields.", names[i], ".slot"));
            assertEq(uint256(vm.load(address(bridge), bytes32(base + slot))), want[i], names[i]);
        }
    }
}
