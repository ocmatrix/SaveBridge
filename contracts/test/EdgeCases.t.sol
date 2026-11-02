// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {W} from "./utils/Windows.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {BscFixture} from "./utils/Fixtures.sol";
import {WantosFixture} from "./utils/WantosFixture.sol";
import {BridgeBase} from "../src/BridgeBase.sol";
import {BridgeTimelock} from "../src/BridgeTimelock.sol";
import {BscVaultV2} from "../src/BscVaultV2.sol";
import {WantosBridgeV2} from "../src/WantosBridgeV2.sol";

contract BscEdgeCasesTest is BscFixture {
    function setUp() public {
        _deployBsc();
    }

    function _tryInit(address timelockAddr, address tokenAddr, uint256 peerChain) internal returns (bool ok) {
        BscVaultV2.InitArgs memory a = BscVaultV2.InitArgs({
            timelock: timelockAddr,
            token: tokenAddr,
            whitelistManager: wl,
            relayer: relayer,
            pauser: pauser,
            peerChainId: peerChain,
            peerBridge: address(0),
            params: _bscParams()
        });
        try new ERC1967Proxy(address(impl), abi.encodeCall(BscVaultV2.initialize, (a))) {
            ok = true;
        } catch (bytes memory err) {
            assertEq(bytes4(err), BridgeBase.InvalidInit.selector);
        }
    }

    function test_initRejectsZeroTimelockTokenOrPeerChain() public {
        assertFalse(_tryInit(address(0), address(token), WANTOS_CHAIN));
        assertFalse(_tryInit(address(tl), address(0), WANTOS_CHAIN));
        assertFalse(_tryInit(address(tl), address(token), 0));
    }

    function test_whitelistRecoveryView() public {
        vm.prank(admin);
        vault.startWhitelistRecovery(bob);
        (bool active, address cand, uint64 readyAt, uint64 cooldown) = vault.whitelistRecovery();
        assertTrue(active);
        assertEq(cand, bob);
        assertEq(readyAt, block.timestamp + W.WL_RECOVERY);
        assertEq(cooldown, 0);
    }

    function test_depositEventKey() public view {
        assertEq(
            vault.depositEventKey(4),
            keccak256(abi.encode("WANTOS-BSC-BRIDGE-V2", BSC_CHAIN, address(vault), uint256(4)))
        );
    }

    function test_acceptHandoverBlockedDuringRecovery() public {
        vm.prank(wl);
        vault.beginWhitelistManagerTransfer(bob);
        vm.prank(wl);
        tl.startAdminRecovery(carol); // admin recovery (does not void the WL handover)
        vm.warp(block.timestamp + W.WL_TRANSFER_DELAY);
        vm.prank(bob);
        vm.expectRevert(BridgeBase.RecoveryInProgress.selector);
        vault.acceptWhitelistManagerTransfer();
    }

    function test_grantZeroAndRevokeRoleGate() public {
        bytes32 R = vault.RELAYER_ROLE();
        vm.prank(address(tl));
        vm.expectRevert(BridgeBase.ZeroAddress.selector);
        vault.grantRole(R, address(0));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTimelock.selector, admin));
        vault.revokeRole(R, relayer);
        _viaTimelock(address(vault), abi.encodeCall(IAccessControl.revokeRole, (R, relayer)));
        assertFalse(vault.hasRole(R, relayer));
    }

    function test_withdrawZeroGuards() public {
        vm.startPrank(address(tl));
        vm.expectRevert(BridgeBase.ZeroAddress.selector);
        vault.withdraw(address(0), 1);
        vm.expectRevert(BridgeBase.ZeroAmount.selector);
        vault.withdraw(bob, 0);
        vm.stopPrank();
    }

    function test_cancelDepositRefundRequiresRefunding() public {
        token.mint(bob, 100 * U);
        vm.startPrank(bob);
        token.approve(address(vault), 100 * U);
        uint256 n = vault.deposit(100 * U, bob);
        vm.stopPrank();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BscVaultV2.BadDepositStatus.selector, n, 0));
        vault.cancelDepositRefund(n);
    }

    function test_legacyZeroGuards() public {
        bytes32[] memory k = new bytes32[](1);
        k[0] = bytes32("k");
        uint256[] memory amt = new uint256[](1);
        amt[0] = 1;
        vm.prank(address(tl));
        vm.expectRevert(BridgeBase.ZeroAddress.selector);
        vault.payLegacyBatch(k, _one(address(0)), amt);
        amt[0] = 0;
        vm.prank(address(tl));
        vm.expectRevert(BridgeBase.ZeroAmount.selector);
        vault.payLegacyBatch(k, _one(bob), amt);
        vm.prank(address(tl));
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadBatchSize.selector, 0));
        vault.payLegacyBatch(new bytes32[](0), new address[](0), new uint256[](0));
    }

    /// B6 runbook item 1: emergencyRemove does not advance the batch nonce, so an already-signed, unsubmitted
    /// ADD batch can put the address back. Correct order: freezeWhitelist first, then remove.
    function test_runbook_emergencyRemoveWithoutFreezeCanBeUndoneByPresignedAdd() public {
        _applyBatch(vault, _one(alice), true); // nonce 0 used
        uint256 dl = block.timestamp + W.SIG_TTL / 24;
        bytes memory presigned = _signBatch(vault, wlKey, _one(alice), true, 1, dl); // stolen / pending signature
        vm.prank(admin);
        vault.emergencyRemove(_one(alice));
        assertEq(vault.whitelistNonce(), 1); // not advanced
        vault.applyWhitelistBatch(_one(alice), true, 1, dl, presigned);
        assertTrue(vault.whitelisted(alice)); // re-added
        // the safe order: freeze, then remove -> the same kind of pre-signed add is rejected
        bytes memory presigned2 = _signBatch(vault, wlKey, _one(alice), true, 2, dl);
        vm.startPrank(admin);
        vault.freezeWhitelist();
        vault.emergencyRemove(_one(alice));
        vm.stopPrank();
        vm.expectRevert(BridgeBase.WhitelistWritesBlocked.selector);
        vault.applyWhitelistBatch(_one(alice), true, 2, dl, presigned2);
        assertFalse(vault.whitelisted(alice));
    }

    /// B6 runbook item 2: a stolen WL key can void FUTURE orderIds on BSC; those orders can never be paid there
    /// (refund path on WANTOS only) - funds are not lost.
    function test_runbook_wlCanVoidFutureOrderIds() public {
        _applyBatch(vault, _one(alice), true);
        vm.prank(wl);
        vault.voidSource(1_000);
        bytes32 k = vault.eventKeyOf(1_000);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, k, uint8(3)));
        vault.release(1_000, alice, 1 * U);
    }

    /// B6 runbook item 3: pause() on an already paused bridge reverts EnforcedPause (monitor must treat as success).
    function test_runbook_doublePauseRevertsEnforcedPause() public {
        vm.prank(pauser);
        vault.pause();
        vm.prank(pauser);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vault.pause();
    }

    function test_paramsMaxDepositZero() public {
        BscVaultV2.Params memory p = _bscParams();
        p.maxDepositPerTx = 0;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.ParamOutOfRange.selector, 5));
        vault.setParams(p);
    }
}

contract WantosEdgeCasesTest is WantosFixture {
    function setUp() public {
        _deployWantos();
    }

    function test_rangesEnforcedEvenForTimelock() public {
        WantosBridgeV2.Params memory p = _wParams();
        p.w2bMinAmount = 9 * U;
        vm.prank(address(tl));
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.ParamOutOfRange.selector, 0));
        bridge.setParams(p);
        p = _wParams();
        p.w2bPerAddrDailyCap = 20_001 * U;
        vm.prank(address(tl));
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.ParamOutOfRange.selector, 1));
        bridge.setParams(p);
    }
}
