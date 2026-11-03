// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DeployFast} from "../script/DeployFast.s.sol";
import {Verify} from "../script/Verify.s.sol";
import {BridgeTimelock} from "../src/BridgeTimelock.sol";
import {BscVaultV2} from "../src/BscVaultV2.sol";
import {WantosBridgeV2} from "../src/WantosBridgeV2.sol";
import {MockToken} from "./mocks/MockToken.sol";

/// Production Deploy with its pre-broadcast probe bypassed: the post-deploy MIN_DELAY re-check must still refuse.
contract DeployProbeBypassed is Deploy {
    function _requireBuildWindows() internal override {}
}

/// PR-9 testnet-fast only (generated tree). Mainnet guards in both directions:
///  - the fast bytecode cannot be created on any chain other than 1345 / 97 / 31337 / 31338;
///  - DeployFast refuses other chains before creating anything;
///  - the production Deploy script refuses the fast bytecode on every chain.
contract FastGuardsTest is Test {
    uint256 constant U = 1e18;
    address dep = makeAddr("freshDeployer");
    address admin = makeAddr("admin");
    address wl = makeAddr("wl");
    address relayer = makeAddr("relayer");
    address pauser = makeAddr("pauser");
    MockToken token;
    DeployFast fast;
    Deploy prod;

    uint256[6] internal forbidden = [uint256(56), 13555, 1, 137, 204, 5611];
    uint256[4] internal allowed = [uint256(1345), 97, 31337, 31338];

    function setUp() public {
        token = new MockToken();
        token.mint(address(0xdead), 1_000_000 * U);
        fast = new DeployFast();
        prod = new Deploy();
    }

    function _common(uint256 peer) internal view returns (Deploy.Common memory) {
        return Deploy.Common(dep, admin, wl, relayer, pauser, address(token), peer);
    }

    function _bscParams() internal pure returns (BscVaultV2.Params memory) {
        return BscVaultV2.Params(5_000 * U, 2_000 * U, 1_000 * U, 2 minutes, 10 * U, 2_000 * U);
    }

    function _wParams() internal pure returns (WantosBridgeV2.Params memory) {
        return WantosBridgeV2.Params(10 * U, 2_000 * U, 3_000 * U, 1 minutes);
    }

    // ---------------------------------------------------------------- bytecode chain guard
    function test_fastTimelockCannotBeCreatedOffTestnet() public {
        for (uint256 i; i < forbidden.length; i++) {
            vm.chainId(forbidden[i]);
            vm.expectRevert(bytes("TESTNET_FAST_ONLY"));
            new BridgeTimelock(admin, address(0xb0b));
        }
    }

    function test_fastImplementationsCannotBeCreatedOffTestnet() public {
        for (uint256 i; i < forbidden.length; i++) {
            vm.chainId(forbidden[i]);
            vm.expectRevert(bytes("TESTNET_FAST_ONLY"));
            new BscVaultV2();
            vm.expectRevert(bytes("TESTNET_FAST_ONLY"));
            new WantosBridgeV2();
        }
    }

    function test_fastBytecodeCreatesOnTestnets() public {
        for (uint256 i; i < allowed.length; i++) {
            vm.chainId(allowed[i]);
            BridgeTimelock t = new BridgeTimelock(admin, address(0xb0b));
            assertEq(t.MIN_DELAY(), 2 minutes);
            new BscVaultV2();
            new WantosBridgeV2();
        }
    }

    // ---------------------------------------------------------------- DeployFast chain gate
    function test_deployFastRefusesBscMainnet() public {
        vm.chainId(56);
        vm.expectRevert(bytes("DeployFast: testnet-fast is limited to chain 1345/97/31337/31338"));
        fast.deployBsc(_common(1345), _bscParams());
        assertEq(vm.getNonce(dep), 0);
    }

    function test_deployFastRefusesWantosMainnet() public {
        vm.chainId(13555);
        uint256 ceiling = token.totalSupply() + 10_000 * U;
        vm.expectRevert(bytes("DeployFast: testnet-fast is limited to chain 1345/97/31337/31338"));
        fast.deployWantos(_common(97), _wParams(), ceiling);
        assertEq(vm.getNonce(dep), 0);
    }

    function test_deployFastRunRefusesMainnetBeforeReadingEnv() public {
        vm.chainId(56);
        vm.expectRevert(bytes("DeployFast: testnet-fast is limited to chain 1345/97/31337/31338"));
        fast.run();
    }

    function test_deployFastSameAddressesOnWantonAndBscTestnet_andVerifies() public {
        uint256 snap = vm.snapshotState();
        vm.chainId(97);
        Deploy.Deployed memory b = fast.deployBsc(_common(1345), _bscParams());
        Verify v = new Verify();
        v.verify(
            Verify.Expect(true, dep, b.timelock, b.implementation, b.implementation.codehash, b.proxy, admin, wl,
                relayer, pauser, address(token), 1345, abi.encode(_bscParams()), 0)
        );
        vm.revertToState(snap);
        vm.chainId(1345);
        Deploy.Deployed memory w = fast.deployWantos(_common(97), _wParams(), token.totalSupply() + 10_000 * U);
        assertEq(w.proxy, b.proxy);
        assertEq(w.timelock, b.timelock);
        assertEq(BridgeTimelock(payable(w.timelock)).getMinDelay(), 2 minutes);
    }

    // ---------------------------------------------------------------- production script refuses fast bytecode
    function test_productionDeployRefusesFastBytecode_bsc() public {
        for (uint256 i; i < allowed.length; i++) {
            vm.chainId(allowed[i]);
            vm.expectRevert(bytes("Deploy: testnet-fast bytecode refused (timelock)"));
            prod.deployBsc(_common(13555), _bscParams());
        }
        assertEq(vm.getNonce(dep), 0);
    }

    function test_productionDeployRefusesFastBytecode_wantos() public {
        vm.chainId(1345);
        uint256 ceiling = token.totalSupply() + 10_000 * U;
        vm.expectRevert(bytes("Deploy: testnet-fast bytecode refused (timelock)"));
        prod.deployWantos(_common(56), _wParams(), ceiling);
    }

    function test_productionDeployPostCheckRefusesFastTimelockEvenIfProbeBypassed() public {
        vm.chainId(97);
        DeployProbeBypassed bypass = new DeployProbeBypassed();
        vm.expectRevert(bytes("Deploy: timelock MIN_DELAY mismatch"));
        bypass.deployBsc(_common(1345), _bscParams());
    }

    function test_productionDeployOnMainnetChainIdFailsAtTheBytecodeGuard() public {
        vm.chainId(56);
        vm.expectRevert(bytes("TESTNET_FAST_ONLY"));
        prod.deployBsc(_common(13555), _bscParams());
    }

    // ---------------------------------------------------------------- the fast windows themselves
    function test_fastWindowValues() public {
        BridgeTimelock t = new BridgeTimelock(admin, address(0xb0b));
        assertEq(t.MIN_DELAY(), 2 minutes);
        assertEq(t.getMinDelay(), 2 minutes);
        assertEq(t.MAX_DELAY(), 7 minutes);
        assertEq(t.EXPIRY_PERIOD(), 14 minutes);
        assertEq(t.PENDING_ADMIN_TTL(), 7 minutes);
        assertEq(t.ADMIN_RECOVERY_DELAY(), 14 minutes);
        assertEq(t.RECOVERY_COOLDOWN(), 3 minutes);
        BscVaultV2 v = new BscVaultV2();
        assertEq(v.MAX_SIGNATURE_TTL(), 10 minutes);
        assertEq(v.WL_TRANSFER_DELAY(), 2 minutes);
        assertEq(v.WL_TRANSFER_TTL(), 7 minutes);
        assertEq(v.WL_RECOVERY_DELAY(), 7 minutes);
        assertEq(v.RECOVERY_COOLDOWN(), 3 minutes);
        assertEq(v.REFUND_DELAY(), 3 minutes);
        // proportions that the design relies on survive the compression
        assertLt(t.MIN_DELAY(), t.MAX_DELAY());
        assertLt(v.MAX_SIGNATURE_TTL(), t.EXPIRY_PERIOD());
        assertLt(v.WL_TRANSFER_DELAY(), v.WL_RECOVERY_DELAY());
        assertLt(v.WL_RECOVERY_DELAY(), t.ADMIN_RECOVERY_DELAY());
        assertLt(v.RECOVERY_COOLDOWN(), v.WL_RECOVERY_DELAY());
    }
}
