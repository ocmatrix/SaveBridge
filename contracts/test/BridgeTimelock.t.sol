// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {BridgeTimelock} from "../src/BridgeTimelock.sol";
import {MockBridge} from "./mocks/MockBridge.sol";

contract BridgeTimelockTest is Test {
    BridgeTimelock tl;
    MockBridge bridge;
    address admin = makeAddr("admin");
    address wl = makeAddr("wl");
    address newAdmin = makeAddr("newAdmin");
    address stranger = makeAddr("stranger");

    bytes32 PROPOSER;
    bytes32 CANCELLER;
    bytes32 EXECUTOR;

    function setUp() public {
        vm.warp(1_700_000_000);
        bridge = new MockBridge();
        tl = new BridgeTimelock(admin, address(bridge));
        bridge.setWhitelistManager(wl);
        bridge.setTimelock(address(tl));
        PROPOSER = tl.PROPOSER_ROLE();
        CANCELLER = tl.CANCELLER_ROLE();
        EXECUTOR = tl.EXECUTOR_ROLE();
    }

    // ---------- helpers ----------
    function _schedule(address target, bytes memory data, bytes32 salt) internal returns (bytes32 id) {
        id = tl.hashOperation(target, 0, data, bytes32(0), salt);
        vm.prank(admin);
        tl.schedule(target, 0, data, bytes32(0), salt, 48 hours);
    }

    function _bumpOp(bytes32 salt) internal returns (bytes32) {
        return _schedule(address(bridge), abi.encodeCall(MockBridge.bump, ()), salt);
    }

    function _execBump(bytes32 salt) internal {
        tl.execute(address(bridge), 0, abi.encodeCall(MockBridge.bump, ()), bytes32(0), salt);
    }

    function _proposeTransferAdmin(address to, bytes32 salt) internal {
        bytes memory data = abi.encodeCall(BridgeTimelock.transferAdmin, (to));
        _schedule(address(tl), data, salt);
        vm.warp(block.timestamp + 48 hours);
        tl.execute(address(tl), 0, data, bytes32(0), salt);
    }

    // ---------- spec 1: delay ----------
    function test_minDelayIsImmutable48h() public view {
        assertEq(tl.MIN_DELAY(), 48 hours);
        assertEq(tl.getMinDelay(), 48 hours);
    }

    function test_scheduleBelowMinDelayReverts() public {
        vm.prank(admin);
        vm.expectRevert();
        tl.schedule(address(bridge), 0, "", bytes32(0), bytes32(0), 48 hours - 1);
    }

    function test_updateDelayCannotGoBelowMin() public {
        bytes memory data = abi.encodeCall(TimelockController.updateDelay, (47 hours));
        _schedule(address(tl), data, bytes32("d"));
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        tl.execute(address(tl), 0, data, bytes32(0), bytes32("d"));
    }

    function test_updateDelayCanIncrease() public {
        bytes memory data = abi.encodeCall(TimelockController.updateDelay, (72 hours));
        _schedule(address(tl), data, bytes32("d"));
        vm.warp(block.timestamp + 48 hours);
        tl.execute(address(tl), 0, data, bytes32(0), bytes32("d"));
        assertEq(tl.getMinDelay(), 72 hours);
    }

    function test_updateDelayUpperBound7Days() public {
        bytes memory bad = abi.encodeCall(TimelockController.updateDelay, (7 days + 1));
        _schedule(address(tl), bad, bytes32("big"));
        bytes memory ok = abi.encodeCall(TimelockController.updateDelay, (7 days));
        _schedule(address(tl), ok, bytes32("max"));
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeTimelock.DelayAboveMaximum.selector, uint256(7 days + 1), uint256(7 days))
        );
        tl.execute(address(tl), 0, bad, bytes32(0), bytes32("big"));
        tl.execute(address(tl), 0, ok, bytes32(0), bytes32("max"));
        assertEq(tl.getMinDelay(), 7 days);
        assertEq(tl.MAX_DELAY(), 7 days);
    }

    function test_updateDelayDirectCallReverts() public {
        vm.prank(admin);
        vm.expectRevert();
        tl.updateDelay(72 hours);
    }

    // ---------- spec 2: construction ----------
    function test_constructorRoles() public view {
        assertEq(tl.adminWallet(), admin);
        assertEq(tl.bridge(), address(bridge));
        assertTrue(tl.hasRole(PROPOSER, admin));
        assertTrue(tl.hasRole(CANCELLER, admin));
        assertTrue(tl.hasRole(EXECUTOR, address(0)));
        assertTrue(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), address(tl)));
        assertFalse(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(tl.epoch(), 0);
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(BridgeTimelock.ZeroAddress.selector);
        new BridgeTimelock(address(0), address(bridge));
        vm.expectRevert(BridgeTimelock.ZeroAddress.selector);
        new BridgeTimelock(admin, address(0));
    }

    /// Constructor must not call the (not yet deployed) bridge: mutual-exclusion check is skipped.
    function test_constructorSkipsMutualExclusionWithUndeployedBridge() public {
        address predicted = makeAddr("not-yet-deployed");
        BridgeTimelock t = new BridgeTimelock(admin, predicted);
        assertEq(t.bridge(), predicted);
        assertEq(predicted.code.length, 0);
    }

    // ---------- spec 3: exactly one proposer ----------
    function test_grantRoleForbiddenEvenViaTimelock() public {
        bytes memory data = abi.encodeCall(IAccessControl.grantRole, (PROPOSER, stranger));
        _schedule(address(tl), data, bytes32("g"));
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        tl.execute(address(tl), 0, data, bytes32(0), bytes32("g"));
        assertFalse(tl.hasRole(PROPOSER, stranger));
    }

    function test_revokeRoleForbiddenEvenViaTimelock() public {
        bytes memory data = abi.encodeCall(IAccessControl.revokeRole, (PROPOSER, admin));
        _schedule(address(tl), data, bytes32("r"));
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        tl.execute(address(tl), 0, data, bytes32(0), bytes32("r"));
        assertTrue(tl.hasRole(PROPOSER, admin));
    }

    function test_renounceRoleForbidden() public {
        vm.prank(admin);
        vm.expectRevert(BridgeTimelock.RoleChangeForbidden.selector);
        tl.renounceRole(PROPOSER, admin);
    }

    function test_onlyAdminCanSchedule() public {
        vm.prank(wl);
        vm.expectRevert();
        tl.schedule(address(bridge), 0, "", bytes32(0), bytes32(0), 48 hours);
    }

    // ---------- spec 4: cancel ----------
    function test_cancelByAdmin() public {
        bytes32 id = _bumpOp("a");
        vm.prank(admin);
        tl.cancel(id);
        assertFalse(tl.isOperation(id));
    }

    function test_cancelByWhitelistManagerRuntime() public {
        bytes32 id = _bumpOp("a");
        vm.prank(wl);
        tl.cancel(id);
        assertFalse(tl.isOperation(id));
    }

    function test_cancelFollowsWhitelistManagerChange() public {
        bytes32 id = _bumpOp("a");
        address wl2 = makeAddr("wl2");
        bridge.setWhitelistManager(wl2);
        vm.prank(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.NotCanceller.selector, wl));
        tl.cancel(id);
        vm.prank(wl2);
        tl.cancel(id);
    }

    function test_cancelByStrangerReverts() public {
        bytes32 id = _bumpOp("a");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.NotCanceller.selector, stranger));
        tl.cancel(id);
    }

    // ---------- spec 5: transferAdmin ----------
    function test_transferAdminOnlySelf() public {
        vm.prank(admin);
        vm.expectRevert();
        tl.transferAdmin(newAdmin);
    }

    function test_transferAdminFlowMigratesProposer() public {
        _proposeTransferAdmin(newAdmin, "t");
        assertEq(tl.pendingAdmin(), newAdmin);
        assertEq(tl.adminWallet(), admin);
        vm.prank(newAdmin);
        tl.acceptAdmin();
        assertEq(tl.adminWallet(), newAdmin);
        assertEq(tl.pendingAdmin(), address(0));
        assertTrue(tl.hasRole(PROPOSER, newAdmin));
        assertTrue(tl.hasRole(CANCELLER, newAdmin));
        assertFalse(tl.hasRole(PROPOSER, admin));
        assertFalse(tl.hasRole(CANCELLER, admin));
        assertEq(tl.epoch(), 0);
    }

    function test_oldAdminCannotCancelOrProposeAfterTransfer() public {
        bytes32 id = _bumpOp("x");
        _proposeTransferAdmin(newAdmin, "t");
        vm.prank(newAdmin);
        tl.acceptAdmin();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.NotCanceller.selector, admin));
        tl.cancel(id);
        vm.prank(admin);
        vm.expectRevert();
        tl.schedule(address(bridge), 0, "", bytes32(0), bytes32("z"), 48 hours);
        vm.prank(newAdmin);
        tl.cancel(id);
    }

    function test_acceptAdminWrongCallerReverts() public {
        _proposeTransferAdmin(newAdmin, "t");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.NotPendingAdmin.selector, stranger));
        tl.acceptAdmin();
    }

    function test_acceptAdminExpiresAfter7Days() public {
        _proposeTransferAdmin(newAdmin, "t");
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(newAdmin);
        vm.expectRevert(BridgeTimelock.PendingAdminExpired.selector);
        tl.acceptAdmin();
    }

    function test_transferAdminRejectsZeroSelfAndKeyHolder() public {
        bytes memory d0 = abi.encodeCall(BridgeTimelock.transferAdmin, (address(0)));
        _schedule(address(tl), d0, "0");
        bytes memory d1 = abi.encodeCall(BridgeTimelock.transferAdmin, (admin));
        _schedule(address(tl), d1, "1");
        bytes memory d2 = abi.encodeCall(BridgeTimelock.transferAdmin, (wl));
        _schedule(address(tl), d2, "2");
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        tl.execute(address(tl), 0, d0, bytes32(0), "0");
        vm.expectRevert();
        tl.execute(address(tl), 0, d1, bytes32(0), "1");
        vm.expectRevert();
        tl.execute(address(tl), 0, d2, bytes32(0), "2");
    }

    function test_acceptAdminRechecksKeyConflict() public {
        _proposeTransferAdmin(newAdmin, "t");
        bridge.setKeyHolder(newAdmin, true); // became relayer meanwhile
        vm.prank(newAdmin);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.KeyConflict.selector, newAdmin));
        tl.acceptAdmin();
    }

    function test_transferAdminBlockedWhilePaused() public {
        bytes memory data = abi.encodeCall(BridgeTimelock.transferAdmin, (newAdmin));
        _schedule(address(tl), data, "p");
        vm.warp(block.timestamp + 48 hours);
        bridge.setPaused(true);
        vm.expectRevert();
        tl.execute(address(tl), 0, data, bytes32(0), "p");
    }

    function test_acceptAdminBlockedDuringWhitelistRecovery() public {
        _proposeTransferAdmin(newAdmin, "t");
        bridge.setWhitelistRecoveryActive(true);
        vm.prank(newAdmin);
        vm.expectRevert(BridgeTimelock.RecoveryInProgress.selector);
        tl.acceptAdmin();
    }

    // ---------- spec 6: expiry ----------
    function test_executeWithinGrace() public {
        _bumpOp("e");
        vm.warp(block.timestamp + 48 hours + 14 days);
        _execBump("e");
        assertEq(bridge.counter(), 1);
    }

    function test_executeAfterExpiryRevertsAndNeedsNewSalt() public {
        bytes32 id = _bumpOp("e");
        assertFalse(tl.isOperationExpired(id));
        vm.warp(block.timestamp + 48 hours + 14 days + 1);
        assertTrue(tl.isOperationExpired(id));
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.OperationExpired.selector, id));
        _execBump("e");
        // same salt cannot be re-proposed
        vm.prank(admin);
        vm.expectRevert();
        tl.schedule(address(bridge), 0, abi.encodeCall(MockBridge.bump, ()), bytes32(0), "e", 48 hours);
        // new salt works
        _bumpOp("e2");
        vm.warp(block.timestamp + 48 hours);
        _execBump("e2");
        assertEq(bridge.counter(), 1);
    }

    function test_notReadyBefore48h() public {
        _bumpOp("n");
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert();
        _execBump("n");
    }

    function test_isOperationExpiredFalseForUnsetAndDone() public {
        assertFalse(tl.isOperationExpired(bytes32("nope")));
        bytes32 id = _bumpOp("d");
        vm.warp(block.timestamp + 48 hours);
        _execBump("d");
        vm.warp(block.timestamp + 30 days);
        assertFalse(tl.isOperationExpired(id));
    }

    function test_executeBatchChecksExpiry() public {
        address[] memory t = new address[](1);
        t[0] = address(bridge);
        uint256[] memory v = new uint256[](1);
        bytes[] memory p = new bytes[](1);
        p[0] = abi.encodeCall(MockBridge.bump, ());
        bytes32 id = tl.hashOperationBatch(t, v, p, bytes32(0), "b");
        vm.prank(admin);
        tl.scheduleBatch(t, v, p, bytes32(0), "b", 48 hours);
        assertEq(tl.proposalEpoch(id), 0);
        vm.warp(block.timestamp + 48 hours + 14 days + 1);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.OperationExpired.selector, id));
        tl.executeBatch(t, v, p, bytes32(0), "b");
    }

    function test_executeBatchHappy() public {
        address[] memory t = new address[](2);
        t[0] = address(bridge);
        t[1] = address(bridge);
        uint256[] memory v = new uint256[](2);
        bytes[] memory p = new bytes[](2);
        p[0] = abi.encodeCall(MockBridge.bump, ());
        p[1] = p[0];
        vm.prank(admin);
        tl.scheduleBatch(t, v, p, bytes32(0), "b", 48 hours);
        vm.warp(block.timestamp + 48 hours);
        tl.executeBatch(t, v, p, bytes32(0), "b");
        assertEq(bridge.counter(), 2);
    }

    // ---------- recovery blocks execution ----------
    function test_executeBlockedDuringBridgeWhitelistRecovery() public {
        _bumpOp("w");
        vm.warp(block.timestamp + 48 hours);
        bridge.setWhitelistRecoveryActive(true);
        vm.expectRevert(BridgeTimelock.RecoveryInProgress.selector);
        _execBump("w");
        bridge.setWhitelistRecoveryActive(false);
        _execBump("w");
    }

    function test_executeBlockedDuringAdminRecovery() public {
        _bumpOp("w");
        vm.warp(block.timestamp + 48 hours);
        vm.prank(wl);
        tl.startAdminRecovery(newAdmin);
        vm.expectRevert(BridgeTimelock.RecoveryInProgress.selector);
        _execBump("w");
    }

    // ---------- spec 7/recovery ----------
    function test_adminRecoveryHappyPathBumpsEpochAndKillsOldProposals() public {
        bytes32 id = _bumpOp("old");
        vm.prank(wl);
        tl.startAdminRecovery(newAdmin);
        assertTrue(tl.adminRecoveryActive());
        assertEq(tl.adminRecoveryCandidate(), newAdmin);
        vm.warp(block.timestamp + 14 days - 1);
        vm.prank(newAdmin);
        vm.expectRevert();
        tl.acceptAdmin();
        vm.warp(block.timestamp + 1);
        vm.prank(newAdmin);
        tl.acceptAdmin();
        assertEq(tl.adminWallet(), newAdmin);
        assertEq(tl.epoch(), 1);
        assertFalse(tl.adminRecoveryActive());
        assertTrue(tl.hasRole(PROPOSER, newAdmin));
        assertFalse(tl.hasRole(PROPOSER, admin));
        // old proposal (epoch 0) is dead even though Ready
        assertTrue(tl.isOperationReady(id));
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.OperationStaleEpoch.selector, id));
        _execBump("old");
        // new proposals work
        vm.prank(newAdmin);
        tl.schedule(address(bridge), 0, abi.encodeCall(MockBridge.bump, ()), bytes32(0), "new", 48 hours);
        vm.warp(block.timestamp + 48 hours);
        _execBump("new");
        assertEq(bridge.counter(), 1);
    }

    function test_startAdminRecoveryOnlyWhitelistManager() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.NotWhitelistManager.selector, admin));
        tl.startAdminRecovery(newAdmin);
    }

    function test_startAdminRecoveryRejectsBadCandidates() public {
        vm.startPrank(wl);
        vm.expectRevert(BridgeTimelock.ZeroAddress.selector);
        tl.startAdminRecovery(address(0));
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.InvalidNewAdmin.selector, admin));
        tl.startAdminRecovery(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.KeyConflict.selector, wl));
        tl.startAdminRecovery(wl);
        vm.stopPrank();
    }

    function test_adminRecoveryVoidsPendingAdmin() public {
        _proposeTransferAdmin(makeAddr("pending"), "t");
        vm.prank(wl);
        tl.startAdminRecovery(newAdmin);
        assertEq(tl.pendingAdmin(), address(0));
        vm.prank(makeAddr("pending"));
        vm.expectRevert();
        tl.acceptAdmin();
    }

    function test_adminRecoveryCancelByCurrentAdminAndCooldown() public {
        vm.prank(wl);
        tl.startAdminRecovery(newAdmin);
        vm.prank(admin);
        tl.cancelAdminRecovery();
        assertFalse(tl.adminRecoveryActive());
        vm.prank(wl);
        vm.expectRevert();
        tl.startAdminRecovery(newAdmin);
        vm.warp(block.timestamp + 3 days);
        vm.prank(wl);
        tl.startAdminRecovery(newAdmin);
        assertTrue(tl.adminRecoveryActive());
    }

    function test_adminRecoveryCancelByWhitelistManager() public {
        vm.prank(wl);
        tl.startAdminRecovery(newAdmin);
        vm.prank(wl);
        tl.cancelAdminRecovery();
        assertFalse(tl.adminRecoveryActive());
    }

    function test_adminRecoveryCancelByStrangerReverts() public {
        vm.prank(wl);
        tl.startAdminRecovery(newAdmin);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.NotCanceller.selector, stranger));
        tl.cancelAdminRecovery();
        vm.prank(admin);
        tl.cancelAdminRecovery();
        vm.prank(admin);
        vm.expectRevert(BridgeTimelock.NoRecovery.selector);
        tl.cancelAdminRecovery();
    }

    function test_onlyOneAdminRecoveryAtATime() public {
        vm.prank(wl);
        tl.startAdminRecovery(newAdmin);
        vm.prank(wl);
        vm.expectRevert(BridgeTimelock.RecoveryInProgress.selector);
        tl.startAdminRecovery(makeAddr("other"));
    }

    function test_adminRecoveryBlockedWhileWhitelistRecoveryActive() public {
        bridge.setWhitelistRecoveryActive(true);
        vm.prank(wl);
        vm.expectRevert(BridgeTimelock.RecoveryInProgress.selector);
        tl.startAdminRecovery(newAdmin);
    }

    function test_adminRecoveryAcceptRechecksConflict() public {
        vm.prank(wl);
        tl.startAdminRecovery(newAdmin);
        bridge.setKeyHolder(newAdmin, true);
        vm.warp(block.timestamp + 14 days);
        vm.prank(newAdmin);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.KeyConflict.selector, newAdmin));
        tl.acceptAdmin();
    }

    function test_adminRecoveryNoExpiryCompletesLate() public {
        vm.prank(wl);
        tl.startAdminRecovery(newAdmin);
        vm.warp(block.timestamp + 60 days);
        vm.prank(newAdmin);
        tl.acceptAdmin();
        assertEq(tl.adminWallet(), newAdmin);
    }

    function test_cancelOfScheduledOpAllowedDuringRecovery() public {
        bytes32 id = _bumpOp("c");
        vm.prank(wl);
        tl.startAdminRecovery(newAdmin);
        vm.prank(wl);
        tl.cancel(id);
        assertFalse(tl.isOperation(id));
    }
}
