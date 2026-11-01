// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

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
        vm.warp(block.timestamp + 24 hours);
        vm.prank(relayer);
        bridge.queueRelease(1, carol, 2_500 * U);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.DailyCapExceeded.selector, 3_500 * U, 3_000 * U));
        bridge.executeRefund(id);
    }

    /// Fuzz: inbound queue amounts never push the day's usage over b2wDailyCap.
    function testFuzz_inv03_b2wCap(uint256[16] calldata amts) public {
        uint256 used;
        uint256 day = bridge.currentDay();
        for (uint256 i; i < amts.length; ++i) {
            uint256 a = bound(amts[i], 1, 2_000) * U;
            vm.prank(relayer);
            if (used + a > 3_000 * U) {
                vm.expectRevert();
                bridge.queueRelease(i + 1, carol, a);
            } else {
                bridge.queueRelease(i + 1, carol, a);
                used += a;
            }
            assertEq(bridge.dailyUsed(day), used);
            assertLe(used, 3_000 * U);
        }
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
        bridge.executeRefund(id); // 24h passed during the 48h timelock wait
        assertEq(token.balanceOf(alice), 10_000 * U);
    }

    // 10 -----------------------------------------------------------------
    function test_inv10_neg_overCeilingRejectedAndCannotLowerBelowSupply() public {
        _applyBatch(bridge, _one(alice), true);
        token.mint(address(0xbad), 10_000 * U + 1);
        vm.prank(alice);
        vm.expectRevert();
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
        vm.warp(block.timestamp + 24 hours);
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
        vm.warp(block.timestamp + 24 hours);
        bridge.executeRefund(id);
        vm.expectRevert(abi.encodeWithSelector(WantosBridgeV2.BadOrderStatus.selector, id, 3));
        bridge.executeRefund(id);
    }
}
