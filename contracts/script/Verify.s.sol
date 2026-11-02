// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BridgeTimelock} from "../src/BridgeTimelock.sol";
import {BridgeBase} from "../src/BridgeBase.sol";
import {BscVaultV2} from "../src/BscVaultV2.sol";
import {WantosBridgeV2} from "../src/WantosBridgeV2.sol";

/// @notice §5.1 post-deployment acceptance: roles, timelock members & delay, implementation codehash,
///         parameters, empty whitelist, address consistency. Read-only; reverts on the first mismatch.
contract Verify is Script {
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    struct Expect {
        bool isBsc;
        address deployer;
        address timelock;
        address implementation;
        bytes32 implementationCodehash; // from the verified, reproducible build
        address proxy;
        address adminWallet;
        address whitelistManager;
        address relayer;
        address pauser;
        address token;
        uint256 peerChainId;
        bytes encodedParams; // abi.encode(Params)
        uint256 supplyCeiling; // WANTOS only
    }

    function verify(Expect memory e) public view {
        // ---- addresses (§5.1 nonce table)
        require(e.timelock == vm.computeCreateAddress(e.deployer, 0), "Verify: timelock address");
        require(e.implementation == vm.computeCreateAddress(e.deployer, 1), "Verify: implementation address");
        require(e.proxy == vm.computeCreateAddress(e.deployer, 2), "Verify: proxy address");

        // ---- timelock
        BridgeTimelock t = BridgeTimelock(payable(e.timelock));
        require(t.MIN_DELAY() == 48 hours && t.getMinDelay() == 48 hours, "Verify: timelock delay");
        require(t.bridge() == e.proxy, "Verify: timelock bridge");
        require(t.adminWallet() == e.adminWallet, "Verify: timelock admin");
        require(t.hasRole(t.PROPOSER_ROLE(), e.adminWallet), "Verify: proposer");
        require(t.hasRole(t.CANCELLER_ROLE(), e.adminWallet), "Verify: canceller");
        require(t.hasRole(t.EXECUTOR_ROLE(), address(0)), "Verify: open executor");
        require(t.hasRole(t.DEFAULT_ADMIN_ROLE(), e.timelock), "Verify: timelock self-admin");
        require(!t.hasRole(t.DEFAULT_ADMIN_ROLE(), e.deployer), "Verify: deployer timelock admin");
        require(!t.hasRole(t.PROPOSER_ROLE(), e.deployer), "Verify: deployer proposer");
        require(!t.hasRole(t.DEFAULT_ADMIN_ROLE(), e.adminWallet), "Verify: admin wallet timelock admin");
        require(t.pendingAdmin() == address(0) && t.epoch() == 0 && !t.adminRecoveryActive(), "Verify: timelock state");

        // ---- implementation
        require(address(uint160(uint256(vm.load(e.proxy, IMPL_SLOT)))) == e.implementation, "Verify: impl slot");
        require(e.implementation.codehash == e.implementationCodehash, "Verify: implementation codehash");

        // ---- bridge roles & keys
        BridgeBase b = BridgeBase(e.proxy);
        require(b.timelock() == e.timelock, "Verify: bridge timelock");
        require(b.hasRole(b.DEFAULT_ADMIN_ROLE(), e.timelock), "Verify: default admin");
        require(!b.hasRole(b.DEFAULT_ADMIN_ROLE(), e.deployer), "Verify: deployer admin");
        require(!b.hasRole(b.DEFAULT_ADMIN_ROLE(), e.adminWallet), "Verify: admin wallet default admin");
        require(b.adminWallet() == e.adminWallet, "Verify: bridge admin wallet");
        require(b.whitelistManager() == e.whitelistManager, "Verify: whitelist manager");
        require(b.hasRole(b.RELAYER_ROLE(), e.relayer), "Verify: relayer role");
        require(b.hasRole(b.PAUSER_ROLE(), e.pauser), "Verify: pauser role");
        require(
            !b.hasRole(b.RELAYER_ROLE(), e.deployer) && !b.hasRole(b.PAUSER_ROLE(), e.deployer), "Verify: deployer key"
        );
        require(address(b.token()) == e.token, "Verify: token");
        require(b.peerChainId() == e.peerChainId, "Verify: peer chain");
        require(b.peerBridge() == e.proxy, "Verify: peer bridge");

        // ---- empty whitelist, clean state
        require(b.whitelistNonce() == 0, "Verify: whitelist not empty");
        require(!b.whitelistFrozen() && !b.anyRecoveryActive() && !b.paused(), "Verify: bridge state");

        // ---- params
        if (e.isBsc) {
            require(keccak256(abi.encode(BscVaultV2(e.proxy).params())) == keccak256(e.encodedParams), "Verify: params");
            require(BscVaultV2(e.proxy).depositNonce() == 0, "Verify: deposits");
        } else {
            WantosBridgeV2 w = WantosBridgeV2(e.proxy);
            require(keccak256(abi.encode(w.params())) == keccak256(e.encodedParams), "Verify: params");
            require(w.supplyCeiling() == e.supplyCeiling, "Verify: supply ceiling");
            require(w.orderNonce() == 0, "Verify: orders");
        }
    }

    /// Env mirrors Deploy.s.sol plus TIMELOCK, IMPLEMENTATION, IMPLEMENTATION_CODEHASH, PROXY, ENCODED_PARAMS.
    function run() external view {
        Expect memory e = Expect({
            isBsc: keccak256(bytes(vm.envString("SIDE"))) == keccak256("BSC"),
            deployer: vm.envAddress("DEPLOYER"),
            timelock: vm.envAddress("TIMELOCK"),
            implementation: vm.envAddress("IMPLEMENTATION"),
            implementationCodehash: vm.envBytes32("IMPLEMENTATION_CODEHASH"),
            proxy: vm.envAddress("PROXY"),
            adminWallet: vm.envAddress("ADMIN_WALLET"),
            whitelistManager: vm.envAddress("WHITELIST_MANAGER"),
            relayer: vm.envAddress("RELAYER"),
            pauser: vm.envAddress("PAUSER"),
            token: vm.envAddress("TOKEN"),
            peerChainId: vm.envUint("PEER_CHAIN_ID"),
            encodedParams: vm.envBytes("ENCODED_PARAMS"),
            supplyCeiling: vm.envOr("SUPPLY_CEILING", uint256(0))
        });
        verify(e);
        console2.log("Verify: all checks passed for", e.proxy);
    }
}
