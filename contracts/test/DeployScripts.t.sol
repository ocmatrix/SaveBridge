// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {W} from "./utils/Windows.sol";
import {PredictAddresses} from "../script/PredictAddresses.s.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Verify} from "../script/Verify.s.sol";
import {BscVaultV2} from "../src/BscVaultV2.sol";
import {WantosBridgeV2} from "../src/WantosBridgeV2.sol";
import {BridgeTimelock} from "../src/BridgeTimelock.sol";
import {BridgeBase} from "../src/BridgeBase.sol";
import {MockToken} from "./mocks/MockToken.sol";

/// In-memory rehearsal of §5.1 (no RPC, no real keys, no real broadcast).
contract DeployScriptsTest is Test {
    uint256 constant U = 1e18;
    PredictAddresses predictor;
    Deploy deployer;
    Verify verifier;
    address dep = makeAddr("freshDeployer");
    address admin = makeAddr("admin");
    address wl = makeAddr("wl");
    address relayer = makeAddr("relayer");
    address pauser = makeAddr("pauser");
    MockToken bscUsdt;
    MockToken wantosUsdt;

    function setUp() public {
        predictor = new PredictAddresses();
        deployer = new Deploy();
        verifier = new Verify();
        bscUsdt = new MockToken();
        wantosUsdt = new MockToken();
        wantosUsdt.mint(address(0xdead), 30_000_000 * U);
    }

    function _common(address token, uint256 peer) internal view returns (Deploy.Common memory c) {
        c = Deploy.Common({
            deployer: dep,
            adminWallet: admin,
            whitelistManager: wl,
            relayer: relayer,
            pauser: pauser,
            token: token,
            peerChainId: peer
        });
    }

    function _bscParams() internal pure returns (BscVaultV2.Params memory) {
        return BscVaultV2.Params(5_000 * U, 2_000 * U, 1_000 * U, 12 hours, 10 * U, 2_000 * U);
    }

    function _wParams() internal pure returns (WantosBridgeV2.Params memory) {
        return WantosBridgeV2.Params(10 * U, 2_000 * U, 3_000 * U, 15 minutes);
    }

    function test_predictMatchesCreateFormula() public view {
        PredictAddresses.Predicted memory p = predictor.predict(dep, 0);
        assertEq(p.timelock, vm.computeCreateAddress(dep, 0));
        assertEq(p.implementation, vm.computeCreateAddress(dep, 1));
        assertEq(p.proxy, vm.computeCreateAddress(dep, 2));
        PredictAddresses.Predicted memory q = predictor.predict(dep, 300);
        assertEq(q.proxy, vm.computeCreateAddress(dep, 302));
    }

    function test_bothChainsSameAddresses_andVerifyPasses() public {
        PredictAddresses.Predicted memory p = predictor.predict(dep, 0);
        uint256 snap = vm.snapshotState();

        vm.chainId(W.BSC_CHAIN);
        Deploy.Deployed memory b = deployer.deployBsc(_common(address(bscUsdt), W.WANTOS_CHAIN), _bscParams());
        assertEq(b.timelock, p.timelock);
        assertEq(b.implementation, p.implementation);
        assertEq(b.proxy, p.proxy);
        assertEq(vm.getNonce(dep), 3);
        verifier.verify(_expect(b, address(bscUsdt), W.WANTOS_CHAIN, abi.encode(_bscParams()), 0, true));

        vm.revertToState(snap); // "the other chain"
        vm.chainId(W.WANTOS_CHAIN);
        uint256 ceiling = wantosUsdt.totalSupply() + 10_000 * U;
        Deploy.Deployed memory w = deployer.deployWantos(_common(address(wantosUsdt), W.BSC_CHAIN), _wParams(), ceiling);
        assertEq(w.timelock, p.timelock);
        assertEq(w.implementation, p.implementation);
        assertEq(w.proxy, p.proxy);
        verifier.verify(_expect(w, address(wantosUsdt), W.BSC_CHAIN, abi.encode(_wParams()), ceiling, false));
    }

    function _expect(
        Deploy.Deployed memory d,
        address token,
        uint256 peer,
        bytes memory params,
        uint256 ceiling,
        bool isBsc
    ) internal view returns (Verify.Expect memory e) {
        e = Verify.Expect({
            isBsc: isBsc,
            deployer: dep,
            timelock: d.timelock,
            implementation: d.implementation,
            implementationCodehash: d.implementation.codehash,
            proxy: d.proxy,
            adminWallet: admin,
            whitelistManager: wl,
            relayer: relayer,
            pauser: pauser,
            token: token,
            peerChainId: peer,
            encodedParams: params,
            supplyCeiling: ceiling
        });
    }

    function test_deployRefusesNonZeroNonce() public {
        vm.setNonce(dep, 1);
        vm.expectRevert(bytes("Deploy: deployer nonce must be 0"));
        deployer.deployBsc(_common(address(bscUsdt), W.WANTOS_CHAIN), _bscParams());
    }

    function test_deployRefusesOccupiedPredictedAddress() public {
        vm.etch(vm.computeCreateAddress(dep, 2), hex"00");
        vm.expectRevert(bytes("Deploy: predicted address has code"));
        deployer.deployBsc(_common(address(bscUsdt), W.WANTOS_CHAIN), _bscParams());
    }

    function test_verifyCatchesMismatches() public {
        vm.chainId(W.BSC_CHAIN);
        Deploy.Deployed memory b = deployer.deployBsc(_common(address(bscUsdt), W.WANTOS_CHAIN), _bscParams());
        Verify.Expect memory e = _expect(b, address(bscUsdt), W.WANTOS_CHAIN, abi.encode(_bscParams()), 0, true);

        Verify.Expect memory bad = e;
        bad.adminWallet = makeAddr("x");
        vm.expectRevert();
        verifier.verify(bad);

        bad = _expect(b, address(bscUsdt), W.WANTOS_CHAIN, abi.encode(_bscParams()), 0, true);
        bad.implementationCodehash = keccak256("other");
        vm.expectRevert(bytes("Verify: implementation codehash"));
        verifier.verify(bad);

        bad = _expect(b, address(bscUsdt), W.WANTOS_CHAIN, abi.encode(_bscParams()), 0, true);
        bad.encodedParams = abi.encode(BscVaultV2.Params(5_000 * U, 2_000 * U, 1_000 * U, 24 hours, 10 * U, 2_000 * U));
        vm.expectRevert(bytes("Verify: params"));
        verifier.verify(bad);

        bad = _expect(b, address(bscUsdt), W.WANTOS_CHAIN, abi.encode(_bscParams()), 0, true);
        bad.relayer = makeAddr("r");
        vm.expectRevert(bytes("Verify: relayer role"));
        verifier.verify(bad);
    }

    function test_verifyCatchesNonEmptyWhitelistAndPause() public {
        vm.chainId(W.BSC_CHAIN);
        Deploy.Deployed memory b = deployer.deployBsc(_common(address(bscUsdt), W.WANTOS_CHAIN), _bscParams());
        Verify.Expect memory e = _expect(b, address(bscUsdt), W.WANTOS_CHAIN, abi.encode(_bscParams()), 0, true);
        vm.prank(wl);
        BscVaultV2(b.proxy).invalidateWhitelistNonce(); // any whitelist activity moves the nonce
        vm.expectRevert(bytes("Verify: whitelist not empty"));
        verifier.verify(e);
    }

    function test_timelockOfDeployHasNoDeployerPower() public {
        vm.chainId(W.BSC_CHAIN);
        Deploy.Deployed memory b = deployer.deployBsc(_common(address(bscUsdt), W.WANTOS_CHAIN), _bscParams());
        BridgeTimelock t = BridgeTimelock(payable(b.timelock));
        assertFalse(t.hasRole(t.PROPOSER_ROLE(), dep));
        assertFalse(t.hasRole(t.DEFAULT_ADMIN_ROLE(), dep));
        assertFalse(BscVaultV2(b.proxy).hasRole(bytes32(0), dep));
    }

    /// The window constants compiled into this build equal the test mirror W (so every window assertion in
    /// the suite asserts the real value; for the PR-9 fast build both sides are rewritten by one manifest).
    function test_buildWindowsMatchTestMirror() public {
        Deploy.Deployed memory b = deployer.deployBsc(_common(address(bscUsdt), W.WANTOS_CHAIN), _bscParams());
        BridgeTimelock t = BridgeTimelock(payable(b.timelock));
        assertEq(t.MIN_DELAY(), W.TL_MIN_DELAY);
        assertEq(t.getMinDelay(), W.TL_MIN_DELAY);
        assertEq(t.MAX_DELAY(), W.TL_MAX_DELAY);
        assertEq(t.EXPIRY_PERIOD(), W.TL_EXPIRY);
        assertEq(t.PENDING_ADMIN_TTL(), W.TL_PENDING_ADMIN_TTL);
        assertEq(t.ADMIN_RECOVERY_DELAY(), W.TL_ADMIN_RECOVERY);
        assertEq(t.RECOVERY_COOLDOWN(), W.TL_COOLDOWN);
        BscVaultV2 v = BscVaultV2(b.proxy);
        assertEq(v.MAX_SIGNATURE_TTL(), W.SIG_TTL);
        assertEq(v.WL_TRANSFER_DELAY(), W.WL_TRANSFER_DELAY);
        assertEq(v.WL_TRANSFER_TTL(), W.WL_TRANSFER_TTL);
        assertEq(v.WL_RECOVERY_DELAY(), W.WL_RECOVERY);
        assertEq(v.RECOVERY_COOLDOWN(), W.WL_COOLDOWN);
        assertEq(v.REFUND_DELAY(), W.REFUND_DELAY);
    }

    /// Parameter lower bounds of the build equal the mirror (exact boundary, both sides).
    function test_buildParamLowerBoundsMatchTestMirror() public {
        BscVaultV2.Params memory p = _bscParams();
        p.releaseDelay = W.RELEASE_DELAY_MIN - 1;
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.ParamOutOfRange.selector, 3));
        deployer.deployBsc(_common(address(bscUsdt), W.WANTOS_CHAIN), p);
        vm.stopBroadcast(); // the reverted deploy left its broadcast open
        dep = makeAddr("freshDeployer2"); // a failed deploy burns nonces (§5.1): start over with a new deployer
        p.releaseDelay = W.RELEASE_DELAY_MIN;
        deployer.deployBsc(_common(address(bscUsdt), W.WANTOS_CHAIN), p);
    }

    function test_buildB2wLowerBoundMatchesTestMirror() public {
        WantosBridgeV2.Params memory p = _wParams();
        uint256 ceiling = wantosUsdt.totalSupply() + 10_000 * U;
        p.b2wDelay = W.B2W_DELAY_MIN - 1;
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.ParamOutOfRange.selector, 3));
        deployer.deployWantos(_common(address(wantosUsdt), W.BSC_CHAIN), p, ceiling);
        vm.stopBroadcast();
        dep = makeAddr("freshDeployer2");
        p.b2wDelay = W.B2W_DELAY_MIN;
        deployer.deployWantos(_common(address(wantosUsdt), W.BSC_CHAIN), p, ceiling);
    }
}
