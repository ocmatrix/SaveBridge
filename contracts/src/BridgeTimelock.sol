// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IBridgeForTimelock, ITimelockForBridge} from "./interfaces/IBridgeV2.sol";

/// @title BridgeTimelock
/// @notice 48h timelock governing one bridge (DESIGN.md v0.9.3 §4.2 items 1-8, §4.6). Not upgradeable.
/// - exactly one proposer (= admin wallet); executor = anyone; no timelock admin
/// - cancel: admin wallet or the bridge's current whitelist wallet (read at runtime)
/// - operations expire 14 days after they become ready; proposals carry an epoch, bumped by admin recovery
/// - while any recovery (admin or whitelist) is in progress nothing can be executed
contract BridgeTimelock is TimelockController, ITimelockForBridge {
    // ------------------------------------------------------------------ constants
    uint256 public immutable MIN_DELAY;
    uint256 public constant MAX_DELAY = 7 days;
    uint256 public constant EXPIRY_PERIOD = 14 days;
    uint256 public constant PENDING_ADMIN_TTL = 7 days;
    uint256 public constant ADMIN_RECOVERY_DELAY = 14 days;
    uint256 public constant RECOVERY_COOLDOWN = 3 days;

    /// @notice The bridge proxy this timelock governs (pre-computed CREATE address, §5.1).
    address public immutable bridge;

    // ------------------------------------------------------------------ state
    address private _adminWallet;
    address public pendingAdmin;
    uint64 public pendingAdminExpiresAt;

    uint256 public epoch;
    mapping(bytes32 id => uint256) public proposalEpoch;

    bool public adminRecoveryActive;
    address public adminRecoveryCandidate;
    uint64 public adminRecoveryReadyAt;
    uint64 public adminRecoveryCooldownUntil;

    bool private _migrating;
    uint256 private _delay;

    // ------------------------------------------------------------------ errors
    error ZeroAddress();
    error RoleChangeForbidden();
    error DelayBelowMinimum(uint256 requested, uint256 minimum);
    error DelayAboveMaximum(uint256 requested, uint256 maximum);
    error NotCanceller(address caller);
    error OperationExpired(bytes32 id);
    error OperationStaleEpoch(bytes32 id);
    error RecoveryInProgress();
    error BridgePaused();
    error InvalidNewAdmin(address account);
    error KeyConflict(address account);
    error NotPendingAdmin(address caller);
    error PendingAdminExpired();
    error NotWhitelistManager(address caller);
    error RecoveryCooldown(uint256 until);
    error NoRecovery();
    error RecoveryNotReady(uint256 readyAt);
    error BridgeCheckFailed();

    // ------------------------------------------------------------------ events
    event AdminTransferStarted(address indexed currentAdmin, address indexed newAdmin, uint256 expiresAt);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin, uint256 epoch, bool viaRecovery);
    event AdminRecoveryStarted(address indexed initiator, address indexed candidate, uint256 readyAt);
    event AdminRecoveryCancelled(address indexed by, address indexed candidate, uint256 cooldownUntil);
    event ProposalRecorded(bytes32 indexed id, uint256 epoch);

    /// @param adminWallet_ the admin wallet (sole proposer). May be a contract (multisig).
    /// @param bridge_ pre-computed bridge proxy address. Not called during construction
    ///        (mutual-exclusion with bridge keys is skipped here; the bridge's initialize checks it).
    constructor(address adminWallet_, address bridge_)
        TimelockController(48 hours, _single(adminWallet_), _single(address(0)), address(0))
    {
        if (adminWallet_ == address(0) || bridge_ == address(0)) revert ZeroAddress();
        MIN_DELAY = 48 hours;
        _delay = 48 hours;
        bridge = bridge_;
        _adminWallet = adminWallet_;
    }

    function _single(address a) private pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = a;
    }

    // ------------------------------------------------------------------ views
    /// @inheritdoc ITimelockForBridge
    function adminWallet() public view returns (address) {
        return _adminWallet;
    }

    /// @notice True when the operation is pending but more than EXPIRY_PERIOD past its ready time.
    function isOperationExpired(bytes32 id) public view returns (bool) {
        uint256 ts = getTimestamp(id);
        return ts > _DONE_TIMESTAMP && block.timestamp > ts + EXPIRY_PERIOD;
    }

    function _anyRecoveryActive() internal view returns (bool) {
        return adminRecoveryActive || IBridgeForTimelock(bridge).whitelistRecoveryActive();
    }

    // ------------------------------------------------------------------ roles: frozen after construction
    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (!_rolesMutable()) revert RoleChangeForbidden();
        return super._grantRole(role, account);
    }

    function _revokeRole(bytes32 role, address account) internal override returns (bool) {
        if (!_rolesMutable()) revert RoleChangeForbidden();
        return super._revokeRole(role, account);
    }

    function renounceRole(bytes32, address) public pure override {
        revert RoleChangeForbidden();
    }

    function _rolesMutable() private view returns (bool) {
        // during construction (no code yet) or during the internal admin migration only
        return _migrating || address(this).code.length == 0;
    }

    // ------------------------------------------------------------------ schedule / execute / cancel
    function schedule(
        address target,
        uint256 value,
        bytes calldata data,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    ) public override {
        super.schedule(target, value, data, predecessor, salt, delay);
        _record(hashOperation(target, value, data, predecessor, salt));
    }

    function scheduleBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt,
        uint256 delay
    ) public override {
        super.scheduleBatch(targets, values, payloads, predecessor, salt, delay);
        _record(hashOperationBatch(targets, values, payloads, predecessor, salt));
    }

    function _record(bytes32 id) private {
        proposalEpoch[id] = epoch;
        emit ProposalRecorded(id, epoch);
    }

    function execute(address target, uint256 value, bytes calldata payload, bytes32 predecessor, bytes32 salt)
        public
        payable
        override
    {
        _checkExecutable(hashOperation(target, value, payload, predecessor, salt));
        super.execute(target, value, payload, predecessor, salt);
        _checkBridgeSane();
    }

    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata payloads,
        bytes32 predecessor,
        bytes32 salt
    ) public payable override {
        _checkExecutable(hashOperationBatch(targets, values, payloads, predecessor, salt));
        super.executeBatch(targets, values, payloads, predecessor, salt);
        _checkBridgeSane();
    }

    /// @dev Post-execution self-check (incl. upgrades): the bridge must still expose the views this timelock
    ///      depends on, with sane values. Nothing a timelock operation can do legitimately starts a recovery,
    ///      so a recovery flag after execution means a broken implementation. Any revert here reverts the
    ///      whole execution, so a bad upgrade can never leave governance bricked.
    function _checkBridgeSane() private view {
        IBridgeForTimelock b = IBridgeForTimelock(bridge);
        // liveness probe only: the value is irrelevant, the call must not revert
        // slither-disable-next-line unused-return
        b.paused();
        address wlm = b.whitelistManager();
        if (_anyRecoveryActive() || wlm == address(0) || !b.isKeyHolder(wlm) || b.timelock() != address(this)) {
            revert BridgeCheckFailed();
        }
    }

    function _checkExecutable(bytes32 id) private view {
        if (isOperationExpired(id)) revert OperationExpired(id);
        if (isOperationPending(id) && proposalEpoch[id] != epoch) revert OperationStaleEpoch(id);
        if (_anyRecoveryActive()) revert RecoveryInProgress();
    }

    /// @dev `cancel` is `onlyRole(CANCELLER_ROLE)` in OZ and its storage is private, so the canceller rule is
    ///      enforced here: CANCELLER_ROLE is satisfied by exactly the admin wallet or the bridge's current
    ///      whitelist wallet (read at runtime, §4.2 item 4). Role membership itself is ignored for cancelling.
    function _checkRole(bytes32 role, address account) internal view override {
        if (role == CANCELLER_ROLE) {
            if (account != _adminWallet && account != IBridgeForTimelock(bridge).whitelistManager()) {
                revert NotCanceller(account);
            }
            return;
        }
        super._checkRole(role, account);
    }

    function _checkCanceller() private view {
        if (msg.sender != _adminWallet && msg.sender != IBridgeForTimelock(bridge).whitelistManager()) {
            revert NotCanceller(msg.sender);
        }
    }

    function updateDelay(uint256 newDelay) external override {
        if (msg.sender != address(this)) revert TimelockUnauthorizedCaller(msg.sender);
        if (newDelay < MIN_DELAY) revert DelayBelowMinimum(newDelay, MIN_DELAY);
        if (newDelay > MAX_DELAY) revert DelayAboveMaximum(newDelay, MAX_DELAY);
        emit MinDelayChange(_delay, newDelay);
        _delay = newDelay;
    }

    /// @dev OZ keeps `_minDelay` private and `updateDelay` external, so the delay lives here.
    function getMinDelay() public view override returns (uint256) {
        return _delay;
    }

    // ------------------------------------------------------------------ admin transfer (§4.6)
    /// @notice Step 2 of a normal handover. Only callable by the timelock itself (i.e. via a 48h proposal).
    function transferAdmin(address newAdmin) external {
        if (msg.sender != address(this)) revert TimelockUnauthorizedCaller(msg.sender);
        if (IBridgeForTimelock(bridge).paused()) revert BridgePaused();
        _checkCandidate(newAdmin);
        pendingAdmin = newAdmin;
        uint64 exp = uint64(block.timestamp + PENDING_ADMIN_TTL);
        pendingAdminExpiresAt = exp;
        emit AdminTransferStarted(_adminWallet, newAdmin, exp);
    }

    /// @notice Accept a normal handover (pendingAdmin) or complete an admin recovery (candidate, after 14 days).
    function acceptAdmin() external {
        address s = msg.sender;
        if (adminRecoveryActive) {
            if (s != adminRecoveryCandidate) revert NotPendingAdmin(s);
            if (block.timestamp < adminRecoveryReadyAt) revert RecoveryNotReady(adminRecoveryReadyAt);
            if (IBridgeForTimelock(bridge).isKeyHolder(s)) revert KeyConflict(s);
            adminRecoveryActive = false;
            adminRecoveryCandidate = address(0);
            adminRecoveryReadyAt = 0;
            epoch += 1;
            _setAdmin(s, true);
            return;
        }
        if (IBridgeForTimelock(bridge).whitelistRecoveryActive()) revert RecoveryInProgress();
        if (s != pendingAdmin || s == address(0)) revert NotPendingAdmin(s);
        if (block.timestamp > pendingAdminExpiresAt) revert PendingAdminExpired();
        if (IBridgeForTimelock(bridge).isKeyHolder(s)) revert KeyConflict(s);
        _setAdmin(s, false);
    }

    // ------------------------------------------------------------------ admin recovery (§4.6)
    /// @notice Whitelist wallet starts admin-wallet recovery (admin lost). 14 days; cancellable by both wallets.
    function startAdminRecovery(address candidate) external {
        IBridgeForTimelock b = IBridgeForTimelock(bridge);
        if (msg.sender != b.whitelistManager()) revert NotWhitelistManager(msg.sender);
        if (adminRecoveryActive || b.whitelistRecoveryActive()) revert RecoveryInProgress();
        if (block.timestamp < adminRecoveryCooldownUntil) revert RecoveryCooldown(adminRecoveryCooldownUntil);
        _checkCandidate(candidate);
        pendingAdmin = address(0);
        pendingAdminExpiresAt = 0;
        adminRecoveryActive = true;
        adminRecoveryCandidate = candidate;
        uint64 readyAt = uint64(block.timestamp + ADMIN_RECOVERY_DELAY);
        adminRecoveryReadyAt = readyAt;
        emit AdminRecoveryStarted(msg.sender, candidate, readyAt);
    }

    /// @notice Current admin wallet or whitelist wallet cancels the admin recovery; initiator side cools down 3 days.
    function cancelAdminRecovery() external {
        if (!adminRecoveryActive) revert NoRecovery();
        _checkCanceller();
        address candidate = adminRecoveryCandidate;
        adminRecoveryActive = false;
        adminRecoveryCandidate = address(0);
        adminRecoveryReadyAt = 0;
        uint64 until = uint64(block.timestamp + RECOVERY_COOLDOWN);
        adminRecoveryCooldownUntil = until;
        emit AdminRecoveryCancelled(msg.sender, candidate, until);
    }

    // ------------------------------------------------------------------ internals
    function _checkCandidate(address a) private view {
        if (a == address(0)) revert ZeroAddress();
        if (a == _adminWallet || a == address(this) || a == bridge) revert InvalidNewAdmin(a);
        if (IBridgeForTimelock(bridge).isKeyHolder(a)) revert KeyConflict(a);
    }

    function _setAdmin(address newAdmin, bool viaRecovery) private {
        address old = _adminWallet;
        _migrating = true;
        _revokeRole(PROPOSER_ROLE, old);
        _revokeRole(CANCELLER_ROLE, old);
        _grantRole(PROPOSER_ROLE, newAdmin);
        _grantRole(CANCELLER_ROLE, newAdmin);
        _migrating = false;
        _adminWallet = newAdmin;
        pendingAdmin = address(0);
        pendingAdminExpiresAt = 0;
        emit AdminTransferred(old, newAdmin, epoch, viaRecovery);
    }
}
