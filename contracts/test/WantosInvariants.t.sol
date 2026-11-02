// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {W} from "./utils/Windows.sol";
import {WantosFixture} from "./utils/WantosFixture.sol";
import {BridgeBase} from "../src/BridgeBase.sol";
import {WantosBridgeV2} from "../src/WantosBridgeV2.sol";
import {WantosBridgeV2Next} from "./mocks/UpgradeMocks.sol";

/// @notice DESIGN.md §5.6 invariants on the WANTOS bridge: 1 (bridgeOut half), 3 (b2wDailyCap half),
///         6 (orders survive upgrade), 10 (supply ceiling), 11 (refund target and eventKey).
contract WantosInvariantsTest is WantosFixture {
    function setUp() public {
        _deployWantos();
        _fundUser(alice, 10_000 * U);
        _fundUser(bob, 10_000 * U);
    }

    // 1 ------------------------------------------------------------------
    function test_inv01_neg_emptyWhitelistNoBridgeOut() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotWhitelisted.selector, alice));
        bridge.bridgeOut(100 * U);
    }

    function test_inv01_pos_whitelistedCanBridgeOut() public {
        _applyBatch(bridge, _one(alice), true);
        vm.prank(alice);
        assertEq(bridge.bridgeOut(100 * U), 1);
    }

    // 3 ------------------------------------------------------------------
    function test_inv03_pos_b2wUpToCap() public {
        vm.startPrank(relayer);
        bridge.queueRelease(1, carol, 1_500 * U);
        bridge.queueRelease(2, carol, 1_500 * U);
        vm.stopPrank();
        assertEq(bridge.dailyUsed(bridge.currentDay()), 3_000 * U);
    }

    function test_inv03_neg_b2wIncludingRefundExecutionCapped() public {
        _applyBatch(bridge, _one(alice), true);
        vm.prank(alice);
        uint256 id = bridge.bridgeOut(1_000 * U);
        vm.prank(admin);
        bridge.requestRefund(id);
        vm.warp(block.timestamp + W.REFUND_DELAY);
        vm.prank(relayer);
        bridge.queueRelease(1, carol, 2_500 * U);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.DailyCapExceeded.selector, 3_500 * U, 3_000 * U));
        bridge.executeRefund(id);
    }

    /// Fuzz: inbound queue / cancel sequences across UTC days; usage always equals the model, never exceeds
    /// b2wDailyCap, and cancelling a same-day queued release returns its quota (B3d).
    mapping(uint256 => uint256) mUsed;
    uint256[] qNonce;
    uint256[] qDay;
    uint256[] qAmt;

    function testFuzz_inv03_b2wCap(uint256[24] calldata seeds) public {
        for (uint256 i; i < seeds.length; ++i) {
            uint256 s = seeds[i];
            uint256 op = s % 4;
            uint256 d = bridge.currentDay();
            if (op == 3) {
                vm.warp(block.timestamp + (s >> 8) % 20 hours);
                continue;
            }
            if (op == 2 && qNonce.length > 0) {
                uint256 j = (s >> 8) % qNonce.length;
                if (qNonce[j] == 0) continue;
                vm.prank(wl);
                bridge.cancelRelease(qNonce[j]);
                if (qDay[j] == d) mUsed[d] -= qAmt[j];
                qNonce[j] = 0;
            } else {
                uint256 a = bound(s >> 16, 1, 2_000) * U;
                uint256 nonce = i + 1;
                vm.prank(relayer);
                if (mUsed[d] + a > 3_000 * U) {
                    vm.expectRevert(
                        abi.encodeWithSelector(BridgeBase.DailyCapExceeded.selector, mUsed[d] + a, 3_000 * U)
                    );
                    bridge.queueRelease(nonce, carol, a);
                } else {
                    bridge.queueRelease(nonce, carol, a);
                    mUsed[d] += a;
                    qNonce.push(nonce);
                    qDay.push(d);
                    qAmt.push(a);
                }
            }
            assertEq(bridge.dailyUsed(d), mUsed[d]);
            assertLe(bridge.dailyUsed(d), 3_000 * U);
        }
    }

    function test_inv03_pos_b2wCancelSameDayReturnsQuota() public {
        vm.prank(relayer);
        bridge.queueRelease(1, carol, 3_000 * U);
        vm.prank(admin);
        bridge.cancelRelease(1);
        assertEq(bridge.dailyUsed(bridge.currentDay()), 0);
        vm.prank(relayer);
        bridge.queueRelease(2, carol, 3_000 * U); // full cap available again
    }

    // 7 (WANTOS half) ----------------------------------------------------------
    function test_inv07_neg_pausedBlocksWantosMoneyPaths() public {
        bytes4 P = PausableUpgradeable.EnforcedPause.selector;
        _applyBatch(bridge, _one(alice), true);
        vm.prank(alice);
        uint256 id = bridge.bridgeOut(100 * U);
        vm.prank(admin);
        bridge.requestRefund(id);
        vm.prank(relayer);
        bridge.queueRelease(1, carol, 100 * U);
        vm.warp(block.timestamp + 1 days);
        vm.prank(pauser);
        bridge.pause();
        vm.prank(alice);
        vm.expectRevert(P);
        bridge.bridgeOut(100 * U);
        vm.expectRevert(P);
        bridge.executeRefund(id);
        vm.startPrank(relayer);
        vm.expectRevert(P);
        bridge.queueRelease(2, carol, 100 * U);
        vm.expectRevert(P);
        bridge.executeRelease(1);
        vm.stopPrank();
        vm.prank(address(tl));
        vm.expectRevert(P);
        bridge.withdraw(bob, 1);
    }

    // 6 ------------------------------------------------------------------
    function test_inv06_pos_ordersSurviveUpgrade() public {
        _applyBatch(bridge, _one(alice), true);
        vm.prank(alice);
        uint256 id = bridge.bridgeOut(700 * U);
        vm.prank(admin);
        bridge.requestRefund(id);
        uint256 reserve = token.balanceOf(address(bridge));
        WantosBridgeV2Next next = new WantosBridgeV2Next();
        _viaTimelock(address(bridge), abi.encodeCall(bridge.upgradeToAndCall, (address(next), "")));
        assertEq(WantosBridgeV2Next(address(bridge)).version(), "v2.1");
        (address user, uint128 amt,, uint8 st,) = bridge.orders(id);
        assertEq(user, alice);
        assertEq(amt, 700 * U);
        assertEq(st, 2);
        assertEq(bridge.orderNonce(), 1);
        assertTrue(bridge.whitelisted(alice));
        assertEq(token.balanceOf(address(bridge)), reserve);
        vm.warp(block.timestamp + W.REFUND_DELAY); // refund wait, independent of the timelock wait
        bridge.executeRefund(id);
        assertEq(token.balanceOf(alice), 10_000 * U);
    }

    // 12 (WANTOS half) ------------------------------------------------------
    // The only inter-parameter constraint on WANTOS is w2bMinAmount <= w2bPerAddrDailyCap
    // (there is no B2W per-address cap, §5.5).
    function test_inv12_neg_minAbovePerAddrViaTimelock() public {
        WantosBridgeV2.Params memory p = _wParams();
        p.w2bMinAmount = 2_001 * U;
        vm.prank(address(tl));
        vm.expectRevert(BridgeBase.ParamConstraint.selector);
        bridge.setParams(p);
    }

    function test_inv12_neg_perAddrBelowMinViaAdminTighten() public {
        WantosBridgeV2.Params memory p = _wParams();
        p.w2bMinAmount = 500 * U; // tighten
        p.w2bPerAddrDailyCap = 499 * U; // tighten, but now below the minimum
        vm.prank(admin);
        vm.expectRevert(BridgeBase.ParamConstraint.selector);
        bridge.setParams(p);
    }

    function test_inv12_pos_minEqualsPerAddrAllowed() public {
        WantosBridgeV2.Params memory p = _wParams();
        p.w2bMinAmount = 2_000 * U;
        vm.prank(admin);
        bridge.setParams(p);
        assertEq(bridge.params().w2bMinAmount, 2_000 * U);
    }

    // 10 -----------------------------------------------------------------
    function test_inv10_neg_overCeilingRejectedAndCannotLowerBelowSupply() public {
        _applyBatch(bridge, _one(alice), true);
        token.mint(address(0xbad), 10_000 * U + 1);
        uint256 supply = token.totalSupply();
        uint256 ceil = bridge.supplyCeiling();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WantosBridgeV2.SupplyCeilingExceeded.selector, supply, ceil));
        bridge.bridgeOut(100 * U);
        uint256 ts = token.totalSupply();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(WantosBridgeV2.CeilingBelowSupply.selector, ts - 1, ts));
        bridge.setSupplyCeiling(ts - 1);
    }

    function test_inv10_pos_atCeilingAllowedAndRaiseViaTimelockRestores() public {
        _applyBatch(bridge, _one(alice), true);
        token.mint(address(0xbad), 10_000 * U + 1);
        uint256 ts = token.totalSupply();
        _viaTimelock(address(bridge), abi.encodeCall(WantosBridgeV2.setSupplyCeiling, (ts)));
        vm.prank(alice);
        bridge.bridgeOut(100 * U);
    }

    // 11 -----------------------------------------------------------------
    function test_inv11_pos_refundToOriginalUserAndAmount() public {
        _applyBatch(bridge, _one(alice), true);
        vm.prank(alice);
        uint256 id = bridge.bridgeOut(900 * U);
        vm.prank(admin);
        bridge.requestRefund(id);
        vm.warp(block.timestamp + W.REFUND_DELAY);
        uint256 before = token.balanceOf(alice);
        vm.prank(bob); // executed by someone else: still pays alice
        bridge.executeRefund(id);
        assertEq(token.balanceOf(alice), before + 900 * U);
        assertEq(
            bridge.orderEventKey(id), keccak256(abi.encode("WANTOS-BSC-BRIDGE-V2", WANTOS_CHAIN, address(bridge), id))
        );
    }

    function test_inv11_neg_noRefundForUnknownOrLockedOrTwice() public {
        _applyBatch(bridge, _one(alice), true);
        vm.prank(alice);
        uint256 id = bridge.bridgeOut(900 * U);
        vm.expectRevert(abi.encodeWithSelector(WantosBridgeV2.BadOrderStatus.selector, id, 1));
        bridge.executeRefund(id); // Locked, not Refunding
        vm.expectRevert(abi.encodeWithSelector(WantosBridgeV2.BadOrderStatus.selector, 5, 0));
        bridge.executeRefund(5);
        vm.prank(admin);
        bridge.requestRefund(id);
        vm.warp(block.timestamp + W.REFUND_DELAY);
        bridge.executeRefund(id);
        vm.expectRevert(abi.encodeWithSelector(WantosBridgeV2.BadOrderStatus.selector, id, 3));
        bridge.executeRefund(id);
    }
}
