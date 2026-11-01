// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {BridgeTimelock} from "../../src/BridgeTimelock.sol";
import {WantosBridgeV2} from "../../src/WantosBridgeV2.sol";
import {MockToken} from "../mocks/MockToken.sol";
import {KeysAndTimelock} from "./Fixtures.sol";

abstract contract WantosFixture is KeysAndTimelock {
    WantosBridgeV2 bridge;
    WantosBridgeV2 wimpl;

    function _wParams() internal pure returns (WantosBridgeV2.Params memory p) {
        p = WantosBridgeV2.Params({
            w2bMinAmount: 10 * U, w2bPerAddrDailyCap: 2_000 * U, b2wDailyCap: 3_000 * U, b2wDelay: 15 minutes
        });
    }

    function _deployWantos() internal {
        _initKeys();
        vm.chainId(WANTOS_CHAIN);
        token = new MockToken();
        token.mint(address(0xdead), 30_000_000 * U);
        uint256 n = vm.getNonce(address(this));
        address predictedProxy = vm.computeCreateAddress(address(this), n + 2);
        tl = new BridgeTimelock(admin, predictedProxy);
        wimpl = new WantosBridgeV2();
        bytes memory init = abi.encodeCall(
            WantosBridgeV2.initialize,
            (WantosBridgeV2.InitArgs({
                    timelock: address(tl),
                    token: address(token),
                    whitelistManager: wl,
                    relayer: relayer,
                    pauser: pauser,
                    peerChainId: BSC_CHAIN,
                    peerBridge: predictedProxy,
                    params: _wParams(),
                    supplyCeiling: token.totalSupply() + 10_000 * U
                }))
        );
        bridge = WantosBridgeV2(address(new ERC1967Proxy(address(wimpl), init)));
        assertEq(address(bridge), predictedProxy);
        // starting reserve funded by the owner (decision 9) via fund()
        vm.prank(address(0xdead));
        token.transfer(address(this), 50_000 * U);
        token.approve(address(bridge), 50_000 * U);
        bridge.fund(50_000 * U);
    }

    function _bkey(uint256 nonce) internal view returns (bytes32) {
        return bridge.eventKeyOf(nonce);
    }

    function _bstatus(uint256 nonce) internal view returns (uint8 s) {
        (,,, s) = bridge.payouts(_bkey(nonce));
    }

    function _fundUser(address u, uint256 amt) internal {
        // move from the dead holder so totalSupply stays constant
        vm.prank(address(0xdead));
        token.transfer(u, amt);
        vm.prank(u);
        token.approve(address(bridge), type(uint256).max);
    }
}
