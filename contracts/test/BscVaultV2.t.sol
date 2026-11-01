// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {BscFixture} from "./utils/Fixtures.sol";
import {BridgeBase} from "../src/BridgeBase.sol";
import {BridgeTimelock} from "../src/BridgeTimelock.sol";
import {BscVaultV2} from "../src/BscVaultV2.sol";

contract BscVaultV2Test is BscFixture {
    uint8 constant NONE = 0;
    uint8 constant QUEUED = 1;
    uint8 constant RELEASED = 2;
    uint8 constant VOIDED = 3;

    function setUp() public {
        _deployBsc();
    }

    function _wlAlice() internal {
        _applyBatch(vault, _one(alice), true);
    }

    // =========================================================== init
    function test_init_state() public view {
        assertEq(vault.timelock(), address(tl));
        assertEq(address(vault.token()), address(token));
        assertEq(vault.whitelistManager(), wl);
        assertEq(vault.adminWallet(), admin);
        assertEq(vault.peerChainId(), WANTOS_CHAIN);
        assertEq(vault.peerBridge(), address(vault));
        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), address(tl)));
        assertTrue(vault.hasRole(vault.RELAYER_ROLE(), relayer));
        assertTrue(vault.hasRole(vault.PAUSER_ROLE(), pauser));
        assertEq(vault.whitelistNonce(), 0);
        assertFalse(vault.whitelisted(alice));
        assertEq(vault.depositNonce(), 0);
        BscVaultV2.Params memory p = vault.params();
        assertEq(p.dailyCap, 5_000 * U);
        assertEq(p.releaseDelay, 12 hours);
    }

    function test_init_cannotReinitialize() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(_args(address(tl), wl, relayer, pauser, address(vault)));
    }

    function test_init_implementationLocked() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(_args(address(tl), wl, relayer, pauser, address(impl)));
    }

    function _args(address t, address w, address r, address p, address peer)
        internal
        view
        returns (BscVaultV2.InitArgs memory)
    {
        return BscVaultV2.InitArgs({
            timelock: t,
            token: address(token),
            whitelistManager: w,
            relayer: r,
            pauser: p,
            peerChainId: WANTOS_CHAIN,
            peerBridge: peer,
            params: _bscParams()
        });
    }

    function _deployWith(address w, address r, address p, bool goodPeer, BscVaultV2.Params memory prm)
        internal
        returns (bool ok)
    {
        uint256 n = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), n + 1);
        BridgeTimelock t = new BridgeTimelock(admin, predicted);
        BscVaultV2.InitArgs memory a = _args(address(t), w, r, p, goodPeer ? predicted : address(0xBEEF));
        a.params = prm;
        try new ERC1967Proxy(address(impl), abi.encodeCall(BscVaultV2.initialize, (a))) returns (ERC1967Proxy) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function test_init_keysMustBePairwiseDistinct() public {
        BscVaultV2.Params memory p = _bscParams();
        assertTrue(_deployWith(wl, relayer, pauser, true, p));
        assertFalse(_deployWith(admin, relayer, pauser, true, p)); // WL == admin
        assertFalse(_deployWith(wl, admin, pauser, true, p)); // relayer == admin
        assertFalse(_deployWith(wl, relayer, admin, true, p)); // pauser == admin
        assertFalse(_deployWith(wl, wl, pauser, true, p)); // relayer == WL
        assertFalse(_deployWith(wl, relayer, wl, true, p)); // pauser == WL
        assertFalse(_deployWith(wl, relayer, relayer, true, p)); // relayer == pauser
        assertFalse(_deployWith(address(0), relayer, pauser, true, p));
    }

    function test_init_peerBridgeMustBeSelf() public {
        assertFalse(_deployWith(wl, relayer, pauser, false, _bscParams()));
    }

    function test_init_paramsValidated() public {
        BscVaultV2.Params memory p = _bscParams();
        p.largeThreshold = p.perAddrDailyCap + 1;
        assertFalse(_deployWith(wl, relayer, pauser, true, p));
        p = _bscParams();
        p.releaseDelay = 1 hours;
        assertFalse(_deployWith(wl, relayer, pauser, true, p));
    }

    function test_init_timelockMustPointToProxy() public {
        BridgeTimelock t = new BridgeTimelock(admin, address(0x1234));
        vm.expectRevert();
        new ERC1967Proxy(
            address(impl), abi.encodeCall(BscVaultV2.initialize, (_args(address(t), wl, relayer, pauser, address(0))))
        );
    }

    function test_eventKeyFormula() public view {
        bytes32 expected = keccak256(abi.encode("WANTOS-BSC-BRIDGE-V2", WANTOS_CHAIN, address(vault), uint256(7)));
        assertEq(vault.eventKeyOf(7), expected);
        assertEq(vault.computeEventKey(WANTOS_CHAIN, address(vault), 7), expected);
    }

    // =========================================================== whitelist batches (invariant 8)
    function test_wl_addAndRemove() public {
        address[] memory a = _sorted(_two(alice, bob));
        bytes32 listHash = keccak256(abi.encode(a));
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signBatch(vault, wlKey, a, true, 0, deadline);
        vm.expectEmit(address(vault));
        emit BridgeBase.WhitelistUpdated(a[0], true, listHash);
        vm.expectEmit(address(vault));
        emit BridgeBase.WhitelistUpdated(a[1], true, listHash);
        vm.expectEmit(address(vault));
        emit BridgeBase.WhitelistBatchApplied(listHash, true, 0, 2);
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
        assertTrue(vault.whitelisted(alice));
        assertTrue(vault.whitelisted(bob));
        assertEq(vault.whitelistNonce(), 1);
        _applyBatch(vault, _one(bob), false);
        assertFalse(vault.whitelisted(bob));
        assertEq(vault.whitelistNonce(), 2);
    }

    function test_wl_digestMatchesSpec() public view {
        address[] memory a = _sorted(_two(alice, bob));
        bytes32 typeHash =
            keccak256("WhitelistBatch(bytes32 listHash,uint32 count,bool allowed,uint256 nonce,uint256 deadline)");
        assertEq(vault.WHITELIST_BATCH_TYPEHASH(), typeHash);
        bytes32 structHash = keccak256(abi.encode(typeHash, keccak256(abi.encode(a)), uint32(2), true, 5, 99));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BscVaultV2"),
                keccak256("1"),
                block.chainid,
                address(vault)
            )
        );
        assertEq(vault.domainSeparator(), domain);
        assertEq(vault.hashWhitelistBatch(a, true, 5, 99), keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    function test_wl_replayRejected() public {
        address[] memory a = _one(alice);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signBatch(vault, wlKey, a, true, 0, deadline);
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadNonce.selector, 1, 0));
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
    }

    function test_wl_outOfOrderNonceRejected() public {
        address[] memory a = _one(alice);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signBatch(vault, wlKey, a, true, 1, deadline);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadNonce.selector, 0, 1));
        vault.applyWhitelistBatch(a, true, 1, deadline, sig);
    }

    function test_wl_crossChainRejected() public {
        address[] memory a = _one(alice);
        uint256 deadline = block.timestamp + 1 hours;
        vm.chainId(WANTOS_CHAIN);
        bytes memory sig = _signBatch(vault, wlKey, a, true, 0, deadline); // domain bound to 13555
        vm.chainId(BSC_CHAIN);
        vm.expectRevert(); // recovers to a different signer
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
    }

    function test_wl_crossContractRejected() public {
        // signature over another verifyingContract (e.g. the WANTOS bridge at a different address)
        address[] memory a = _one(alice);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 typeHash = vault.WHITELIST_BATCH_TYPEHASH();
        bytes32 structHash = keccak256(abi.encode(typeHash, keccak256(abi.encode(a)), uint32(1), true, 0, deadline));
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BscVaultV2"),
                keccak256("1"),
                block.chainid,
                address(0xBEEF)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wlKey, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        vm.expectRevert();
        vault.applyWhitelistBatch(a, true, 0, deadline, abi.encodePacked(r, s, v));
    }

    function test_wl_expiredRejected() public {
        address[] memory a = _one(alice);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signBatch(vault, wlKey, a, true, 0, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.SignatureExpired.selector, deadline));
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
    }

    function test_wl_deadlineOver24hRejected() public {
        address[] memory a = _one(alice);
        uint256 deadline = block.timestamp + 24 hours + 1;
        bytes memory sig = _signBatch(vault, wlKey, a, true, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.DeadlineTooFar.selector, deadline));
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
        // exactly 24h is fine
        deadline = block.timestamp + 24 hours;
        sig = _signBatch(vault, wlKey, a, true, 0, deadline);
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
    }

    function test_wl_unsortedAndDuplicateRejected() public {
        address[] memory a = _sorted(_two(alice, bob));
        address[] memory rev = _two(a[1], a[0]);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signBatch(vault, wlKey, rev, true, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.AddressesNotSorted.selector, 1));
        vault.applyWhitelistBatch(rev, true, 0, deadline, sig);
        address[] memory dup = _two(alice, alice);
        sig = _signBatch(vault, wlKey, dup, true, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.AddressesNotSorted.selector, 1));
        vault.applyWhitelistBatch(dup, true, 0, deadline, sig);
    }

    function test_wl_zeroAddressRejected() public {
        address[] memory a = _two(address(0), alice);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signBatch(vault, wlKey, a, true, 0, deadline);
        vm.expectRevert(BridgeBase.ZeroAddress.selector);
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
    }

    function test_wl_batchSizeLimits() public {
        address[] memory big = new address[](501);
        for (uint256 i; i < 501; i++) {
            big[i] = address(uint160(i + 1));
        }
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signBatch(vault, wlKey, big, true, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadBatchSize.selector, 501));
        vault.applyWhitelistBatch(big, true, 0, deadline, sig);
        address[] memory empty = new address[](0);
        sig = _signBatch(vault, wlKey, empty, true, 0, deadline);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadBatchSize.selector, 0));
        vault.applyWhitelistBatch(empty, true, 0, deadline, sig);
        address[] memory max = new address[](500);
        for (uint256 i; i < 500; i++) {
            max[i] = address(uint160(i + 1));
        }
        sig = _signBatch(vault, wlKey, max, true, 0, deadline);
        vault.applyWhitelistBatch(max, true, 0, deadline, sig);
        assertTrue(vault.whitelisted(address(500)));
    }

    function test_wl_wrongSignerRejected() public {
        (, uint256 otherKey) = makeAddrAndKey("other");
        address[] memory a = _one(alice);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signBatch(vault, otherKey, a, true, 0, deadline);
        vm.expectRevert();
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
        // signature over different allowed flag is also rejected
        sig = _signBatch(vault, wlKey, a, false, 0, deadline);
        vm.expectRevert();
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
    }

    function test_wl_invalidateNonce() public {
        address[] memory a = _one(alice);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signBatch(vault, wlKey, a, true, 0, deadline);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotWhitelistManager.selector, admin));
        vault.invalidateWhitelistNonce();
        vm.prank(wl);
        vault.invalidateWhitelistNonce();
        assertEq(vault.whitelistNonce(), 1);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadNonce.selector, 1, 0));
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
    }

    function test_wl_frozenBlocksAddButNotRemove() public {
        _wlAlice();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdmin.selector, stranger));
        vault.freezeWhitelist();
        vm.prank(admin);
        vault.freezeWhitelist();
        assertTrue(vault.whitelistFrozen());
        address[] memory a = _one(bob);
        uint256 nonce = vault.whitelistNonce();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signBatch(vault, wlKey, a, true, nonce, deadline);
        vm.expectRevert(BridgeBase.WhitelistWritesBlocked.selector);
        vault.applyWhitelistBatch(a, true, nonce, deadline, sig);
        _applyBatch(vault, _one(alice), false);
        assertFalse(vault.whitelisted(alice));
    }

    function test_wl_unfreezeOnlyViaTimelockAndNotWhilePaused() public {
        vm.prank(admin);
        vault.freezeWhitelist();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTimelock.selector, admin));
        vault.unfreezeWhitelist();
        bytes memory data = abi.encodeCall(BridgeBase.unfreezeWhitelist, ());
        bytes32 salt = _propose(address(vault), data);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(pauser);
        vault.pause();
        vm.expectRevert();
        _execute(address(vault), data, salt);
        vm.prank(admin);
        vault.unpause();
        _execute(address(vault), data, salt);
        assertFalse(vault.whitelistFrozen());
    }

    function test_wl_emergencyRemoveAdminOnlyAndWorksWhilePaused() public {
        _applyBatch(vault, _two(alice, bob), true);
        vm.prank(pauser);
        vault.pause();
        vm.prank(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdmin.selector, wl));
        vault.emergencyRemove(_one(alice));
        vm.prank(admin);
        vault.emergencyRemove(_two(alice, carol));
        assertFalse(vault.whitelisted(alice));
        assertTrue(vault.whitelisted(bob));
    }

    // =========================================================== keys (invariant 5)
    function test_keys_grantViaTimelockWithConflictChecks() public {
        address r2 = makeAddr("r2");
        bytes32 R = vault.RELAYER_ROLE();
        bytes32 P = vault.PAUSER_ROLE();
        _viaTimelock(address(vault), abi.encodeCall(IAccessControl.grantRole, (R, r2)));
        assertTrue(vault.hasRole(R, r2));
        // conflicts: admin, WL, pauser -> relayer, relayer -> pauser
        bytes[4] memory bad = [
            abi.encodeCall(IAccessControl.grantRole, (R, admin)),
            abi.encodeCall(IAccessControl.grantRole, (R, wl)),
            abi.encodeCall(IAccessControl.grantRole, (R, pauser)),
            abi.encodeCall(IAccessControl.grantRole, (P, relayer))
        ];
        for (uint256 i; i < 4; i++) {
            bytes32 salt = _propose(address(vault), bad[i]);
            vm.warp(block.timestamp + 48 hours);
            vm.expectRevert();
            _execute(address(vault), bad[i], salt);
        }
    }

    function test_keys_directGrantByAdminRejected() public {
        bytes32 R = vault.RELAYER_ROLE();
        vm.prank(admin);
        vm.expectRevert();
        vault.grantRole(R, makeAddr("r2"));
    }

    function test_keys_defaultAdminLockedToTimelock() public {
        bytes32 D = vault.DEFAULT_ADMIN_ROLE();
        bytes memory g = abi.encodeCall(IAccessControl.grantRole, (D, admin));
        bytes32 s1 = _propose(address(vault), g);
        bytes memory r = abi.encodeCall(IAccessControl.revokeRole, (D, address(tl)));
        bytes32 s2 = _propose(address(vault), r);
        bytes memory n = abi.encodeCall(IAccessControl.renounceRole, (D, address(tl)));
        bytes32 s3 = _propose(address(vault), n);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        _execute(address(vault), g, s1);
        vm.expectRevert();
        _execute(address(vault), r, s2);
        vm.expectRevert();
        _execute(address(vault), n, s3);
        assertTrue(vault.hasRole(D, address(tl)));
        // an unknown role cannot be granted either
        bytes memory u = abi.encodeCall(IAccessControl.grantRole, (keccak256("OTHER"), stranger));
        bytes32 s4 = _propose(address(vault), u);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        _execute(address(vault), u, s4);
    }

    function test_keys_revokeKeyImmediateByAdmin() public {
        bytes32 R = vault.RELAYER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdmin.selector, stranger));
        vault.revokeKey(R, relayer);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.InvalidRole.selector, bytes32(0)));
        vault.revokeKey(bytes32(0), address(tl));
        vm.prank(pauser);
        vault.pause(); // still possible while paused
        vm.prank(admin);
        vault.revokeKey(R, relayer);
        assertFalse(vault.hasRole(R, relayer));
        bytes32 P = vault.PAUSER_ROLE();
        vm.prank(admin);
        vault.revokeKey(P, pauser);
        assertFalse(vault.hasRole(P, pauser));
    }

    function test_keys_grantWhilePausedAllowed() public {
        vm.prank(pauser);
        vault.pause();
        _viaTimelock(address(vault), abi.encodeCall(IAccessControl.grantRole, (vault.PAUSER_ROLE(), makeAddr("p2"))));
        assertTrue(vault.hasRole(vault.PAUSER_ROLE(), makeAddr("p2")));
    }

    function test_keys_renounceRelayerAllowed() public {
        bytes32 R = vault.RELAYER_ROLE();
        vm.prank(relayer);
        vault.renounceRole(R, relayer);
        assertFalse(vault.hasRole(R, relayer));
    }

    function test_keys_isKeyHolder() public view {
        assertTrue(vault.isKeyHolder(wl));
        assertTrue(vault.isKeyHolder(relayer));
        assertTrue(vault.isKeyHolder(pauser));
        assertFalse(vault.isKeyHolder(admin));
        assertFalse(vault.isKeyHolder(alice));
    }

    // =========================================================== pause (invariant 7)
    function test_pause_whoCanPauseAndUnpause() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAuthorized.selector, stranger));
        vault.pause();
        vm.prank(pauser);
        vault.pause();
        vm.prank(pauser);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdminOrWhitelistManager.selector, pauser));
        vault.unpause();
        vm.prank(wl);
        vault.unpause();
        vm.prank(admin);
        vault.pause();
        vm.prank(admin);
        vault.unpause();
        vm.prank(wl);
        vault.pause();
        assertTrue(vault.paused());
    }

    function test_pause_blocksMoneyPaths() public {
        _wlAlice();
        vm.prank(relayer);
        vault.queueRelease(2, alice, 1_500 * U);
        vm.prank(pauser);
        vault.pause();
        bytes4 P = PausableUpgradeable.EnforcedPause.selector;
        vm.startPrank(relayer);
        vm.expectRevert(P);
        vault.release(1, alice, 100 * U);
        vm.expectRevert(P);
        vault.queueRelease(3, alice, 100 * U);
        vm.warp(block.timestamp + 12 hours);
        vm.expectRevert(P);
        vault.executeRelease(2);
        vm.stopPrank();
        token.mint(bob, 100 * U);
        vm.startPrank(bob);
        token.approve(address(vault), 100 * U);
        vm.expectRevert(P);
        vault.deposit(100 * U, bob);
        vm.stopPrank();
        // still usable while paused: cancel / void / revoke / freeze / remove
        vm.prank(wl);
        vault.cancelRelease(2);
        vm.prank(admin);
        vault.voidSource(9);
        vm.prank(admin);
        vault.freezeWhitelist();
        vm.prank(admin);
        vault.emergencyRemove(_one(alice));
        bytes32 R = vault.RELAYER_ROLE();
        vm.prank(admin);
        vault.revokeKey(R, relayer);
    }

    // =========================================================== whitelist-manager handover (invariant 9)
    function test_handover_happyPath() public {
        address wl2;
        uint256 wl2Key;
        (wl2, wl2Key) = makeAddrAndKey("wl2");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotWhitelistManager.selector, admin));
        vault.beginWhitelistManagerTransfer(wl2);
        vm.prank(wl);
        vault.beginWhitelistManagerTransfer(wl2);
        (address cand, uint64 avail, uint64 exp) = vault.pendingWhitelistManager();
        assertEq(cand, wl2);
        assertEq(avail, block.timestamp + 48 hours);
        assertEq(exp, block.timestamp + 48 hours + 7 days);
        vm.warp(block.timestamp + 48 hours - 1);
        vm.prank(wl2);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotReady.selector, uint256(avail)));
        vault.acceptWhitelistManagerTransfer();
        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotCandidate.selector, stranger));
        vault.acceptWhitelistManagerTransfer();
        vm.prank(wl2);
        vault.acceptWhitelistManagerTransfer();
        assertEq(vault.whitelistManager(), wl2);
        // old WL signatures rejected, new accepted
        address[] memory a = _one(alice);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signBatch(vault, wlKey, a, true, 0, deadline);
        vm.expectRevert();
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
        sig = _signBatch(vault, wl2Key, a, true, 0, deadline);
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
        // cancel power followed: old WL can no longer cancel timelock proposals
        bytes32 salt = _propose(address(vault), abi.encodeCall(BridgeBase.unfreezeWhitelist, ()));
        bytes32 id = tl.hashOperation(address(vault), 0, abi.encodeCall(BridgeBase.unfreezeWhitelist, ()), 0, salt);
        vm.prank(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.NotCanceller.selector, wl));
        tl.cancel(id);
        vm.prank(wl2);
        tl.cancel(id);
    }

    function test_handover_expires() public {
        address wl2 = makeAddr("wl2");
        vm.prank(wl);
        vault.beginWhitelistManagerTransfer(wl2);
        vm.warp(block.timestamp + 48 hours + 7 days + 1);
        vm.prank(wl2);
        vm.expectRevert(BridgeBase.Expired.selector);
        vault.acceptWhitelistManagerTransfer();
    }

    function test_handover_cancelAndVeto() public {
        address wl2 = makeAddr("wl2");
        vm.prank(wl);
        vault.beginWhitelistManagerTransfer(wl2);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdminOrWhitelistManager.selector, stranger));
        vault.cancelWhitelistManagerTransfer();
        vm.prank(wl);
        vault.cancelWhitelistManagerTransfer();
        vm.warp(block.timestamp + 48 hours);
        vm.prank(wl2);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotCandidate.selector, wl2));
        vault.acceptWhitelistManagerTransfer();
        // admin veto
        vm.prank(wl);
        vault.beginWhitelistManagerTransfer(wl2);
        vm.prank(admin);
        vault.cancelWhitelistManagerTransfer();
        vm.prank(admin);
        vm.expectRevert(BridgeBase.NothingPending.selector);
        vault.cancelWhitelistManagerTransfer();
    }

    function test_handover_rejectsBadCandidates() public {
        vm.startPrank(wl);
        vm.expectRevert(BridgeBase.ZeroAddress.selector);
        vault.beginWhitelistManagerTransfer(address(0));
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.KeyConflict.selector, wl));
        vault.beginWhitelistManagerTransfer(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.KeyConflict.selector, admin));
        vault.beginWhitelistManagerTransfer(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.KeyConflict.selector, relayer));
        vault.beginWhitelistManagerTransfer(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.KeyConflict.selector, pauser));
        vault.beginWhitelistManagerTransfer(pauser);
        vm.stopPrank();
    }

    function test_handover_acceptRechecksConflict() public {
        address wl2 = makeAddr("wl2");
        vm.prank(wl);
        vault.beginWhitelistManagerTransfer(wl2);
        _viaTimelock(address(vault), abi.encodeCall(IAccessControl.grantRole, (vault.PAUSER_ROLE(), wl2)));
        vm.prank(wl2);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.KeyConflict.selector, wl2));
        vault.acceptWhitelistManagerTransfer();
    }

    // =========================================================== whitelist-manager recovery (invariant 9)
    function test_recovery_happyPathAndAutoUnblock() public {
        (address wl2, uint256 wl2Key) = makeAddrAndKey("wl2");
        vm.prank(wl);
        vault.beginWhitelistManagerTransfer(makeAddr("pendingWl"));
        vm.prank(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdmin.selector, wl));
        vault.startWhitelistRecovery(wl2);
        vm.prank(admin);
        vault.startWhitelistRecovery(wl2);
        assertTrue(vault.whitelistRecoveryActive());
        (address pc,,) = vault.pendingWhitelistManager();
        assertEq(pc, address(0)); // pending handover voided
        // writes blocked: add AND remove
        address[] memory a = _one(alice);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signBatch(vault, wlKey, a, true, 0, deadline);
        vm.expectRevert(BridgeBase.WhitelistWritesBlocked.selector);
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
        sig = _signBatch(vault, wlKey, a, false, 0, deadline);
        vm.expectRevert(BridgeBase.WhitelistWritesBlocked.selector);
        vault.applyWhitelistBatch(a, false, 0, deadline, sig);
        // handover begin blocked during recovery
        vm.prank(wl);
        vm.expectRevert(BridgeBase.RecoveryInProgress.selector);
        vault.beginWhitelistManagerTransfer(makeAddr("x"));
        vm.warp(block.timestamp + 7 days - 1);
        vm.prank(wl2);
        vm.expectRevert();
        vault.acceptWhitelistRecovery();
        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotCandidate.selector, stranger));
        vault.acceptWhitelistRecovery();
        vm.prank(wl2);
        vault.acceptWhitelistRecovery();
        assertEq(vault.whitelistManager(), wl2);
        assertFalse(vault.whitelistRecoveryActive());
        // writable again without a timelock unfreeze
        deadline = block.timestamp + 1 hours;
        sig = _signBatch(vault, wl2Key, a, true, 0, deadline);
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
        assertTrue(vault.whitelisted(alice));
    }

    function test_recovery_symmetricCancelAndCooldown() public {
        address wl2 = makeAddr("wl2");
        vm.prank(admin);
        vault.startWhitelistRecovery(wl2);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdminOrWhitelistManager.selector, stranger));
        vault.cancelWhitelistRecovery();
        vm.prank(wl); // current holder cancels
        vault.cancelWhitelistRecovery();
        assertFalse(vault.whitelistRecoveryActive());
        _wlAlice(); // writes resume immediately
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.RecoveryCooldown.selector, block.timestamp + 3 days));
        vault.startWhitelistRecovery(wl2);
        vm.warp(block.timestamp + 3 days);
        vm.prank(admin);
        vault.startWhitelistRecovery(wl2);
        vm.prank(admin); // initiator may also cancel
        vault.cancelWhitelistRecovery();
        vm.prank(admin);
        vm.expectRevert(BridgeBase.NoRecovery.selector);
        vault.cancelWhitelistRecovery();
    }

    function test_recovery_onlyOneAtATime() public {
        vm.prank(admin);
        vault.startWhitelistRecovery(makeAddr("wl2"));
        vm.prank(admin);
        vm.expectRevert(BridgeBase.RecoveryInProgress.selector);
        vault.startWhitelistRecovery(makeAddr("wl3"));
        // admin recovery cannot start in parallel either
        vm.prank(wl);
        vm.expectRevert(BridgeTimelock.RecoveryInProgress.selector);
        tl.startAdminRecovery(makeAddr("admin2"));
    }

    function test_recovery_blockedWhileAdminRecoveryActive() public {
        vm.prank(wl);
        tl.startAdminRecovery(makeAddr("admin2"));
        assertTrue(vault.anyRecoveryActive());
        vm.prank(admin);
        vm.expectRevert(BridgeBase.RecoveryInProgress.selector);
        vault.startWhitelistRecovery(makeAddr("wl2"));
        // admin recovery also blocks whitelist writes
        address[] memory a = _one(alice);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signBatch(vault, wlKey, a, true, 0, deadline);
        vm.expectRevert(BridgeBase.WhitelistWritesBlocked.selector);
        vault.applyWhitelistBatch(a, true, 0, deadline, sig);
    }

    function test_recovery_rejectsBadCandidates() public {
        vm.startPrank(admin);
        vm.expectRevert(BridgeBase.ZeroAddress.selector);
        vault.startWhitelistRecovery(address(0));
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.KeyConflict.selector, wl));
        vault.startWhitelistRecovery(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.KeyConflict.selector, admin));
        vault.startWhitelistRecovery(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.KeyConflict.selector, relayer));
        vault.startWhitelistRecovery(relayer);
        vm.stopPrank();
    }

    function test_recovery_blocksTimelockExecution() public {
        bytes memory data = abi.encodeCall(BridgeBase.withdraw, (bob, 1 * U));
        bytes32 salt = _propose(address(vault), data);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(admin);
        vault.startWhitelistRecovery(makeAddr("wl2"));
        vm.expectRevert(BridgeTimelock.RecoveryInProgress.selector);
        _execute(address(vault), data, salt);
    }

    function test_recovery_oldWlCannotCancelAfterRecovery() public {
        address wl2 = makeAddr("wl2");
        vm.prank(admin);
        vault.startWhitelistRecovery(wl2);
        vm.warp(block.timestamp + 7 days);
        vm.prank(wl2);
        vault.acceptWhitelistRecovery();
        bytes memory data = abi.encodeCall(BridgeBase.unfreezeWhitelist, ());
        bytes32 salt = _propose(address(vault), data);
        bytes32 id = tl.hashOperation(address(vault), 0, data, 0, salt);
        vm.prank(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeTimelock.NotCanceller.selector, wl));
        tl.cancel(id);
        vm.prank(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotWhitelistManager.selector, wl));
        vault.invalidateWhitelistNonce();
    }

    // =========================================================== payouts (invariants 1, 2, 13)
    function test_payout_emptyWhitelistBlocksAll() public {
        vm.startPrank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotWhitelisted.selector, alice));
        vault.release(1, alice, 100 * U);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotWhitelisted.selector, alice));
        vault.queueRelease(1, alice, 100 * U);
        vm.stopPrank();
    }

    function test_payout_releaseHappy() public {
        _wlAlice();
        bytes32 k = _key(1);
        vm.expectEmit(address(vault));
        emit BridgeBase.Released(k, 1, alice, 1_000 * U);
        vm.prank(relayer);
        vault.release(1, alice, 1_000 * U);
        assertEq(token.balanceOf(alice), 1_000 * U);
        (address to, uint128 amt, uint64 at, uint8 st) = vault.payouts(k);
        assertEq(to, alice);
        assertEq(amt, 1_000 * U);
        assertEq(at, block.timestamp);
        assertEq(st, RELEASED);
        assertEq(vault.dailyUsed(vault.currentDay()), 1_000 * U);
        assertEq(vault.addrDailyUsed(vault.currentDay(), alice), 1_000 * U);
    }

    function test_payout_releaseOnlyRelayer() public {
        _wlAlice();
        vm.prank(admin);
        vm.expectRevert();
        vault.release(1, alice, 100 * U);
    }

    function test_payout_releaseLimits() public {
        _wlAlice();
        vm.startPrank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.AmountAboveLimit.selector, 1_000 * U + 1, 1_000 * U));
        vault.release(1, alice, 1_000 * U + 1);
        vm.expectRevert(BridgeBase.ZeroAmount.selector);
        vault.release(1, alice, 0);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.AmountAboveLimit.selector, 2_000 * U + 1, 2_000 * U));
        vault.queueRelease(1, alice, 2_000 * U + 1);
        vm.stopPrank();
    }

    function test_payout_onceOnly() public {
        _wlAlice();
        vm.startPrank(relayer);
        vault.release(1, alice, 100 * U);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, _key(1), RELEASED));
        vault.release(1, alice, 100 * U);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, _key(1), RELEASED));
        vault.queueRelease(1, alice, 100 * U);
        vm.stopPrank();
        bytes32 k1_798 = _key(1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, k1_798, RELEASED));
        vault.voidSource(1);
    }

    function test_payout_voidedNeverPays() public {
        _wlAlice();
        vm.prank(admin);
        vault.voidSource(1);
        assertEq(_status(1), VOIDED);
        vm.startPrank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, _key(1), VOIDED));
        vault.release(1, alice, 100 * U);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, _key(1), VOIDED));
        vault.queueRelease(1, alice, 100 * U);
        vm.stopPrank();
        bytes32 k1_814 = _key(1);
        vm.prank(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, k1_814, VOIDED));
        vault.voidSource(1);
    }

    function test_payout_queueAndExecute() public {
        _wlAlice();
        vm.prank(relayer);
        vault.queueRelease(5, alice, 1_500 * U);
        assertEq(_status(5), QUEUED);
        assertEq(vault.dailyUsed(vault.currentDay()), 1_500 * U);
        vm.warp(block.timestamp + 12 hours - 1);
        vm.prank(relayer);
        vm.expectRevert();
        vault.executeRelease(5);
        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        vm.expectRevert();
        vault.executeRelease(5);
        vm.prank(relayer);
        vault.executeRelease(5);
        assertEq(_status(5), RELEASED);
        assertEq(token.balanceOf(alice), 1_500 * U);
        bytes32 k5_837 = _key(5);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, k5_837, RELEASED));
        vault.executeRelease(5);
    }

    function test_payout_executeRequiresStillWhitelisted() public {
        _wlAlice();
        vm.prank(relayer);
        vault.queueRelease(5, alice, 1_500 * U);
        _applyBatch(vault, _one(alice), false);
        vm.warp(block.timestamp + 12 hours);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotWhitelisted.selector, alice));
        vault.executeRelease(5);
    }

    function test_payout_replayQueueIsIdempotent() public {
        _wlAlice();
        vm.startPrank(relayer);
        vault.queueRelease(5, alice, 1_500 * U);
        vault.queueRelease(5, alice, 1_500 * U); // crash-replay
        assertEq(vault.dailyUsed(vault.currentDay()), 1_500 * U);
        assertEq(vault.addrDailyUsed(vault.currentDay(), alice), 1_500 * U);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, _key(5), QUEUED));
        vault.queueRelease(5, alice, 1_400 * U); // different payload is not a replay
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, _key(5), QUEUED));
        vault.release(5, alice, 500 * U);
        vm.stopPrank();
    }

    function test_payout_cancelReleaseRefundsSameDayQuota() public {
        _wlAlice();
        vm.prank(relayer);
        vault.queueRelease(5, alice, 1_500 * U);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdminOrWhitelistManager.selector, relayer));
        vault.cancelRelease(5);
        vm.prank(wl);
        vault.cancelRelease(5);
        assertEq(_status(5), VOIDED);
        assertEq(vault.dailyUsed(vault.currentDay()), 0);
        assertEq(vault.addrDailyUsed(vault.currentDay(), alice), 0);
        bytes32 k6_879 = _key(6);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadPayoutStatus.selector, k6_879, NONE));
        vault.cancelRelease(6);
    }

    function test_payout_voidNextDayDoesNotRefund() public {
        _wlAlice();
        vm.prank(relayer);
        vault.queueRelease(5, alice, 1_500 * U);
        uint256 d0 = vault.currentDay();
        vm.warp(block.timestamp + 1 days);
        vm.prank(admin);
        vault.voidSource(5);
        assertEq(vault.dailyUsed(d0), 1_500 * U);
        assertEq(vault.dailyUsed(vault.currentDay()), 0);
    }

    function test_payout_voidSourceBatch() public {
        _wlAlice();
        vm.prank(relayer);
        vault.queueRelease(5, alice, 100 * U);
        uint256[] memory ns = new uint256[](3);
        ns[0] = 4;
        ns[1] = 5;
        ns[2] = 6;
        vm.prank(stranger);
        vm.expectRevert();
        vault.voidSourceBatch(ns);
        vm.prank(admin);
        vault.voidSourceBatch(ns);
        assertEq(_status(4), VOIDED);
        assertEq(_status(5), VOIDED);
        assertEq(_status(6), VOIDED);
    }

    // =========================================================== daily caps (invariant 3)
    function test_cap_global() public {
        address[] memory us = new address[](3);
        us[0] = alice;
        us[1] = bob;
        us[2] = carol;
        _applyBatch(vault, us, true);
        vm.startPrank(relayer);
        vault.queueRelease(1, alice, 2_000 * U);
        vault.queueRelease(2, bob, 2_000 * U);
        vault.release(3, carol, 1_000 * U);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.DailyCapExceeded.selector, 5_000 * U + 1, 5_000 * U));
        vault.release(4, carol, 1);
        vm.stopPrank();
    }

    function test_cap_perAddress() public {
        _wlAlice();
        vm.startPrank(relayer);
        vault.release(1, alice, 1_000 * U);
        vault.release(2, alice, 1_000 * U);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeBase.AddrDailyCapExceeded.selector, alice, 2_000 * U + 1, 2_000 * U)
        );
        vault.release(3, alice, 1);
        vm.stopPrank();
    }

    function test_cap_resetsAtUtcMidnight() public {
        _wlAlice();
        vm.warp(1_767_225_600 + 1 days - 1); // 23:59:59 UTC
        vm.startPrank(relayer);
        vault.release(1, alice, 1_000 * U);
        vault.release(2, alice, 1_000 * U);
        vm.expectRevert();
        vault.release(3, alice, 1);
        vm.warp(1_767_225_600 + 1 days); // 00:00:00 next day
        vault.release(3, alice, 1_000 * U);
        vault.release(4, alice, 1_000 * U);
        vm.stopPrank();
        assertEq(token.balanceOf(alice), 4_000 * U); // 2x worst case across midnight (documented)
    }

    // =========================================================== deposits & deposit refunds
    function _deposit(address from, uint256 amount) internal returns (uint256 nonce) {
        token.mint(from, amount);
        vm.startPrank(from);
        token.approve(address(vault), amount);
        nonce = vault.deposit(amount, makeAddr("wantosRecipient"));
        vm.stopPrank();
    }

    function test_deposit_happy() public {
        token.mint(bob, 500 * U);
        vm.startPrank(bob);
        token.approve(address(vault), 500 * U);
        vm.expectEmit(address(vault));
        emit BscVaultV2.Deposited(1, bob, carol, 500 * U);
        uint256 nonce = vault.deposit(500 * U, carol);
        vm.stopPrank();
        assertEq(nonce, 1);
        assertEq(vault.depositNonce(), 1);
        (address from, uint128 amt,, uint8 st) = vault.deposits(1);
        assertEq(from, bob);
        assertEq(amt, 500 * U);
        assertEq(st, 0);
        assertEq(_deposit(bob, 20 * U), 2);
    }

    function test_deposit_bounds() public {
        token.mint(bob, 10_000 * U);
        vm.startPrank(bob);
        token.approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.AmountBelowMinimum.selector, 10 * U - 1, 10 * U));
        vault.deposit(10 * U - 1, carol);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.AmountAboveLimit.selector, 2_000 * U + 1, 2_000 * U));
        vault.deposit(2_000 * U + 1, carol);
        vm.expectRevert(BridgeBase.ZeroAddress.selector);
        vault.deposit(100 * U, address(0));
        vault.deposit(10 * U, carol);
        vault.deposit(2_000 * U, carol);
        vm.stopPrank();
    }

    function test_depositRefund_flow() public {
        uint256 n = _deposit(bob, 700 * U);
        uint256 balBefore = token.balanceOf(bob);
        vm.prank(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdmin.selector, wl));
        vault.requestDepositRefund(n);
        vm.prank(admin);
        vault.requestDepositRefund(n);
        vm.warp(block.timestamp + 24 hours - 1);
        vm.expectRevert();
        vault.executeDepositRefund(n);
        vm.warp(block.timestamp + 1);
        vm.prank(stranger); // anyone may execute
        vault.executeDepositRefund(n);
        assertEq(token.balanceOf(bob), balBefore + 700 * U);
        assertEq(vault.dailyUsed(vault.currentDay()), 700 * U); // counted in dailyCap
        (,,, uint8 st) = vault.deposits(n);
        assertEq(st, 2);
        vm.expectRevert();
        vault.executeDepositRefund(n);
        vm.prank(admin);
        vm.expectRevert();
        vault.requestDepositRefund(n);
    }

    function test_depositRefund_cancelByEitherWallet() public {
        uint256 n = _deposit(bob, 700 * U);
        vm.prank(admin);
        vault.requestDepositRefund(n);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdminOrWhitelistManager.selector, stranger));
        vault.cancelDepositRefund(n);
        vm.prank(wl);
        vault.cancelDepositRefund(n);
        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert();
        vault.executeDepositRefund(n);
        vm.prank(admin);
        vault.requestDepositRefund(n); // can be requested again
        vm.prank(admin);
        vault.cancelDepositRefund(n);
    }

    function test_depositRefund_unknownNonceAndCapAndPause() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BscVaultV2.UnknownDeposit.selector, 99));
        vault.requestDepositRefund(99);
        _wlAlice();
        uint256 n = _deposit(bob, 2_000 * U);
        vm.prank(admin);
        vault.requestDepositRefund(n);
        vm.warp(block.timestamp + 24 hours);
        vm.prank(relayer);
        vault.release(1, alice, 1_000 * U);
        vm.prank(relayer);
        vault.queueRelease(2, alice, 1_000 * U);
        // cannot use the "release" helper for more than per-addr; use other users
        vm.prank(pauser);
        vault.pause();
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vault.executeDepositRefund(n);
        vm.prank(wl);
        vault.unpause();
        _applyBatch(vault, _one(bob), true);
        vm.prank(relayer);
        vault.queueRelease(3, bob, 1_500 * U); // used = 3500
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.DailyCapExceeded.selector, 5_500 * U, 5_000 * U));
        vault.executeDepositRefund(n);
    }

    // =========================================================== fund / withdraw (invariant 4)
    function test_fund() public {
        token.mint(bob, 100 * U);
        vm.startPrank(bob);
        token.approve(address(vault), 100 * U);
        vm.expectEmit(address(vault));
        emit BridgeBase.Funded(bob, 100 * U);
        vault.fund(100 * U);
        vm.expectRevert(BridgeBase.ZeroAmount.selector);
        vault.fund(0);
        vm.stopPrank();
    }

    function test_withdraw_onlyTimelock() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTimelock.selector, admin));
        vault.withdraw(admin, 1);
        _viaTimelock(address(vault), abi.encodeCall(BridgeBase.withdraw, (bob, 1_000 * U)));
        assertEq(token.balanceOf(bob), 1_000 * U);
    }

    function test_withdraw_blockedWhilePausedAndBefore48h() public {
        bytes memory data = abi.encodeCall(BridgeBase.withdraw, (bob, 1_000 * U));
        bytes32 salt = _propose(address(vault), data);
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert();
        _execute(address(vault), data, salt);
        vm.warp(block.timestamp + 1);
        vm.prank(pauser);
        vault.pause();
        vm.expectRevert();
        _execute(address(vault), data, salt);
        vm.prank(wl);
        vault.unpause();
        _execute(address(vault), data, salt);
    }

    // =========================================================== legacy payouts (invariant 14)
    function _legacy(bytes32[] memory k, address[] memory to, uint256[] memory amt)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(BscVaultV2.payLegacyBatch, (k, to, amt));
    }

    function test_legacy_paysOnce() public {
        bytes32[] memory k = new bytes32[](2);
        k[0] = keccak256(abi.encode(bytes32("tx1"), uint256(3)));
        k[1] = keccak256(abi.encode(bytes32("tx2"), uint256(0)));
        address[] memory to = _two(bob, carol); // not whitelisted: allowed
        uint256[] memory amt = new uint256[](2);
        amt[0] = 100 * U;
        amt[1] = 200 * U;
        _viaTimelock(address(vault), _legacy(k, to, amt));
        assertEq(token.balanceOf(bob), 100 * U);
        assertEq(token.balanceOf(carol), 200 * U);
        assertTrue(vault.legacyPaid(k[0]));
        assertEq(vault.dailyUsed(vault.currentDay()), 0); // not counted in daily cap
        // paying the same oldKey again fails
        bytes memory again = _legacy(k, to, amt);
        bytes32 salt = _propose(address(vault), again);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        _execute(address(vault), again, salt);
    }

    function test_legacy_duplicateWithinBatchAndBadInput() public {
        bytes32[] memory k = new bytes32[](2);
        k[0] = bytes32("a");
        k[1] = bytes32("a");
        uint256[] memory amt = new uint256[](2);
        amt[0] = 1;
        amt[1] = 1;
        vm.prank(address(tl));
        vm.expectRevert(abi.encodeWithSelector(BscVaultV2.LegacyAlreadyPaid.selector, bytes32("a")));
        vault.payLegacyBatch(k, _two(bob, carol), amt);
        vm.prank(address(tl));
        vm.expectRevert(BridgeBase.LengthMismatch.selector);
        vault.payLegacyBatch(k, _one(bob), amt);
        bytes32[] memory big = new bytes32[](101);
        vm.prank(address(tl));
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.BadBatchSize.selector, 101));
        vault.payLegacyBatch(big, new address[](101), new uint256[](101));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTimelock.selector, admin));
        vault.payLegacyBatch(k, _two(bob, carol), amt);
    }

    function test_legacy_blockedWhilePaused() public {
        bytes32[] memory k = new bytes32[](1);
        k[0] = bytes32("a");
        uint256[] memory amt = new uint256[](1);
        amt[0] = 1;
        vm.prank(pauser);
        vault.pause();
        vm.prank(address(tl));
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        vault.payLegacyBatch(k, _one(bob), amt);
    }

    // =========================================================== params (invariant 12)
    function test_params_adminTightenImmediate() public {
        BscVaultV2.Params memory p = _bscParams();
        p.dailyCap = 4_000 * U;
        p.perAddrDailyCap = 1_500 * U;
        p.largeThreshold = 500 * U;
        p.releaseDelay = 24 hours;
        p.minDeposit = 20 * U;
        p.maxDepositPerTx = 1_000 * U;
        vm.prank(pauser);
        vault.pause(); // tightening works while paused
        vm.prank(admin);
        vault.setParams(p);
        assertEq(vault.params().dailyCap, 4_000 * U);
        assertEq(vault.params().releaseDelay, 24 hours);
    }

    function test_params_adminSmuggledLoosenRevertsWhole() public {
        BscVaultV2.Params memory p = _bscParams();
        p.dailyCap = 4_000 * U; // tighten
        p.releaseDelay = 6 hours; // loosen
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTightening.selector, 3));
        vault.setParams(p);
        assertEq(vault.params().dailyCap, 5_000 * U);
        // each field individually
        for (uint256 i; i < 6; i++) {
            p = _bscParams();
            if (i == 0) p.dailyCap += 1;
            if (i == 1) p.perAddrDailyCap += 1;
            if (i == 2) p.largeThreshold += 1;
            if (i == 3) p.releaseDelay -= 1;
            if (i == 4) p.minDeposit -= 1;
            if (i == 5) p.maxDepositPerTx += 1;
            vm.prank(admin);
            vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTightening.selector, i));
            vault.setParams(p);
        }
    }

    function test_params_tightenCannotBreakFloorsOrConstraints() public {
        BscVaultV2.Params memory p = _bscParams();
        p.dailyCap = 999 * U;
        p.perAddrDailyCap = 999 * U;
        p.largeThreshold = 999 * U;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.ParamOutOfRange.selector, 0));
        vault.setParams(p);
        p = _bscParams();
        p.perAddrDailyCap = 99 * U;
        p.largeThreshold = 99 * U;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.ParamOutOfRange.selector, 1));
        vault.setParams(p);
        p = _bscParams();
        p.perAddrDailyCap = 900 * U; // below largeThreshold 1000 -> constraint
        vm.prank(admin);
        vm.expectRevert(BridgeBase.ParamConstraint.selector);
        vault.setParams(p);
        p = _bscParams();
        p.minDeposit = 20_001 * U;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.ParamOutOfRange.selector, 4));
        vault.setParams(p);
    }

    function test_params_strangerRejected() public {
        vm.prank(wl);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAuthorized.selector, wl));
        vault.setParams(_bscParams());
    }

    function test_params_loosenViaTimelockNotWhilePaused() public {
        BscVaultV2.Params memory p = _bscParams();
        p.dailyCap = 50_000 * U;
        p.perAddrDailyCap = 20_000 * U;
        p.releaseDelay = 6 hours;
        bytes memory data = abi.encodeCall(BscVaultV2.setParams, (p));
        bytes32 salt = _propose(address(vault), data);
        vm.warp(block.timestamp + 48 hours);
        vm.prank(pauser);
        vault.pause();
        vm.expectRevert();
        _execute(address(vault), data, salt);
        vm.prank(admin);
        vault.unpause();
        _execute(address(vault), data, salt);
        assertEq(vault.params().dailyCap, 50_000 * U);
        // even the timelock must respect ranges
        p.dailyCap = 500_001 * U;
        data = abi.encodeCall(BscVaultV2.setParams, (p));
        salt = _propose(address(vault), data);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        _execute(address(vault), data, salt);
    }

    // =========================================================== upgrade gate
    function test_upgrade_onlyTimelockAndWorksWhilePaused() public {
        BscVaultV2 newImpl = new BscVaultV2();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotTimelock.selector, admin));
        vault.upgradeToAndCall(address(newImpl), "");
        vm.prank(pauser);
        vault.pause();
        _viaTimelock(address(vault), abi.encodeCall(vault.upgradeToAndCall, (address(newImpl), "")));
        assertEq(
            address(
                uint160(
                    uint256(vm.load(address(vault), 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc))
                )
            ),
            address(newImpl)
        );
    }

    function test_upgrade_blockedDuringRecoveryEvenIfCalledByTimelock() public {
        BscVaultV2 newImpl = new BscVaultV2();
        vm.prank(admin);
        vault.startWhitelistRecovery(makeAddr("wl2"));
        vm.prank(address(tl));
        vm.expectRevert(BridgeBase.RecoveryInProgress.selector);
        vault.upgradeToAndCall(address(newImpl), "");
    }

    function test_supportsInterface() public view {
        assertTrue(vault.supportsInterface(type(IAccessControl).interfaceId));
    }
}
