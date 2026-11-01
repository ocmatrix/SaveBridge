// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice What BridgeTimelock reads from the bridge it governs (DESIGN.md §4.2).
interface IBridgeForTimelock {
    function whitelistManager() external view returns (address);
    function paused() external view returns (bool);
    function whitelistRecoveryActive() external view returns (bool);
    /// @dev true if `account` is the whitelist wallet, a RELAYER or a PAUSER on the bridge.
    function isKeyHolder(address account) external view returns (bool);
}

/// @notice What the bridge reads from its BridgeTimelock (DESIGN.md §4.2 item 8).
interface ITimelockForBridge {
    function adminWallet() external view returns (address);
    function adminRecoveryActive() external view returns (bool);
    function bridge() external view returns (address);
}
