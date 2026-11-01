// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IBridgeForTimelock} from "../../src/interfaces/IBridgeV2.sol";

/// @dev Minimal stand-in bridge for isolated BridgeTimelock tests.
contract MockBridge is IBridgeForTimelock {
    address public whitelistManager;
    address public timelock;
    bool public paused;
    bool public whitelistRecoveryActive;
    mapping(address => bool) public keyHolder;
    uint256 public counter;

    function setWhitelistManager(address a) external {
        whitelistManager = a;
    }

    function setTimelock(address t) external {
        timelock = t;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setWhitelistRecoveryActive(bool v) external {
        whitelistRecoveryActive = v;
    }

    function setKeyHolder(address a, bool v) external {
        keyHolder[a] = v;
    }

    function isKeyHolder(address a) external view returns (bool) {
        return keyHolder[a] || a == whitelistManager;
    }

    function bump() external {
        counter++;
    }
}
