// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {W} from "./utils/Windows.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {WantosFixture} from "./utils/WantosFixture.sol";
import {BridgeBase} from "../src/BridgeBase.sol";
import {BridgeTimelock} from "../src/BridgeTimelock.sol";
import {WantosBridgeV2} from "../src/WantosBridgeV2.sol";

contract CallerContract {
    function go(WantosBridgeV2 b, uint256 amount) external {
        b.token().approve(address(b), amount);
        b.bridgeOut(amount);
    }
}

contract WantosBridgeV2Test is WantosFixture {
    uint8 constant O_NONE = 0;
    uint8 constant O_LOCKED = 1;
    uint8 constant O_REFUNDING = 2;
    uint8 constant O_REFUNDED = 3;
    uint8 constant QUEUED = 1;
    uint8 constant RELEASED = 2;
    uint8 constant VOIDED = 3;

    function setUp() public {
        _deployWantos();
        _fundUser(alice, 10_000 * U);
        _fundUser(bob, 10_000 * U);
    }

    function _out(address u, uint256 amt) internal returns (uint256 id) {
        vm.prank(u);
        id = bridge.bridgeOut(amt);
    }

    // =========================================================== init
    function test_init_state() public view {
        assertEq(bridge.peerChainId(), BSC_CHAIN);
        assertEq(bridge.peerBridge(), address(bridge));
        assertEq(bridge.supplyCeiling(), token.totalSupply() + 10_000 * U);
        assertEq(bridge.orderNonce(), 0);
        assertEq(bridge.params().b2wDelay, 15 minutes);
        assertEq(token.balanceOf(address(bridge)), 50_000 * U);
    }

    function test_init_reinitAndImplLocked() public {
        WantosBridgeV2.InitArgs memory a = WantosBridgeV2.InitArgs({
            timelock: address(tl),
            token: address(token),
            whitelistManager: wl,
            relayer: relayer,
            pauser: pauser,
            peerChainId: BSC_CHAIN,
            peerBridge: address(bridge),
            params: _wParams(),
            supplyCeiling: token.totalSupply()
        });
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bridge.initialize(a);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        wimpl.initialize(a);
    }

    function test_init_ceilingBelowSupplyAndBadParamsRejected() public {
        for (uint256 i; i < 2; i++) {
            uint256 n = vm.getNonce(address(this));
            address predicted = vm.computeCreateAddress(address(this), n + 1);
            BridgeTimelock t = new BridgeTimelock(admin, predicted);
            WantosBridgeV2.Params memory p = _wParams();
            uint256 ceiling = token.totalSupply();
            if (i == 0) ceiling -= 1;
            else p.w2bMinAmount = p.w2bPerAddrDailyCap + 1;
            WantosBridgeV2.InitArgs memory a = WantosBridgeV2.InitArgs({
                timelock: address(t),
                token: address(token),
                whitelistManager: wl,
                relayer: relayer,
                pauser: pauser,
                peerChainId: BSC_CHAIN,
                peerBridge: predicted,
                params: p,
                supplyCeiling: ceiling
            });
            vm.expectRevert();
            new ERC1967Proxy(address(wimpl), abi.encodeCall(WantosBridgeV2.initialize, (a)));
        }
    }

    function test_domainIsChainlessWhitelistDomain() public view {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,address verifyingContract)"),
                keccak256("SaveBridgeWhitelist"),
                keccak256("1"),
                address(bridge)
            )
        );
        assertEq(bridge.domainSeparator(), domain);
    }

    // =========================================================== bridgeOut (invariants 1, 10)
    function test_bridgeOut_emptyWhitelistRejectsEveryone() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotWhitelisted.selector, alice));
        bridge.bridgeOut(100 * U);
    }

    function test_bridgeOut_happyAndOrder() public {
        _applyBatch(bridge, _one(alice), true);
        vm.expectEmit(address(bridge));
        emit WantosBridgeV2.BridgeOut(1, alice, 500 * U);
        uint256 id = _out(alice, 500 * U);
        assertEq(id, 1);
        (address user, uint128 amt, uint64 createdAt, uint8 st, uint64 rq) = bridge.orders(1);
        assertEq(user, alice);
        assertEq(amt, 500 * U);
        assertEq(createdAt, block.timestamp);
        assertEq(st, O_LOCKED);
        assertEq(rq, 0);
        assertEq(token.balanceOf(address(bridge)), 50_500 * U);
        assertEq(_out(alice, 10 * U), 2);
        (,,, st,) = bridge.orders(99);
        assertEq(st, O_NONE);
    }

    function test_bridgeOut_rejectsContractCallers() public {
        CallerContract c = new CallerContract();
        _applyBatch(bridge, _one(address(c)), true);
        vm.prank(address(0xdead));
        token.transfer(address(c), 100 * U);
        vm.expectRevert(abi.encodeWithSelector(WantosBridgeV2.ContractCaller.selector, address(c)));
        c.go(bridge, 100 * U);
        // EIP-7702 style delegated EOA (has code) is also rejected
        _applyBatch(bridge, _one(bob), true);
        vm.etch(bob, hex"ef0100aabbccddeeff00112233445566778899aabbccdd");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(WantosBridgeV2.ContractCaller.selector, bob));
        bridge.bridgeOut(100 * U);
    }

    function test_bridgeOut_minAndPerAddrDailyCap() public {
        _applyBatch(bridge, _one(alice), true);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.AmountBelowMinimum.selector, 10 * U - 1, 10 * U));
        bridge.bridgeOut(10 * U - 1);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeBase.AddrDailyCapExceeded.selector, alice, 2_000 * U + 1, 2_000 * U)
        );
        bridge.bridgeOut(2_000 * U + 1); // single tx above cap
        bridge.bridgeOut(1_500 * U);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeBase.AddrDailyCapExceeded.selector, alice, 2_000 * U + 1, 2_000 * U)
        );
        bridge.bridgeOut(500 * U + 1);
        bridge.bridgeOut(500 * U);
        vm.warp((block.timestamp / 1 days + 1) * 1 days); // next UTC midnight
        bridge.bridgeOut(2_000 * U);
        vm.stopPrank();
    }

    function test_bridgeOut_supplyCeiling() public {
        _applyBatch(bridge, _one(alice), true);
        _out(alice, 100 * U);
        token.mint(address(0xbad), 10_000 * U); // supply == ceiling: still ok
        _out(alice, 100 * U);
        token.mint(address(0xbad), 1); // supply > ceiling
        uint256 ts = token.totalSupply();
        uint256 ceil = bridge.supplyCeiling();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(WantosBridgeV2.SupplyCeilingExceeded.selector, ts, ceil));
        bridge.bridgeOut(100 * U);
    }

    function test_bridgeOut_pausedAndRemoved() public {
        _applyBatch(bridge, _one(alice), true);
        vm.prank(pauser);
        bridge.pause();
        vm.prank(alice);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridge.bridgeOut(100 * U);
        vm.prank(wl);
        bridge.unpause();
        vm.prank(admin);
        bridge.emergencyRemove(_one(alice));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotWhitelisted.selector, alice));
        bridge.bridgeOut(100 * U);
    }

    // =========================================================== supplyCeiling (invariant 10)
    function test_ceiling_adminLowersImmediatelyNotBelowSupply() public {
        uint256 ts = token.totalSupply();
        vm.prank(pauser);
        bridge.pause(); // lowering works while paused
        vm.prank(admin);
        bridge.setSupplyCeiling(ts + 5);
        assertEq(bridge.supplyCeiling(), ts + 5);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(WantosBridgeV2.CeilingBelowSupply.selector, ts - 1, ts));
        bridge.setSupplyCeiling(ts - 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTightening.selector, 0));
        bridge.setSupplyCeiling(ts + 6);
        vm.prank(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAuthorized.selector, wl));
        bridge.setSupplyCeiling(ts);
    }

    function test_ceiling_raiseViaTimelockNotWhilePaused() public {
        uint256 ts = token.totalSupply();
        bytes memory data = abi.encodeCall(WantosBridgeV2.setSupplyCeiling, (ts + 1_000_000 * U));
        bytes32 salt = _propose(address(bridge), data);
        vm.warp(block.timestamp + W.TL_MIN_DELAY);
        vm.prank(pauser);
        bridge.pause();
        vm.expectRevert();
        _execute(address(bridge), data, salt);
        vm.prank(admin);
        bridge.unpause();
        _execute(address(bridge), data, salt);
        assertEq(bridge.supplyCeiling(), ts + 1_000_000 * U);
        // timelock also cannot go below supply
        data = abi.encodeCall(WantosBridgeV2.setSupplyCeiling, (ts - 1));
        salt = _propose(address(bridge), data);
        vm.warp(block.timestamp + W.TL_MIN_DELAY);
        vm.expectRevert();
        _execute(address(bridge), data, salt);
    }

    // =========================================================== refunds (invariant 11)
    function test_refund_flowAndEventKeyDerivation() public {
        _applyBatch(bridge, _one(alice), true);
        uint256 id = _out(alice, 800 * U);
        uint256 bal = token.balanceOf(alice);
        bytes32 expectedKey = keccak256(abi.encode("WANTOS-BSC-BRIDGE-V2", WANTOS_CHAIN, address(bridge), id));
        assertEq(bridge.orderEventKey(id), expectedKey);
        vm.prank(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdmin.selector, wl));
        bridge.requestRefund(id);
        vm.expectEmit(address(bridge));
        emit WantosBridgeV2.RefundRequested(id, expectedKey, alice, 800 * U, block.timestamp + W.REFUND_DELAY);
        vm.prank(admin);
        bridge.requestRefund(id);
        (,,, uint8 st,) = bridge.orders(id);
        assertEq(st, O_REFUNDING);
        vm.warp(block.timestamp + W.REFUND_DELAY - 1);
        vm.expectRevert();
        bridge.executeRefund(id);
        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        bridge.executeRefund(id);
        assertEq(token.balanceOf(alice), bal + 800 * U); // original user, original amount
        assertEq(token.balanceOf(stranger), 0);
        assertEq(bridge.dailyUsed(bridge.currentDay()), 800 * U); // counted in b2wDailyCap
        (,,, st,) = bridge.orders(id);
        assertEq(st, O_REFUNDED);
        vm.expectRevert();
        bridge.executeRefund(id);
        vm.prank(admin);
        vm.expectRevert();
        bridge.requestRefund(id);
    }

    function test_refund_cancelReturnsToLocked() public {
        _applyBatch(bridge, _one(alice), true);
        uint256 id = _out(alice, 800 * U);
        vm.prank(admin);
        bridge.requestRefund(id);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdminOrWhitelistManager.selector, stranger));
        bridge.cancelRefund(id);
        vm.prank(wl);
        bridge.cancelRefund(id);
        (,,, uint8 st,) = bridge.orders(id);
        assertEq(st, O_LOCKED);
        vm.warp(block.timestamp + W.REFUND_DELAY);
        vm.expectRevert();
        bridge.executeRefund(id);
        vm.prank(admin);
        vm.expectRevert();
        bridge.cancelRefund(id);
    }

    function test_refund_batchUnknownPausedAndCap() public {
        _applyBatch(bridge, _one(alice), true);
        uint256[] memory ids = new uint256[](2);
        ids[0] = _out(alice, 1_000 * U);
        ids[1] = _out(alice, 1_000 * U);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(WantosBridgeV2.BadOrderStatus.selector, 77, O_NONE));
        bridge.requestRefund(77);
        vm.prank(pauser);
        bridge.pause();
        vm.prank(admin); // request allowed while paused
        bridge.requestRefundBatch(ids);
        vm.warp(block.timestamp + W.REFUND_DELAY);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridge.executeRefund(ids[0]);
        vm.prank(wl);
        bridge.unpause();
        vm.prank(relayer);
        bridge.queueRelease(1, bob, 1_500 * U); // b2w used 1500
        bridge.executeRefund(ids[0]); // 2500
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.DailyCapExceeded.selector, 3_500 * U, 3_000 * U));
        bridge.executeRefund(ids[1]);
    }

    // =========================================================== B2W inbound (invariants 2, 3, 13)
    function test_b2w_queueExecuteNoWhitelist() public {
        bytes32 k = _bkey(9);
        assertEq(k, keccak256(abi.encode("WANTOS-BSC-BRIDGE-V2", BSC_CHAIN, address(bridge), uint256(9))));
        vm.expectEmit(address(bridge));
        emit BridgeBase.ReleaseQueued(k, 9, carol, 700 * U, block.timestamp + 15 minutes);
        vm.prank(relayer);
        bridge.queueRelease(9, carol, 700 * U); // carol is not whitelisted: fine (§5.3)
        vm.warp(block.timestamp + 15 minutes - 1);
        vm.prank(relayer);
        vm.expectRevert();
        bridge.executeRelease(9);
        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        vm.expectRevert();
        bridge.executeRelease(9);
        vm.prank(relayer);
        bridge.executeRelease(9);
        assertEq(token.balanceOf(carol), 700 * U);
        assertEq(_bstatus(9), RELEASED);
    }

    /// Inbound (BSC -> WANTOS) without a waiting period: with `b2wDelay = 0` a release is paid in the same block.
    /// Turns red if the lower bound of `b2wDelay` is restored (the setParams below would revert).
    function test_b2w_zeroDelay_releasesInSameBlock() public {
        WantosBridgeV2.Params memory p = bridge.params();
        p.b2wDelay = 0;
        _viaTimelock(address(bridge), abi.encodeCall(WantosBridgeV2.setParams, (p)));
        assertEq(bridge.params().b2wDelay, 0);

        vm.prank(relayer);
        bridge.queueRelease(11, carol, 700 * U);
        vm.prank(relayer);
        bridge.executeRelease(11); // no warp: same block
        assertEq(token.balanceOf(carol), 700 * U);
        assertEq(_bstatus(11), RELEASED);

        // the same source event can never be paid twice
        bytes32 k = _bkey(11);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, k, RELEASED));
        bridge.queueRelease(11, carol, 700 * U);
        assertEq(token.balanceOf(carol), 700 * U);
    }

    /// With `b2wDelay = 0` the admin wallet can still re-introduce a delay at once, but never lower it again.
    function test_b2w_zeroDelay_adminCanOnlyRaise() public {
        WantosBridgeV2.Params memory p = bridge.params();
        p.b2wDelay = 0;
        _viaTimelock(address(bridge), abi.encodeCall(WantosBridgeV2.setParams, (p)));

        p.b2wDelay = 15 minutes;
        vm.prank(admin);
        bridge.setParams(p);
        assertEq(bridge.params().b2wDelay, 15 minutes);

        p.b2wDelay = 0;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTightening.selector, 3));
        bridge.setParams(p);
    }

    function test_b2w_capReplayVoid() public {
        vm.startPrank(relayer);
        vm.expectRevert(BridgeBase.ZeroAddress.selector);
        bridge.queueRelease(1, address(0), 1);
        vm.expectRevert(BridgeBase.ZeroAmount.selector);
        bridge.queueRelease(1, carol, 0);
        bridge.queueRelease(1, carol, 2_000 * U);
        bridge.queueRelease(1, carol, 2_000 * U); // replay: no double charge
        assertEq(bridge.dailyUsed(bridge.currentDay()), 2_000 * U);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.DailyCapExceeded.selector, 3_000 * U + 1, 3_000 * U));
        bridge.queueRelease(2, carol, 1_000 * U + 1);
        vm.stopPrank();
        vm.prank(wl);
        bridge.cancelRelease(1);
        assertEq(bridge.dailyUsed(bridge.currentDay()), 0);
        assertEq(_bstatus(1), VOIDED);
        bytes32 k1 = _bkey(1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, k1, VOIDED));
        bridge.queueRelease(1, carol, 2_000 * U);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, k1, VOIDED));
        bridge.executeRelease(1);
    }

    function test_b2w_pausedBlocks() public {
        vm.prank(relayer);
        bridge.queueRelease(1, carol, 100 * U);
        vm.prank(pauser);
        bridge.pause();
        vm.warp(block.timestamp + 1 hours);
        vm.startPrank(relayer);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridge.queueRelease(2, carol, 100 * U);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridge.executeRelease(1);
        vm.stopPrank();
        vm.prank(admin);
        bridge.voidSource(1); // void still works while paused (deposit-refund precondition)
        assertEq(_bstatus(1), VOIDED);
    }

    // =========================================================== params (invariant 12)
    function test_params_tightenLoosen() public {
        WantosBridgeV2.Params memory p = _wParams();
        p.w2bMinAmount = 20 * U;
        p.w2bPerAddrDailyCap = 1_000 * U;
        p.b2wDailyCap = 2_000 * U;
        p.b2wDelay = 1 hours;
        vm.prank(admin);
        bridge.setParams(p);
        assertEq(bridge.params().b2wDelay, 1 hours);
        for (uint256 i; i < 4; i++) {
            WantosBridgeV2.Params memory q = bridge.params();
            if (i == 0) q.w2bMinAmount -= 1;
            if (i == 1) q.w2bPerAddrDailyCap += 1;
            if (i == 2) q.b2wDailyCap += 1;
            if (i == 3) q.b2wDelay -= 1;
            vm.prank(admin);
            vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTightening.selector, i));
            bridge.setParams(q);
        }
        // floors
        p = bridge.params();
        p.b2wDailyCap = 499 * U;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.ParamOutOfRange.selector, 2));
        bridge.setParams(p);
        p = bridge.params();
        p.b2wDelay = 24 hours + 1;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.ParamOutOfRange.selector, 3));
        bridge.setParams(p);
        p = bridge.params();
        p.w2bMinAmount = 1_001 * U; // > perAddr 1000
        vm.prank(admin);
        vm.expectRevert(BridgeBase.ParamConstraint.selector);
        bridge.setParams(p);
        p = bridge.params();
        p.w2bPerAddrDailyCap = 9 * U;
        p.w2bMinAmount = 9 * U;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTightening.selector, 0));
        bridge.setParams(p);
        // loosen via timelock
        _viaTimelock(address(bridge), abi.encodeCall(WantosBridgeV2.setParams, (_wParams())));
        assertEq(bridge.params().b2wDelay, 15 minutes);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAuthorized.selector, stranger));
        bridge.setParams(p);
    }

    function test_params_loosenBlockedWhilePausedOrRecovering() public {
        WantosBridgeV2.Params memory p = _wParams();
        p.b2wDailyCap = 10_000 * U;
        vm.prank(pauser);
        bridge.pause();
        vm.prank(address(tl));
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        bridge.setParams(p);
        vm.prank(wl);
        bridge.unpause();
        vm.prank(admin);
        bridge.startWhitelistRecovery(makeAddr("wl2"));
        vm.prank(address(tl));
        vm.expectRevert(BridgeBase.RecoveryInProgress.selector);
        bridge.setParams(p);
    }

    // =========================================================== withdraw on WANTOS
    function test_withdraw_viaTimelock() public {
        _viaTimelock(address(bridge), abi.encodeCall(BridgeBase.withdraw, (carol, 1_000 * U)));
        assertEq(token.balanceOf(carol), 1_000 * U);
    }
}
