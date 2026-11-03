// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Deploy} from "./Deploy.s.sol";
import {BridgeBase} from "../src/BridgeBase.sol";
import {BridgeTimelock} from "../src/BridgeTimelock.sol";
import {BscVaultV2} from "../src/BscVaultV2.sol";
import {WantosBridgeV2} from "../src/WantosBridgeV2.sol";

/// @notice PR-9 TESTNET-FAST deployment (lives only in the generated contracts/testnet-fast tree).
///         Same §5.1 procedure as Deploy (fresh deployer, nonces 0/1/2, same address on both chains),
///         but it deploys the minute-window build and is hard-gated to WANTON 1345 / BSC testnet 97 /
///         local anvil 31337,31338. Any other chain id reverts before anything is created or broadcast.
contract DeployFast is Deploy {
    function _requireTestnetChain() internal view {
        require(
            block.chainid == 1345 || block.chainid == 97 || block.chainid == 31337 || block.chainid == 31338,
            "DeployFast: testnet-fast is limited to chain 1345/97/31337/31338"
        );
    }

    /// @dev Replaces the production-window check: chain gate first, then the build MUST be the fast one
    ///      (so this script can never be used to push a production build with test parameters either).
    function _requireBuildWindows() internal override {
        _requireTestnetChain();
        BridgeTimelock t = new BridgeTimelock(address(0xA11CE), address(0xB0B)); // throw-away probe
        BridgeBase b = BridgeBase(address(new BscVaultV2()));
        BridgeBase w = BridgeBase(address(new WantosBridgeV2()));
        require(
            t.MIN_DELAY() == 2 minutes && t.MAX_DELAY() == 7 minutes && t.EXPIRY_PERIOD() == 14 minutes
                && t.PENDING_ADMIN_TTL() == 7 minutes && t.ADMIN_RECOVERY_DELAY() == 14 minutes
                && t.RECOVERY_COOLDOWN() == 3 minutes,
            "DeployFast: not the testnet-fast timelock"
        );
        require(
            b.REFUND_DELAY() == 3 minutes && w.REFUND_DELAY() == 3 minutes && b.WL_TRANSFER_DELAY() == 2 minutes
                && b.WL_RECOVERY_DELAY() == 7 minutes && b.MAX_SIGNATURE_TTL() == 10 minutes,
            "DeployFast: not the testnet-fast bridge"
        );
    }

    function _expectedMinDelay() internal pure override returns (uint256) {
        return 2 minutes;
    }

    /// Env: as Deploy.run, plus optional PR9_DEPLOYER_KEY (the throw-away deployer key, read from the
    /// environment so it never appears on a command line). Without it a wallet must be passed to forge.
    function run() public override returns (Deployed memory) {
        _requireTestnetChain();
        uint256 k = vm.envOr("PR9_DEPLOYER_KEY", uint256(0));
        if (k != 0) require(vm.rememberKey(k) == vm.envAddress("DEPLOYER"), "DeployFast: key/DEPLOYER mismatch");
        return super.run();
    }
}
