// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {W} from "./utils/Windows.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {BscFixture} from "./utils/Fixtures.sol";
import {BridgeBase} from "../src/BridgeBase.sol";
import {BridgeTimelock} from "../src/BridgeTimelock.sol";
import {BscVaultV2} from "../src/BscVaultV2.sol";
import {ReentrantToken} from "./mocks/MockToken.sol";
import {BscVaultV2Next, NotUups} from "./mocks/UpgradeMocks.sol";

/// @notice DESIGN.md §5.6 invariants 1-9, 12-14 on the BSC vault (10, 11 and the WANTOS halves of 1/3 live in
///         WantosInvariants.t.sol). Every invariant has at least one positive (allowed path works) and one
///         negative (forbidden path reverts) test, named test_invNN_pos_* / test_invNN_neg_*.
contract BscInvariantsTest is BscFixture {
    function setUp() public {
        _deployBsc();
    }

    // ---------------------------------------------------------------- 1. empty whitelist => no payout
    function test_inv01_neg_emptyWhitelistNoPayout() public {
        vm.startPrank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotWhitelisted.selector, alice));
        vault.release(1, alice, 1 * U);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotWhitelisted.selector, alice));
        vault.queueRelease(1, alice, 1 * U);
        vm.stopPrank();
    }

    function test_inv01_pos_whitelistedGetsPaid() public {
        _applyBatch(vault, _one(alice), true);
        vm.prank(relayer);
        vault.release(1, alice, 1 * U);
        assertEq(token.balanceOf(alice), 1 * U);
    }

    // ---------------------------------------------------------------- 2. one eventKey: pay once XOR void once
    function test_inv02_pos_payOnce() public {
        _applyBatch(vault, _one(alice), true);
        vm.prank(relayer);
        vault.release(1, alice, 1 * U);
        assertEq(_status(1), 2);
    }

    function test_inv02_neg_noSecondPayNoVoidAfterPay_noPayAfterVoid() public {
        _applyBatch(vault, _two(alice, bob), true); // bob whitelisted so the revert is about the key, not the list
        bytes32 k1 = _key(1);
        bytes32 k2 = _key(2);
        vm.startPrank(relayer);
        vault.release(1, alice, 1 * U);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, k1, uint8(2)));
        vault.release(1, bob, 1 * U); // different recipient, same key
        vm.stopPrank();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, k1, uint8(2)));
        vault.voidSource(1);
        vm.prank(admin);
        vault.voidSource(2);
        vm.startPrank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, k2, uint8(3)));
        vault.release(2, alice, 1 * U);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, k2, uint8(3)));
        vault.queueRelease(2, alice, 1 * U);
        vm.stopPrank();
    }

    function test_inv02_neg_queuedThenVoidedCannotExecute() public {
        _applyBatch(vault, _one(alice), true);
        vm.prank(relayer);
        vault.queueRelease(1, alice, 1_500 * U);
        vm.prank(wl);
        vault.cancelRelease(1);
        vm.warp(block.timestamp + 12 hours);
        bytes32 k1 = _key(1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, k1, uint8(3)));
        vault.executeRelease(1);
        assertEq(token.balanceOf(alice), 0);
    }

    // ---------------------------------------------------------------- 3. daily caps (+ fuzz)
    function test_inv03_pos_upToCapsAllowed() public {
        _applyBatch(vault, _two(alice, bob), true);
        vm.startPrank(relayer);
        vault.queueRelease(1, alice, 2_000 * U);
        vault.queueRelease(2, bob, 2_000 * U);
        vm.stopPrank();
        assertEq(vault.dailyUsed(vault.currentDay()), 4_000 * U);
    }

    function test_inv03_neg_globalPerAddrAndDepositRefundCounted() public {
        _applyBatch(vault, _sorted(_two(alice, bob)), true);
        vm.startPrank(relayer);
        vault.queueRelease(1, alice, 2_000 * U);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeBase.AddrDailyCapExceeded.selector, alice, 2_000 * U + 1, 2_000 * U)
        );
        vault.release(2, alice, 1); // per-address
        vault.queueRelease(3, bob, 2_000 * U);
        vm.stopPrank();
        // deposit refund of 1,001 would push global over 5,000
        token.mint(carol, 1_001 * U);
        vm.startPrank(carol);
        token.approve(address(vault), 1_001 * U);
        uint256 n = vault.deposit(1_001 * U, carol);
        vm.stopPrank();
        vm.prank(admin);
        vault.requestDepositRefund(n);
        vm.warp(block.timestamp + 1 days);
        // new UTC day after warp, so used resets; re-fill to 4,000 today then try
        vm.startPrank(relayer);
        vault.queueRelease(4, alice, 2_000 * U);
        vault.queueRelease(5, bob, 2_000 * U);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.DailyCapExceeded.selector, 5_001 * U, 5_000 * U));
        vault.executeDepositRefund(n);
    }

    // model for the quota fuzz (storage to avoid stack-too-deep)
    mapping(uint256 => uint256) mDay;
    mapping(uint256 => mapping(address => uint256)) mAddr;

    struct Q {
        uint256 nonce;
        uint256 day;
        address user;
        uint256 amt;
    }

    Q[] mQueued;
    uint256 mNonce;

    /// Fuzzed op sequences over several UTC days: per-day global and per-address usage always equal
    /// the model and never exceed caps; voids refund same-day quota only.
    function testFuzz_inv03_quotaAccounting(uint256[24] calldata seeds) public {
        address[] memory us = new address[](3);
        us[0] = alice;
        us[1] = bob;
        us[2] = carol;
        _applyBatch(vault, us, true);
        for (uint256 i; i < seeds.length; ++i) {
            uint256 s = seeds[i];
            uint256 op = s % 4;
            if (op == 3) {
                vm.warp(block.timestamp + (s >> 8) % 20 hours);
            } else if (op == 2) {
                _fuzzVoid(s);
            } else {
                _fuzzPay(op == 0, us[(s >> 16) % 3], bound(s >> 32, 1, 2_000) * U);
            }
        }
    }

    function _fuzzVoid(uint256 s) internal {
        if (mQueued.length == 0) return;
        Q storage q = mQueued[(s >> 8) % mQueued.length];
        if (q.nonce == 0) return;
        vm.prank(wl);
        vault.cancelRelease(q.nonce);
        uint256 d = vault.currentDay();
        if (q.day == d) {
            mDay[d] -= q.amt;
            mAddr[d][q.user] -= q.amt;
        }
        q.nonce = 0;
        _check(d, q.user);
    }

    function _fuzzPay(bool immediate, address u, uint256 amt) internal {
        uint256 d = vault.currentDay();
        uint256 nonce = ++mNonce;
        bool fits = mDay[d] + amt <= 5_000 * U && mAddr[d][u] + amt <= 2_000 * U;
        vm.prank(relayer);
        if (!fits) {
            if (mDay[d] + amt > 5_000 * U) {
                vm.expectRevert(abi.encodeWithSelector(BridgeBase.DailyCapExceeded.selector, mDay[d] + amt, 5_000 * U));
            } else {
                vm.expectRevert(
                    abi.encodeWithSelector(BridgeBase.AddrDailyCapExceeded.selector, u, mAddr[d][u] + amt, 2_000 * U)
                );
            }
        }
        if (immediate && amt <= 1_000 * U) {
            vault.release(nonce, u, amt);
        } else {
            vault.queueRelease(nonce, u, amt);
            if (fits) mQueued.push(Q(nonce, d, u, amt));
        }
        if (fits) {
            mDay[d] += amt;
            mAddr[d][u] += amt;
        }
        _check(d, u);
    }

    function _check(uint256 d, address u) internal view {
        assertEq(vault.dailyUsed(d), mDay[d]);
        assertLe(vault.dailyUsed(d), 5_000 * U);
        assertEq(vault.addrDailyUsed(d, u), mAddr[d][u]);
        assertLe(vault.addrDailyUsed(d, u), 2_000 * U);
    }

    // ---------------------------------------------------------------- 4. A-class only via timelock
    function test_inv04_pos_executesAfter48h() public {
        _viaTimelock(address(vault), abi.encodeCall(BridgeBase.withdraw, (bob, 1 * U)));
        assertEq(token.balanceOf(bob), 1 * U);
    }

    function test_inv04_neg_directCallsRejected() public {
        BscVaultV2.Params memory p = _bscParams();
        p.dailyCap = 6_000 * U;
        address next = address(new BscVaultV2Next());
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTimelock.selector, admin));
        vault.withdraw(admin, 1);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTightening.selector, 0));
        vault.setParams(p); // loosening by admin
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTimelock.selector, admin));
        vault.upgradeToAndCall(next, "");
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTimelock.selector, admin));
        vault.grantRole(keccak256("RELAYER_ROLE"), makeAddr("r2"));
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockUnauthorizedCaller.selector, admin));
        tl.transferAdmin(makeAddr("a2"));
        vm.stopPrank();
    }

    function test_inv04_neg_before48hAndAfterExpiry() public {
        bytes memory data = abi.encodeCall(BridgeBase.withdraw, (bob, 1 * U));
        bytes32 salt = _propose(address(vault), data);
        bytes32 id = tl.hashOperation(address(vault), 0, data, 0, salt);
        vm.warp(block.timestamp + W.TL_MIN_DELAY - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                TimelockController.TimelockUnexpectedOperationState.selector, id, bytes32(uint256(1) << 2)
            )
        ); // expected state: Ready
        _execute(address(vault), data, salt);
        vm.warp(block.timestamp + 1 + W.TL_EXPIRY + 1);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.OperationExpired.selector, id));
        _execute(address(vault), data, salt);
    }

    function test_inv04_mixed_pausedUpgradeOkButWithdrawAndLoosenNot() public {
        BscVaultV2Next next = new BscVaultV2Next();
        bytes memory up = abi.encodeCall(vault.upgradeToAndCall, (address(next), ""));
        bytes memory wd = abi.encodeCall(BridgeBase.withdraw, (bob, 1 * U));
        BscVaultV2.Params memory p = _bscParams();
        p.dailyCap = 6_000 * U;
        bytes memory ls = abi.encodeCall(BscVaultV2.setParams, (p));
        bytes memory gr = abi.encodeCall(IAccessControl.grantRole, (vault.RELAYER_ROLE(), makeAddr("r2")));
        bytes32 s1 = _propose(address(vault), up);
        bytes32 s2 = _propose(address(vault), wd);
        bytes32 s3 = _propose(address(vault), ls);
        bytes32 s4 = _propose(address(vault), gr);
        vm.warp(block.timestamp + W.TL_MIN_DELAY);
        vm.prank(pauser);
        vault.pause();
        _execute(address(vault), up, s1); // upgrade OK while paused
        assertEq(BscVaultV2Next(address(vault)).version(), "v2.1");
        _execute(address(vault), gr, s4); // key grant OK while paused
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        _execute(address(vault), wd, s2);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        _execute(address(vault), ls, s3);
    }

    function test_inv04_neg_nothingExecutesDuringRecovery() public {
        bytes memory up = abi.encodeCall(vault.upgradeToAndCall, (address(new BscVaultV2Next()), ""));
        bytes32 s1 = _propose(address(vault), up);
        vm.warp(block.timestamp + W.TL_MIN_DELAY);
        vm.prank(wl);
        tl.startAdminRecovery(makeAddr("admin2"));
        vm.expectRevert(BridgeTimelock.RecoveryInProgress.selector);
        _execute(address(vault), up, s1);
    }

    /// B4: the target is the timelock itself (transferAdmin has no bridge-side recovery guard), so only the
    /// timelock's own pre-execution recovery check can produce RecoveryInProgress here. With that check removed
    /// the call would instead fail later with BridgeCheckFailed (A1 self-check) - a different error.
    function test_inv04_neg_timelockLayerRejectsDuringWhitelistRecovery() public {
        bytes memory data = abi.encodeCall(BridgeTimelock.transferAdmin, (makeAddr("admin2")));
        bytes32 salt = _propose(address(tl), data);
        vm.warp(block.timestamp + W.TL_MIN_DELAY);
        vm.prank(admin);
        vault.startWhitelistRecovery(makeAddr("wl2"));
        vm.expectRevert(BridgeTimelock.RecoveryInProgress.selector);
        _execute(address(tl), data, salt);
        assertEq(tl.pendingAdmin(), address(0));
        // after the recovery is cancelled the same proposal executes
        vm.prank(wl);
        vault.cancelWhitelistRecovery();
        _execute(address(tl), data, salt);
        assertEq(tl.pendingAdmin(), makeAddr("admin2"));
    }

    function test_inv04_neg_oldHolderCancelRejected() public {
        bytes memory data = abi.encodeCall(BridgeBase.withdraw, (bob, 1 * U));
        bytes32 salt = _propose(address(vault), data);
        bytes32 id = tl.hashOperation(address(vault), 0, data, 0, salt);
        address wl2 = makeAddr("wl2");
        vm.prank(admin);
        vault.startWhitelistRecovery(wl2);
        vm.warp(block.timestamp + W.WL_RECOVERY);
        vm.prank(wl2);
        vault.acceptWhitelistRecovery();
        vm.prank(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.NotCanceller.selector, wl));
        tl.cancel(id);
    }

    // ---------------------------------------------------------------- 5. keys distinct, one proposer, admin=timelock
    function test_inv05_pos_distinctKeysAccepted() public {
        _viaTimelock(address(vault), abi.encodeCall(IAccessControl.grantRole, (vault.PAUSER_ROLE(), makeAddr("p2"))));
        assertTrue(vault.hasRole(vault.PAUSER_ROLE(), makeAddr("p2")));
    }

    function test_inv05_neg_duplicateKeysAndExtraProposerAndDefaultAdmin() public {
        bytes memory g = abi.encodeCall(IAccessControl.grantRole, (vault.RELAYER_ROLE(), wl));
        bytes32 s = _propose(address(vault), g);
        bytes memory p = abi.encodeCall(IAccessControl.grantRole, (tl.PROPOSER_ROLE(), wl));
        bytes32 s2 = _propose(address(tl), p);
        bytes memory d = abi.encodeCall(IAccessControl.grantRole, (bytes32(0), admin));
        bytes32 s3 = _propose(address(vault), d);
        vm.warp(block.timestamp + W.TL_MIN_DELAY);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.KeyConflict.selector, wl));
        _execute(address(vault), g, s);
        vm.expectRevert(BridgeTimelock.RoleChangeForbidden.selector);
        _execute(address(tl), p, s2);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.InvalidRole.selector, bytes32(0)));
        _execute(address(vault), d, s3);
        vm.prank(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.KeyConflict.selector, admin));
        vault.beginWhitelistManagerTransfer(admin);
    }

    function _raw(bytes memory callData) internal view returns (bytes memory ret) {
        bool ok;
        (ok, ret) = address(vault).staticcall(callData);
        require(ok, "snapshot call failed");
    }

    function _snapshot(uint256 day) internal view returns (bytes memory) {
        return bytes.concat(
            abi.encode(vault.whitelisted(alice), vault.whitelisted(bob), vault.whitelistNonce()),
            _raw(abi.encodeCall(BridgeBase.payouts, (_key(1)))),
            _raw(abi.encodeCall(BridgeBase.payouts, (_key(2)))),
            _raw(abi.encodeCall(BscVaultV2.deposits, (1))),
            abi.encode(vault.dailyUsed(day), vault.addrDailyUsed(day, bob), vault.params()),
            abi.encode(vault.whitelistManager(), vault.timelock(), vault.whitelistFrozen())
        );
    }

    // ---------------------------------------------------------------- 6. upgrade preserves state
    function test_inv06_pos_upgradePreservesState() public {
        _applyBatch(vault, _two(alice, bob), true);
        vm.startPrank(relayer);
        vault.release(1, alice, 500 * U);
        vault.queueRelease(2, bob, 1_500 * U);
        vm.stopPrank();
        token.mint(carol, 100 * U);
        vm.startPrank(carol);
        token.approve(address(vault), 100 * U);
        vault.deposit(100 * U, carol);
        vm.stopPrank();
        vm.prank(admin);
        vault.freezeWhitelist();
        uint256 day = vault.currentDay();
        uint256 reserve = token.balanceOf(address(vault));
        bytes memory before = _snapshot(day);
        BscVaultV2Next next = new BscVaultV2Next();
        _viaTimelock(address(vault), abi.encodeCall(vault.upgradeToAndCall, (address(next), "")));
        assertEq(BscVaultV2Next(address(vault)).version(), "v2.1");
        // warp moved us 48h: compare against the recorded day
        bytes memory afterUp = _snapshot(day);
        assertEq(keccak256(before), keccak256(afterUp));
        assertEq(token.balanceOf(address(vault)), reserve);
        // namespaced storage is pinned: first slot of the BridgeBase namespace holds the timelock
        bytes32 slot =
            keccak256(abi.encode(uint256(keccak256("wantos.bridge.v2.BridgeBase")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(address(uint160(uint256(vm.load(address(vault), slot)))), address(tl));
        // the queued payout still executes after the upgrade (once its own releaseDelay has passed)
        vm.warp(block.timestamp + 12 hours);
        vm.prank(relayer);
        vault.executeRelease(2);
        assertEq(token.balanceOf(bob), 1_500 * U);
    }

    function test_inv06_neg_nonUupsImplementationRejected() public {
        NotUups bad = new NotUups();
        bytes memory up = abi.encodeCall(vault.upgradeToAndCall, (address(bad), ""));
        bytes32 salt = _propose(address(vault), up);
        vm.warp(block.timestamp + W.TL_MIN_DELAY);
        vm.expectRevert(abi.encodeWithSelector(ERC1967Utils.ERC1967InvalidImplementation.selector, address(bad)));
        _execute(address(vault), up, salt);
    }

    // ---------------------------------------------------------------- 7. pause matrix
    function test_inv07_neg_pausedBlocksMoneyPaths() public {
        bytes4 P = PausableUpgradeable.EnforcedPause.selector;
        _applyBatch(vault, _one(alice), true);
        vm.prank(relayer);
        vault.queueRelease(10, alice, 1_500 * U);
        token.mint(carol, 100 * U);
        vm.startPrank(carol);
        token.approve(address(vault), type(uint256).max);
        uint256 n = vault.deposit(50 * U, carol);
        vm.stopPrank();
        vm.prank(admin);
        vault.requestDepositRefund(n);
        vm.warp(block.timestamp + W.REFUND_DELAY);
        vm.prank(pauser);
        vault.pause();
        vm.startPrank(relayer);
        vm.expectRevert(P);
        vault.release(1, alice, 1 * U);
        vm.expectRevert(P);
        vault.queueRelease(2, alice, 1 * U);
        vm.expectRevert(P);
        vault.executeRelease(10);
        vm.stopPrank();
        vm.prank(carol);
        vm.expectRevert(P);
        vault.deposit(50 * U, carol);
        vm.expectRevert(P);
        vault.executeDepositRefund(n);
        bytes32[] memory k = new bytes32[](1);
        k[0] = bytes32("old");
        uint256[] memory amt = new uint256[](1);
        amt[0] = 1;
        vm.prank(address(tl));
        vm.expectRevert(P);
        vault.payLegacyBatch(k, _one(bob), amt);
        vm.prank(address(tl));
        vm.expectRevert(P);
        vault.withdraw(bob, 1);
    }

    function test_inv07_pos_pausedStillAllowsDefensiveOps() public {
        _applyBatch(vault, _one(alice), true);
        vm.prank(relayer);
        vault.queueRelease(1, alice, 1 * U);
        vm.prank(pauser);
        vault.pause();
        vm.prank(admin);
        vault.cancelRelease(1);
        vm.prank(wl);
        vault.voidSource(2);
        bytes32 R = vault.RELAYER_ROLE();
        vm.prank(admin);
        vault.revokeKey(R, relayer);
        vm.prank(admin);
        vault.freezeWhitelist();
        vm.prank(admin);
        vault.emergencyRemove(_one(alice));
        _applyBatch(vault, _one(alice), false); // WL removal batch still OK
        _viaTimelock(address(vault), abi.encodeCall(IAccessControl.grantRole, (R, makeAddr("r2")))); // change keys
        assertTrue(vault.paused());
    }

    // ---------------------------------------------------------------- 8. EIP-712 batches
    function test_inv08_pos_validBatch() public {
        _applyBatch(vault, _one(alice), true);
        assertTrue(vault.whitelisted(alice));
    }

    function test_inv08_neg_replayExpiredFrozenUnsorted() public {
        address[] memory a = _one(alice);
        uint256 dl = block.timestamp + W.SIG_TTL / 24;
        bytes memory sig = _signBatch(vault, wlKey, a, true, 0, dl);
        vault.applyWhitelistBatch(a, true, 0, dl, sig);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadNonce.selector, 1, 0));
        vault.applyWhitelistBatch(a, true, 0, dl, sig); // replay
        vm.prank(admin);
        vault.freezeWhitelist();
        address[] memory b = _one(bob);
        sig = _signBatch(vault, wlKey, b, true, 1, dl);
        vm.expectRevert(BridgeBase.WhitelistWritesBlocked.selector);
        vault.applyWhitelistBatch(b, true, 1, dl, sig);
        vm.warp(dl + 1);
        sig = _signBatch(vault, wlKey, a, false, 1, dl);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.SignatureExpired.selector, dl));
        vault.applyWhitelistBatch(a, false, 1, dl, sig); // expired
    }

    // ---------------------------------------------------------------- 9. handover / recovery
    function test_inv09_pos_recoveryCompletesWhenNobodyCancels() public {
        address wl2 = makeAddr("wl2");
        vm.prank(admin);
        vault.startWhitelistRecovery(wl2);
        vm.warp(block.timestamp + W.WL_RECOVERY);
        vm.prank(wl2);
        vault.acceptWhitelistRecovery();
        assertEq(vault.whitelistManager(), wl2);
        // and the admin side: lost admin recovered by WL after 14 days
        address admin2 = makeAddr("admin2");
        vm.prank(wl2);
        tl.startAdminRecovery(admin2);
        vm.warp(block.timestamp + W.TL_ADMIN_RECOVERY);
        vm.prank(admin2);
        tl.acceptAdmin();
        assertEq(vault.adminWallet(), admin2);
        // bridge-side admin powers follow automatically
        vm.prank(admin2);
        vault.freezeWhitelist();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdmin.selector, admin));
        vault.freezeWhitelist();
    }

    function test_inv09_neg_symmetricCancelOneAtATime() public {
        vm.prank(admin);
        vault.startWhitelistRecovery(makeAddr("wl2"));
        vm.prank(wl);
        vm.expectRevert(BridgeTimelock.RecoveryInProgress.selector);
        tl.startAdminRecovery(makeAddr("admin2"));
        vm.prank(wl); // current holder cancels
        vault.cancelWhitelistRecovery();
        vm.prank(wl);
        tl.startAdminRecovery(makeAddr("admin2"));
        vm.prank(admin); // current holder cancels
        tl.cancelAdminRecovery();
        // the cancelled WL recovery put its initiator (admin) on a 3-day cooldown
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.RecoveryCooldown.selector, block.timestamp + W.WL_COOLDOWN));
        vault.startWhitelistRecovery(makeAddr("wl2"));
        // and the cancelled admin recovery put the WL side on cooldown too
        vm.prank(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.RecoveryCooldown.selector, block.timestamp + W.TL_COOLDOWN));
        tl.startAdminRecovery(makeAddr("admin2"));
    }

    // ---------------------------------------------------------------- 12. params
    function test_inv12_pos_tightenAndConstraintsHold() public {
        BscVaultV2.Params memory p = _bscParams();
        p.largeThreshold = 100 * U;
        vm.prank(admin);
        vault.setParams(p);
        BscVaultV2.Params memory q = vault.params();
        assertLe(q.largeThreshold, q.perAddrDailyCap);
        assertLe(q.perAddrDailyCap, q.dailyCap);
    }

    function test_inv12_neg_smuggledLoosenAndFloor() public {
        BscVaultV2.Params memory p = _bscParams();
        p.dailyCap = 1_000 * U;
        p.perAddrDailyCap = 1_000 * U;
        p.maxDepositPerTx = 2_001 * U; // loosen smuggled in
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTightening.selector, 5));
        vault.setParams(p);
        p = _bscParams();
        p.releaseDelay = 7 days + 1;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.ParamOutOfRange.selector, 3));
        vault.setParams(p);
    }

    /// A3: each half of `largeThreshold <= perAddrDailyCap <= dailyCap`, on both the timelock and the admin path.
    function test_inv12_neg_perAddrAboveDailyCapViaTimelock() public {
        BscVaultV2.Params memory p = _bscParams();
        p.dailyCap = 1_000 * U;
        p.perAddrDailyCap = 2_000 * U;
        p.largeThreshold = 500 * U;
        vm.prank(address(tl));
        vm.expectRevert(BridgeBase.ParamConstraint.selector);
        vault.setParams(p);
        // full timelock path as well
        bytes memory data = abi.encodeCall(BscVaultV2.setParams, (p));
        bytes32 salt = _propose(address(vault), data);
        vm.warp(block.timestamp + W.TL_MIN_DELAY);
        vm.expectRevert(BridgeBase.ParamConstraint.selector);
        _execute(address(vault), data, salt);
    }

    function test_inv12_neg_perAddrAboveDailyCapViaAdminTighten() public {
        BscVaultV2.Params memory p = _bscParams();
        p.dailyCap = 1_000 * U; // tightening dailyCap alone below perAddrDailyCap (2,000)
        vm.prank(admin);
        vm.expectRevert(BridgeBase.ParamConstraint.selector);
        vault.setParams(p);
    }

    function test_inv12_neg_thresholdAbovePerAddrViaTimelock() public {
        BscVaultV2.Params memory p = _bscParams();
        p.largeThreshold = 2_001 * U;
        vm.prank(address(tl));
        vm.expectRevert(BridgeBase.ParamConstraint.selector);
        vault.setParams(p);
    }

    function test_inv12_pos_boundaryEqualitiesAllowed() public {
        BscVaultV2.Params memory p = _bscParams();
        p.dailyCap = 2_000 * U;
        p.perAddrDailyCap = 2_000 * U;
        p.largeThreshold = 2_000 * U;
        vm.prank(address(tl));
        vault.setParams(p);
        assertEq(vault.params().dailyCap, 2_000 * U);
    }

    // ---------------------------------------------------------------- 13. queueRelease replay
    function test_inv13_pos_replayReturnsQueuedWithoutDoubleCharge() public {
        _applyBatch(vault, _one(alice), true);
        vm.startPrank(relayer);
        vault.queueRelease(1, alice, 1_200 * U);
        vm.recordLogs();
        vault.queueRelease(1, alice, 1_200 * U);
        vm.stopPrank();
        assertEq(vm.getRecordedLogs().length, 0); // no second ReleaseQueued
        assertEq(_status(1), 1);
        assertEq(vault.dailyUsed(vault.currentDay()), 1_200 * U);
    }

    function test_inv13_neg_replayWithDifferentPayloadReverts() public {
        _applyBatch(vault, _two(alice, bob), true);
        vm.startPrank(relayer);
        vault.queueRelease(1, alice, 1_200 * U);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, _key(1), uint8(1)));
        vault.queueRelease(1, bob, 1_200 * U);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- 14. legacy pays once
    function test_inv14_pos_legacyPaidOnce() public {
        bytes32[] memory k = new bytes32[](1);
        k[0] = keccak256(abi.encodePacked(bytes32("oldtx"), uint256(1)));
        uint256[] memory amt = new uint256[](1);
        amt[0] = 50 * U;
        _viaTimelock(address(vault), abi.encodeCall(BscVaultV2.payLegacyBatch, (k, _one(carol), amt)));
        assertEq(token.balanceOf(carol), 50 * U);
        assertTrue(vault.legacyPaid(k[0]));
    }

    function test_inv14_neg_legacySecondPaymentReverts() public {
        bytes32[] memory k = new bytes32[](1);
        k[0] = bytes32("x");
        uint256[] memory amt = new uint256[](1);
        amt[0] = 50 * U;
        vm.prank(address(tl));
        vault.payLegacyBatch(k, _one(carol), amt);
        vm.prank(address(tl));
        vm.expectRevert(abi.encodeWithSelector(BscVaultV2.LegacyAlreadyPaid.selector, bytes32("x")));
        vault.payLegacyBatch(k, _one(bob), amt);
    }
}

/// @notice Re-entrancy probe: a token that calls back into the vault during transfers.
contract ReentrancyTest is BscFixture {
    ReentrantToken rt;

    function setUp() public {
        _initKeys();
        vm.chainId(BSC_CHAIN);
        rt = new ReentrantToken();
        uint256 n = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), n + 2);
        tl = new BridgeTimelock(admin, predicted);
        impl = new BscVaultV2();
        bytes memory init = abi.encodeCall(
            BscVaultV2.initialize,
            (BscVaultV2.InitArgs({
                    timelock: address(tl),
                    token: address(rt),
                    whitelistManager: wl,
                    relayer: relayer,
                    pauser: pauser,
                    peerChainId: WANTOS_CHAIN,
                    peerBridge: predicted,
                    params: _bscParams()
                }))
        );
        vault = BscVaultV2(address(new ERC1967Proxy(address(impl), init)));
        rt.mint(address(vault), 10_000 * U);
    }

    function test_releaseCannotBeReentered() public {
        _applyBatch(vault, _one(alice), true);
        rt.mint(address(rt), 1 * U);
        rt.arm(address(vault), abi.encodeCall(BridgeBase.fund, (1)));
        vm.prank(relayer);
        vault.release(1, alice, 100 * U);
        assertFalse(rt.lastOk()); // nested fund() hit the reentrancy guard
        assertEq(bytes4(rt.lastRet()), ReentrancyGuardUpgradeable.ReentrancyGuardReentrantCall.selector);
        assertEq(rt.balanceOf(alice), 100 * U);
    }
}
