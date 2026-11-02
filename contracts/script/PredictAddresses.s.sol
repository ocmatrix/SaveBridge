// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

/// @notice §5.1 nonce table: CREATE addresses of the three deployment transactions. Pure computation, no broadcast.
///   n   -> BridgeTimelock(adminWallet, bridge = address at n+2)
///   n+1 -> bridge implementation
///   n+2 -> ERC1967Proxy(implementation, initData)   (deploy + initialize in one tx)
/// Usage: DEPLOYER=0x... [DEPLOYER_NONCE=0] forge script contracts/script/PredictAddresses.s.sol
contract PredictAddresses is Script {
    struct Predicted {
        address timelock;
        address implementation;
        address proxy;
    }

    function predict(address deployer, uint256 n) public pure returns (Predicted memory p) {
        p.timelock = vm.computeCreateAddress(deployer, n);
        p.implementation = vm.computeCreateAddress(deployer, n + 1);
        p.proxy = vm.computeCreateAddress(deployer, n + 2);
    }

    function run() external view {
        address deployer = vm.envAddress("DEPLOYER");
        uint256 n = vm.envOr("DEPLOYER_NONCE", uint256(0));
        Predicted memory p = predict(deployer, n);
        console2.log("deployer          ", deployer);
        console2.log("nonce n           ", n);
        console2.log("n   BridgeTimelock", p.timelock);
        console2.log("n+1 implementation", p.implementation);
        console2.log("n+2 bridge proxy  ", p.proxy);
    }
}
