// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {W} from "./Windows.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {BridgeTimelock} from "../../src/BridgeTimelock.sol";
import {BridgeBase} from "../../src/BridgeBase.sol";
import {BscVaultV2} from "../../src/BscVaultV2.sol";
import {MockToken} from "../mocks/MockToken.sol";

abstract contract KeysAndTimelock is Test {
    uint256 constant U = 1e18;
    uint256 constant BSC_CHAIN = W.BSC_CHAIN;
    uint256 constant WANTOS_CHAIN = W.WANTOS_CHAIN;

    address admin = makeAddr("admin");
    address wl;
    uint256 wlKey;
    address relayer = makeAddr("relayer");
    address pauser = makeAddr("pauser");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address stranger = makeAddr("stranger");

    BridgeTimelock tl;
    MockToken token;
    uint256 saltCounter;

    function _initKeys() internal {
        (wl, wlKey) = makeAddrAndKey("wl");
        vm.warp(1_767_225_600); // 2026-01-01T00:00:00Z
    }

    // ---- timelock helpers ----
    function _propose(address target, bytes memory data) internal returns (bytes32 salt) {
        salt = bytes32(++saltCounter);
        vm.prank(tl.adminWallet());
        tl.schedule(target, 0, data, bytes32(0), salt, W.TL_MIN_DELAY);
    }

    function _execute(address target, bytes memory data, bytes32 salt) internal {
        tl.execute(target, 0, data, bytes32(0), salt);
    }

    /// propose + wait 48h + execute
    function _viaTimelock(address target, bytes memory data) internal {
        bytes32 salt = _propose(target, data);
        vm.warp(block.timestamp + W.TL_MIN_DELAY);
        _execute(target, data, salt);
    }

    // ---- EIP-712 whitelist batch ----
    function _sorted(address[] memory a) internal pure returns (address[] memory) {
        for (uint256 i = 1; i < a.length; i++) {
            address k = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > k) {
                a[j] = a[j - 1];
                j--;
            }
            a[j] = k;
        }
        return a;
    }

    function _signBatch(
        BridgeBase b,
        uint256 key,
        address[] memory addrs,
        bool allowed,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 digest = b.hashWhitelistBatch(addrs, allowed, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _applyBatch(BridgeBase b, address[] memory addrs, bool allowed) internal {
        addrs = _sorted(addrs);
        uint256 nonce = b.whitelistNonce();
        uint256 deadline = block.timestamp + W.SIG_TTL / 24;
        bytes memory sig = _signBatch(b, wlKey, addrs, allowed, nonce, deadline);
        vm.prank(stranger); // any account may submit
        b.applyWhitelistBatch(addrs, allowed, nonce, deadline, sig);
    }

    function _one(address a) internal pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    function _two(address a, address b) internal pure returns (address[] memory arr) {
        arr = new address[](2);
        arr[0] = a;
        arr[1] = b;
    }
}

abstract contract BscFixture is KeysAndTimelock {
    BscVaultV2 vault;
    BscVaultV2 impl;

    function _bscParams() internal pure returns (BscVaultV2.Params memory p) {
        p = BscVaultV2.Params({
            dailyCap: 5_000 * U,
            perAddrDailyCap: 2_000 * U,
            largeThreshold: 1_000 * U,
            releaseDelay: 12 hours,
            minDeposit: 10 * U,
            maxDepositPerTx: 2_000 * U
        });
    }

    function _deployBsc() internal {
        _initKeys();
        vm.chainId(BSC_CHAIN);
        token = new MockToken();
        uint256 n = vm.getNonce(address(this));
        address predictedProxy = vm.computeCreateAddress(address(this), n + 2);
        tl = new BridgeTimelock(admin, predictedProxy);
        impl = new BscVaultV2();
        bytes memory init = abi.encodeCall(
            BscVaultV2.initialize,
            (BscVaultV2.InitArgs({
                    timelock: address(tl),
                    token: address(token),
                    whitelistManager: wl,
                    relayer: relayer,
                    pauser: pauser,
                    peerChainId: WANTOS_CHAIN,
                    peerBridge: predictedProxy,
                    params: _bscParams()
                }))
        );
        vault = BscVaultV2(address(new ERC1967Proxy(address(impl), init)));
        assertEq(address(vault), predictedProxy);
        token.mint(address(vault), 100_000 * U);
    }

    function _key(uint256 nonce) internal view returns (bytes32) {
        return vault.eventKeyOf(nonce);
    }

    function _status(uint256 nonce) internal view returns (uint8 s) {
        (,,, s) = vault.payouts(_key(nonce));
    }
}
