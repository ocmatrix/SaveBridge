// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PredictAddresses} from "../script/PredictAddresses.s.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Verify} from "../script/Verify.s.sol";
import {BscVaultV2} from "../src/BscVaultV2.sol";
import {WantosBridgeV2} from "../src/WantosBridgeV2.sol";
import {BridgeTimelock} from "../src/BridgeTimelock.sol";
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

        vm.chainId(56);
        Deploy.Deployed memory b = deployer.deployBsc(_common(address(bscUsdt), 13555), _bscParams());
        assertEq(b.timelock, p.timelock);
        assertEq(b.implementation, p.implementation);
        assertEq(b.proxy, p.proxy);
        assertEq(vm.getNonce(dep), 3);
        verifier.verify(_expect(b, address(bscUsdt), 13555, abi.encode(_bscParams()), 0, true));

        vm.revertToState(snap); // "the other chain"
        vm.chainId(13555);
        uint256 ceiling = wantosUsdt.totalSupply() + 10_000 * U;
        Deploy.Deployed memory w = deployer.deployWantos(_common(address(wantosUsdt), 56), _wParams(), ceiling);
        assertEq(w.timelock, p.timelock);
        assertEq(w.implementation, p.implementation);
        assertEq(w.proxy, p.proxy);
        verifier.verify(_expect(w, address(wantosUsdt), 56, abi.encode(_wParams()), ceiling, false));
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
        deployer.deployBsc(_common(address(bscUsdt), 13555), _bscParams());
    }

    function test_deployRefusesOccupiedPredictedAddress() public {
        vm.etch(vm.computeCreateAddress(dep, 2), hex"00");
        vm.expectRevert(bytes("Deploy: predicted address has code"));
        deployer.deployBsc(_common(address(bscUsdt), 13555), _bscParams());
    }

    function test_verifyCatchesMismatches() public {
        vm.chainId(56);
        Deploy.Deployed memory b = deployer.deployBsc(_common(address(bscUsdt), 13555), _bscParams());
        Verify.Expect memory e = _expect(b, address(bscUsdt), 13555, abi.encode(_bscParams()), 0, true);

        Verify.Expect memory bad = e;
        bad.adminWallet = makeAddr("x");
        vm.expectRevert();
        verifier.verify(bad);

        bad = _expect(b, address(bscUsdt), 13555, abi.encode(_bscParams()), 0, true);
        bad.implementationCodehash = keccak256("other");
        vm.expectRevert(bytes("Verify: implementation codehash"));
        verifier.verify(bad);

        bad = _expect(b, address(bscUsdt), 13555, abi.encode(_bscParams()), 0, true);
        bad.encodedParams = abi.encode(BscVaultV2.Params(5_000 * U, 2_000 * U, 1_000 * U, 24 hours, 10 * U, 2_000 * U));
        vm.expectRevert(bytes("Verify: params"));
        verifier.verify(bad);

        bad = _expect(b, address(bscUsdt), 13555, abi.encode(_bscParams()), 0, true);
        bad.relayer = makeAddr("r");
        vm.expectRevert(bytes("Verify: relayer role"));
        verifier.verify(bad);
    }

    function test_verifyCatchesNonEmptyWhitelistAndPause() public {
        vm.chainId(56);
        Deploy.Deployed memory b = deployer.deployBsc(_common(address(bscUsdt), 13555), _bscParams());
        Verify.Expect memory e = _expect(b, address(bscUsdt), 13555, abi.encode(_bscParams()), 0, true);
        vm.prank(wl);
        BscVaultV2(b.proxy).invalidateWhitelistNonce(); // any whitelist activity moves the nonce
        vm.expectRevert(bytes("Verify: whitelist not empty"));
        verifier.verify(e);
    }

    function test_timelockOfDeployHasNoDeployerPower() public {
        vm.chainId(56);
        Deploy.Deployed memory b = deployer.deployBsc(_common(address(bscUsdt), 13555), _bscParams());
        BridgeTimelock t = BridgeTimelock(payable(b.timelock));
        assertFalse(t.hasRole(t.PROPOSER_ROLE(), dep));
        assertFalse(t.hasRole(t.DEFAULT_ADMIN_ROLE(), dep));
        assertFalse(BscVaultV2(b.proxy).hasRole(bytes32(0), dep));
    }
}
