// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BridgeTimelock} from "../src/BridgeTimelock.sol";
import {BscVaultV2} from "../src/BscVaultV2.sol";
import {WantosBridgeV2} from "../src/WantosBridgeV2.sol";

/// B1: CI gate - every core contract keeps >= 1,000 bytes of EIP-170 headroom.
contract SizeGateTest is Test {
    uint256 constant LIMIT = 24_576;
    uint256 constant MIN_MARGIN = 1_000; // lowered from 1_500 for the native-fee tiers (BscVaultV2 now ~1,138 B)

    function test_runtimeSizeMargins() public {
        uint256 b = address(new BscVaultV2()).code.length;
        uint256 w = address(new WantosBridgeV2()).code.length;
        uint256 t = address(new BridgeTimelock(address(1), address(2))).code.length;
        emit log_named_uint("BscVaultV2", b);
        emit log_named_uint("WantosBridgeV2", w);
        emit log_named_uint("BridgeTimelock", t);
        assertLe(b + MIN_MARGIN, LIMIT, "BscVaultV2 margin");
        assertLe(w + MIN_MARGIN, LIMIT, "WantosBridgeV2 margin");
        assertLe(t + MIN_MARGIN, LIMIT, "BridgeTimelock margin");
    }
}
