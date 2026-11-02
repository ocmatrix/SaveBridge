// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {BridgeTimelock} from "../src/BridgeTimelock.sol";
import {BscVaultV2} from "../src/BscVaultV2.sol";
import {WantosBridgeV2} from "../src/WantosBridgeV2.sol";
import {BridgeBase} from "../src/BridgeBase.sol";

/// @notice §5.1 deterministic deployment (CREATE, fresh deployer EOA, nonces 0/1/2) for one chain.
/// @dev    WRITTEN ONLY. Real broadcasting requires explicit owner authorization (TRAIN.md boundary 1).
///         Tests rehearse it in memory. Failure rule (§5.1): any failed tx burns a nonce -> abandon BOTH
///         chains and start over with a new deployer EOA.
contract Deploy is Script {
    struct Common {
        address deployer;
        address adminWallet;
        address whitelistManager;
        address relayer;
        address pauser;
        address token;
        uint256 peerChainId;
    }

    struct Deployed {
        address timelock;
        address implementation;
        address proxy;
    }

    /// @notice PR-9 mainnet guard: refuse to deploy the testnet-fast variant (contracts/testnet-fast, windows in
    ///         minutes). Before broadcasting, throw-away copies of the exact bytecode this script would deploy are
    ///         created locally (outside the broadcast, never sent) and their window constants must be the
    ///         production ones; `_post` re-checks the deployed timelock's MIN_DELAY immutable. `forge script`
    ///         simulates the whole run before sending anything, so a mismatch never reaches a chain.
    ///         Overridden only by the testnet-fast DeployFast script (chain-id gated).
    function _requireBuildWindows() internal virtual {
        BridgeTimelock t = new BridgeTimelock(address(0xA11CE), address(0xB0B)); // throw-away probe
        BridgeBase b = BridgeBase(address(new BscVaultV2()));
        BridgeBase w = BridgeBase(address(new WantosBridgeV2()));
        require(
            t.MIN_DELAY() == 48 hours && t.getMinDelay() == 48 hours && t.MAX_DELAY() == 7 days
                && t.EXPIRY_PERIOD() == 14 days && t.PENDING_ADMIN_TTL() == 7 days
                && t.ADMIN_RECOVERY_DELAY() == 14 days && t.RECOVERY_COOLDOWN() == 3 days,
            "Deploy: testnet-fast bytecode refused (timelock)"
        );
        _requireBaseWindows(b);
        _requireBaseWindows(w);
    }

    function _requireBaseWindows(BridgeBase b) private view {
        require(
            b.MAX_SIGNATURE_TTL() == 24 hours && b.WL_TRANSFER_DELAY() == 48 hours && b.WL_TRANSFER_TTL() == 7 days
                && b.WL_RECOVERY_DELAY() == 7 days && b.RECOVERY_COOLDOWN() == 3 days && b.REFUND_DELAY() == 24 hours,
            "Deploy: testnet-fast bytecode refused (bridge)"
        );
    }

    /// @dev Expected timelock MIN_DELAY of the build being deployed (production: 48h).
    function _expectedMinDelay() internal pure virtual returns (uint256) {
        return 48 hours;
    }

    function _preflight(address deployer) internal returns (address tlPred, address implPred, address proxyPred) {
        _requireBuildWindows();
        require(vm.getNonce(deployer) == 0, "Deploy: deployer nonce must be 0");
        tlPred = vm.computeCreateAddress(deployer, 0);
        implPred = vm.computeCreateAddress(deployer, 1);
        proxyPred = vm.computeCreateAddress(deployer, 2);
        require(
            tlPred.code.length == 0 && implPred.code.length == 0 && proxyPred.code.length == 0,
            "Deploy: predicted address has code"
        );
    }

    function _post(Deployed memory d, address tlPred, address implPred, address proxyPred) internal view {
        require(BridgeTimelock(payable(d.timelock)).MIN_DELAY() == _expectedMinDelay(), "Deploy: timelock MIN_DELAY mismatch");
        require(d.timelock == tlPred, "Deploy: timelock address mismatch");
        require(d.implementation == implPred, "Deploy: implementation address mismatch");
        require(d.proxy == proxyPred, "Deploy: proxy address mismatch");
    }

    function deployBsc(Common memory c, BscVaultV2.Params memory p) public returns (Deployed memory d) {
        (address tlPred, address implPred, address proxyPred) = _preflight(c.deployer);
        bytes memory init = abi.encodeCall(
            BscVaultV2.initialize,
            (BscVaultV2.InitArgs({
                    timelock: tlPred,
                    token: c.token,
                    whitelistManager: c.whitelistManager,
                    relayer: c.relayer,
                    pauser: c.pauser,
                    peerChainId: c.peerChainId,
                    peerBridge: proxyPred,
                    params: p
                }))
        );
        vm.startBroadcast(c.deployer);
        d.timelock = address(new BridgeTimelock(c.adminWallet, proxyPred)); // nonce n
        d.implementation = address(new BscVaultV2()); // nonce n+1
        d.proxy = address(new ERC1967Proxy(d.implementation, init)); // nonce n+2
        vm.stopBroadcast();
        _post(d, tlPred, implPred, proxyPred);
    }

    function deployWantos(Common memory c, WantosBridgeV2.Params memory p, uint256 supplyCeiling)
        public
        returns (Deployed memory d)
    {
        (address tlPred, address implPred, address proxyPred) = _preflight(c.deployer);
        bytes memory init = abi.encodeCall(
            WantosBridgeV2.initialize,
            (WantosBridgeV2.InitArgs({
                    timelock: tlPred,
                    token: c.token,
                    whitelistManager: c.whitelistManager,
                    relayer: c.relayer,
                    pauser: c.pauser,
                    peerChainId: c.peerChainId,
                    peerBridge: proxyPred,
                    params: p,
                    supplyCeiling: supplyCeiling
                }))
        );
        vm.startBroadcast(c.deployer);
        d.timelock = address(new BridgeTimelock(c.adminWallet, proxyPred));
        d.implementation = address(new WantosBridgeV2());
        d.proxy = address(new ERC1967Proxy(d.implementation, init));
        vm.stopBroadcast();
        _post(d, tlPred, implPred, proxyPred);
    }

    /// Env: SIDE=BSC|WANTOS, DEPLOYER, ADMIN_WALLET, WHITELIST_MANAGER, RELAYER, PAUSER, TOKEN, PEER_CHAIN_ID,
    ///      BSC: DAILY_CAP, PER_ADDR_DAILY_CAP, LARGE_THRESHOLD, RELEASE_DELAY, MIN_DEPOSIT, MAX_DEPOSIT_PER_TX
    ///      WANTOS: W2B_MIN_AMOUNT, W2B_PER_ADDR_DAILY_CAP, B2W_DAILY_CAP, B2W_DELAY, SUPPLY_CEILING
    function run() public virtual returns (Deployed memory) {
        Common memory c = Common({
            deployer: vm.envAddress("DEPLOYER"),
            adminWallet: vm.envAddress("ADMIN_WALLET"),
            whitelistManager: vm.envAddress("WHITELIST_MANAGER"),
            relayer: vm.envAddress("RELAYER"),
            pauser: vm.envAddress("PAUSER"),
            token: vm.envAddress("TOKEN"),
            peerChainId: vm.envUint("PEER_CHAIN_ID")
        });
        if (keccak256(bytes(vm.envString("SIDE"))) == keccak256("BSC")) {
            return deployBsc(
                c,
                BscVaultV2.Params({
                    dailyCap: vm.envUint("DAILY_CAP"),
                    perAddrDailyCap: vm.envUint("PER_ADDR_DAILY_CAP"),
                    largeThreshold: vm.envUint("LARGE_THRESHOLD"),
                    releaseDelay: vm.envUint("RELEASE_DELAY"),
                    minDeposit: vm.envUint("MIN_DEPOSIT"),
                    maxDepositPerTx: vm.envUint("MAX_DEPOSIT_PER_TX")
                })
            );
        }
        require(keccak256(bytes(vm.envString("SIDE"))) == keccak256("WANTOS"), "Deploy: SIDE must be BSC or WANTOS");
        return deployWantos(
            c,
            WantosBridgeV2.Params({
                w2bMinAmount: vm.envUint("W2B_MIN_AMOUNT"),
                w2bPerAddrDailyCap: vm.envUint("W2B_PER_ADDR_DAILY_CAP"),
                b2wDailyCap: vm.envUint("B2W_DAILY_CAP"),
                b2wDelay: vm.envUint("B2W_DELAY")
            }),
            vm.envUint("SUPPLY_CEILING")
        );
    }
}
