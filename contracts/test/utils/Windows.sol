// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Single source of the time windows (and chain ids) the contract tests assert against.
/// @dev    Values mirror the production constants in contracts/src. The PR-9 testnet-fast variant
///         (scripts/make-fast-variant.mjs) rewrites THIS file with the same audited substitution table
///         it applies to contracts/src, so the very same assertions run against the fast build.
///         Tests must reference these names instead of literals for any window that the fast variant
///         changes; literals that are not windows (UTC day length, "much later" warps) stay literals.
library W {
    // BridgeTimelock
    uint256 internal constant TL_MIN_DELAY = 48 hours;
    uint256 internal constant TL_MAX_DELAY = 7 days;
    uint256 internal constant TL_EXPIRY = 14 days;
    uint256 internal constant TL_PENDING_ADMIN_TTL = 7 days;
    uint256 internal constant TL_ADMIN_RECOVERY = 14 days;
    uint256 internal constant TL_COOLDOWN = 3 days;
    // BridgeBase
    uint256 internal constant SIG_TTL = 24 hours;
    uint256 internal constant WL_TRANSFER_DELAY = 48 hours;
    uint256 internal constant WL_TRANSFER_TTL = 7 days;
    uint256 internal constant WL_RECOVERY = 7 days;
    uint256 internal constant WL_COOLDOWN = 3 days;
    uint256 internal constant REFUND_DELAY = 24 hours;
    // Parameter lower bounds
    uint256 internal constant RELEASE_DELAY_MIN = 6 hours;
    // Chains the tests impersonate
    uint256 internal constant BSC_CHAIN = 56;
    uint256 internal constant WANTOS_CHAIN = 13555;
}
