// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BscVaultV2} from "../../src/BscVaultV2.sol";
import {WantosBridgeV2} from "../../src/WantosBridgeV2.sol";

/// @dev "Next version" implementations: same namespaced storage, one new view.
contract BscVaultV2Next is BscVaultV2 {
    function version() external pure returns (string memory) {
        return "v2.1";
    }
}

contract WantosBridgeV2Next is WantosBridgeV2 {
    function version() external pure returns (string memory) {
        return "v2.1";
    }
}

/// @dev Not UUPS-compatible (no proxiableUUID): upgrade must be rejected.
contract NotUups {
    function hello() external pure returns (uint256) {
        return 1;
    }
}
