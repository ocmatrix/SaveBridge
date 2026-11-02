// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IBridgeForTimelock} from "../../src/interfaces/IBridgeV2.sol";

/// @dev Minimal stand-in bridge for isolated BridgeTimelock tests.
contract MockBridge is IBridgeForTimelock {
    address public whitelistManager;
    address public timelock;
    bool internal _paused;
    bool public pausedReverts; // A-1(d): make the paused() probe revert
    bool public wlNotKeyHolder; // A-1(c): isKeyHolder(whitelistManager) returns false
    bool public whitelistRecoveryActive;
    mapping(address => bool) public keyHolder;
    uint256 public counter;

    function setWhitelistManager(address a) external {
        whitelistManager = a;
    }

    function setTimelock(address t) external {
        timelock = t;
    }

    error PausedProbeBroken();

    function setPaused(bool p) external {
        _paused = p;
    }

    function setPausedReverts(bool v) external {
        pausedReverts = v;
    }

    function setWlNotKeyHolder(bool v) external {
        wlNotKeyHolder = v;
    }

    function paused() external view returns (bool) {
        if (pausedReverts) revert PausedProbeBroken();
        return _paused;
    }

    function setWhitelistRecoveryActive(bool v) external {
        whitelistRecoveryActive = v;
    }

    function setKeyHolder(address a, bool v) external {
        keyHolder[a] = v;
    }

    function isKeyHolder(address a) external view returns (bool) {
        return keyHolder[a] || (a == whitelistManager && !wlNotKeyHolder);
    }

    function bump() external {
        counter++;
    }
}
