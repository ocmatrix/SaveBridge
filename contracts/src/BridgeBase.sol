// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ITimelockForBridge} from "./interfaces/IBridgeV2.sol";

/// @title BridgeBase
/// @notice Shared machinery of BscVaultV2 and WantosBridgeV2 (DESIGN.md v0.9.4 §4.1-§4.5, §5.2-§5.3):
///         keys & mutual exclusion, EIP-712 whitelist batches, whitelist-wallet handover & recovery,
///         pause, UTC-day quotas, payout state machine (None/Queued/Released/Voided), reserve fund/withdraw.
abstract contract BridgeBase is

    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    EIP712Upgradeable
{
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ constants
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant WHITELIST_BATCH_TYPEHASH =
        keccak256("WhitelistBatch(bytes32 listHash,uint32 count,bool allowed,uint256 nonce,uint256 deadline)");
    string public constant EVENT_KEY_TAG = "WANTOS-BSC-BRIDGE-V2";

    uint256 public constant MAX_WHITELIST_BATCH = 500;
    uint256 public constant MAX_SIGNATURE_TTL = 24 hours;
    uint256 public constant WL_TRANSFER_DELAY = 48 hours;
    uint256 public constant WL_TRANSFER_TTL = 7 days;
    uint256 public constant WL_RECOVERY_DELAY = 7 days;
    uint256 public constant RECOVERY_COOLDOWN = 3 days;
    uint256 public constant REFUND_DELAY = 24 hours;

    // Payout status (§5.4)
    uint8 internal constant P_NONE = 0;
    uint8 internal constant P_QUEUED = 1;
    uint8 internal constant P_RELEASED = 2;
    uint8 internal constant P_VOIDED = 3;

    struct Payout {
        address to;
        uint128 amount;
        uint64 queuedAt; // time the quota was charged (release or queue)
        uint8 status;
    }

    /// @custom:storage-location erc7201:wantos.bridge.v2.BridgeBase
    struct BaseStorage {
        address timelock;
        IERC20 token;
        uint256 unit; // 10 ** token.decimals()
        uint256 peerChainId;
        address peerBridge;
        // whitelist
        address whitelistManager;
        mapping(address => bool) whitelisted;
        uint256 whitelistNonce;
        bool whitelistFrozen;
        // whitelist-wallet handover
        address pendingWl;
        uint64 pendingWlAvailableAt;
        uint64 pendingWlExpiresAt;
        // whitelist-wallet recovery
        bool recoveryActive;
        address recoveryCandidate;
        uint64 recoveryReadyAt;
        uint64 recoveryCooldownUntil;
        // payouts and quotas
        mapping(bytes32 => Payout) payouts;
        mapping(uint256 day => uint256) dailyUsed;
        mapping(uint256 day => mapping(address => uint256)) addrDailyUsed;
    }

    // keccak256(abi.encode(uint256(keccak256("wantos.bridge.v2.BridgeBase")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant BASE_STORAGE = 0x79137872e54e4a642e840f1b8680e7d27de6c15649eda752b94eb42353c3e000;

    function _b() internal pure returns (BaseStorage storage $) {
        assembly {
            $.slot := BASE_STORAGE
        }
    }

    // ------------------------------------------------------------------ errors
    error ZeroAddress();
    error ZeroAmount();
    error InvalidInit();
    error NotAdmin(address caller);
    error NotWhitelistManager(address caller);
    error NotAdminOrWhitelistManager(address caller);
    error NotTimelock(address caller);
    error NotAuthorized(address caller);
    error RecoveryInProgress();
    error KeyConflict(address account);
    error InvalidRole(bytes32 role);
    error BadBatchSize(uint256 size);
    error AddressesNotSorted(uint256 index);
    error BadNonce(uint256 expected, uint256 provided);
    error SignatureExpired(uint256 deadline);
    error DeadlineTooFar(uint256 deadline);
    error InvalidSigner(address recovered);
    error WhitelistWritesBlocked();
    error NotReady(uint256 readyAt);
    error Expired();
    error NotCandidate(address caller);
    error NothingPending();
    error NoRecovery();
    error RecoveryCooldown(uint256 until);
    error BadPayoutStatus(bytes32 eventKey, uint8 status);
    error NotWhitelisted(address account);
    error DailyCapExceeded(uint256 used, uint256 cap);
    error AddrDailyCapExceeded(address account, uint256 used, uint256 cap);
    error AmountAboveLimit(uint256 amount, uint256 limit);
    error AmountBelowMinimum(uint256 amount, uint256 minimum);
    error LengthMismatch();
    error NotTightening(uint256 index);
    error ParamOutOfRange(uint256 index);
    error ParamConstraint();

    // ------------------------------------------------------------------ events
    event WhitelistBatchApplied(bytes32 indexed listHash, bool allowed, uint256 nonce, uint256 count);
    event WhitelistUpdated(address indexed addr, bool allowed, bytes32 indexed listHash);
    event WhitelistNonceInvalidated(uint256 indexed invalidatedNonce);
    event WhitelistFrozen(address indexed by);
    event WhitelistUnfrozen();
    event WhitelistEmergencyRemoval(address indexed by, bytes32 indexed listHash, uint256 count);
    event WhitelistManagerTransferStarted(
        address indexed current, address indexed candidate, uint256 availableAt, uint256 expiresAt
    );
    event WhitelistManagerTransferCancelled(address indexed by, address indexed candidate);
    event WhitelistManagerChanged(address indexed previous, address indexed current, bool viaRecovery);
    event WhitelistRecoveryStarted(address indexed initiator, address indexed candidate, uint256 readyAt);
    event WhitelistRecoveryCancelled(address indexed by, address indexed candidate, uint256 cooldownUntil);
    event ReleaseQueued(
        bytes32 indexed eventKey,
        uint256 indexed srcEventNonce,
        address indexed to,
        uint256 amount,
        uint256 executableAt
    );
    event Released(bytes32 indexed eventKey, uint256 indexed srcEventNonce, address indexed to, uint256 amount);
    event SourceVoided(bytes32 indexed eventKey, uint256 indexed srcEventNonce, address indexed by);
    event Funded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);

    // ------------------------------------------------------------------ modifiers
    modifier onlyAdmin() {
        _checkAdmin();
        _;
    }

    modifier onlyWhitelistManager() {
        _checkWl();
        _;
    }

    modifier onlyAdminOrWhitelistManager() {
        _checkAdminOrWl();
        _;
    }

    /// @dev A-class (§4.3 A): only via the timelock and never while a recovery is in progress.
    modifier onlyTimelockA() {
        _checkTimelockA();
        _;
    }

    // ------------------------------------------------------------------ init
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    struct BaseInit {
        address timelock;
        address token;
        address whitelistManager;
        address relayer;
        address pauser;
        uint256 peerChainId;
        address peerBridge;
    }

    function __BridgeBase_init(string memory name, BaseInit memory a) internal onlyInitializing {
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        __EIP712_init(name, "1");
        if (a.timelock == address(0) || a.token == address(0) || a.peerChainId == 0) revert InvalidInit();
        if (ITimelockForBridge(a.timelock).bridge() != address(this)) revert InvalidInit();
        if (a.peerBridge != address(this)) revert InvalidInit();
        address admin = ITimelockForBridge(a.timelock).adminWallet();
        address[4] memory k = [admin, a.whitelistManager, a.relayer, a.pauser];
        for (uint256 i; i < 4; ++i) {
            if (k[i] == address(0)) revert ZeroAddress();
            for (uint256 j = i + 1; j < 4; ++j) {
                if (k[i] == k[j]) revert KeyConflict(k[i]);
            }
        }
        BaseStorage storage $ = _b();
        $.timelock = a.timelock;
        $.token = IERC20(a.token);
        $.unit = 10 ** IERC20Metadata(a.token).decimals();
        $.peerChainId = a.peerChainId;
        $.peerBridge = a.peerBridge;
        $.whitelistManager = a.whitelistManager;
        _grantRole(DEFAULT_ADMIN_ROLE, a.timelock);
        _grantRole(RELAYER_ROLE, a.relayer);
        _grantRole(PAUSER_ROLE, a.pauser);
        emit WhitelistManagerChanged(address(0), a.whitelistManager, false);
    }

    // ------------------------------------------------------------------ views
    function timelock() public view returns (address) {
        return _b().timelock;
    }

    function token() public view returns (IERC20) {
        return _b().token;
    }

    function peerChainId() external view returns (uint256) {
        return _b().peerChainId;
    }

    function peerBridge() external view returns (address) {
        return _b().peerBridge;
    }

    /// @notice Current admin wallet, read from the timelock (§4.2 item 8).
    function adminWallet() public view returns (address) {
        return ITimelockForBridge(_b().timelock).adminWallet();
    }

    function whitelistManager() public view returns (address) {
        return _b().whitelistManager;
    }

    function whitelisted(address account) public view returns (bool) {
        return _b().whitelisted[account];
    }

    function whitelistNonce() external view returns (uint256) {
        return _b().whitelistNonce;
    }

    function whitelistFrozen() external view returns (bool) {
        return _b().whitelistFrozen;
    }

    function pendingWhitelistManager() external view returns (address candidate, uint64 availableAt, uint64 expiresAt) {
        BaseStorage storage $ = _b();
        return ($.pendingWl, $.pendingWlAvailableAt, $.pendingWlExpiresAt);
    }

    function whitelistRecovery()
        external
        view
        returns (bool active, address candidate, uint64 readyAt, uint64 cooldownUntil)
    {
        BaseStorage storage $ = _b();
        return ($.recoveryActive, $.recoveryCandidate, $.recoveryReadyAt, $.recoveryCooldownUntil);
    }

    function whitelistRecoveryActive() public view returns (bool) {
        return _b().recoveryActive;
    }

    /// @notice True while either the whitelist-wallet recovery or the admin-wallet recovery is in progress.
    function anyRecoveryActive() public view returns (bool) {
        return _b().recoveryActive || ITimelockForBridge(_b().timelock).adminRecoveryActive();
    }

    function isKeyHolder(address account) public view returns (bool) {
        return account == _b().whitelistManager || hasRole(RELAYER_ROLE, account) || hasRole(PAUSER_ROLE, account);
    }

    function payouts(bytes32 eventKey)
        external
        view
        returns (address to, uint128 amount, uint64 queuedAt, uint8 status)
    {
        Payout storage p = _b().payouts[eventKey];
        return (p.to, p.amount, p.queuedAt, p.status);
    }

    /// @notice eventKey = keccak256(abi.encode("WANTOS-BSC-BRIDGE-V2", srcChainId, srcBridge, srcEventNonce)).
    function computeEventKey(uint256 srcChainId, address srcBridge, uint256 srcEventNonce)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(EVENT_KEY_TAG, srcChainId, srcBridge, srcEventNonce));
    }

    /// @notice Key of an inbound payout whose source event lives on the peer chain.
    function eventKeyOf(uint256 srcEventNonce) public view returns (bytes32) {
        BaseStorage storage $ = _b();
        return computeEventKey($.peerChainId, $.peerBridge, srcEventNonce);
    }

    function currentDay() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function dailyUsed(uint256 day) external view returns (uint256) {
        return _b().dailyUsed[day];
    }

    function addrDailyUsed(uint256 day, address account) external view returns (uint256) {
        return _b().addrDailyUsed[day][account];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice EIP-712 digest the whitelist wallet signs for a batch (for offline tooling parity).
    function hashWhitelistBatch(address[] calldata sortedAddrs, bool allowed, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 listHash = keccak256(abi.encode(sortedAddrs));
        return _hashTypedDataV4(
            keccak256(
                abi.encode(WHITELIST_BATCH_TYPEHASH, listHash, uint32(sortedAddrs.length), allowed, nonce, deadline)
            )
        );
    }

    // ------------------------------------------------------------------ whitelist (§4.4)
    function applyWhitelistBatch(
        address[] calldata sortedAddrs,
        bool allowed,
        uint256 nonce,
        uint256 deadline,
        bytes calldata wlSignature
    ) external {
        BaseStorage storage $ = _b();
        uint256 n = sortedAddrs.length;
        if (n == 0 || n > MAX_WHITELIST_BATCH) revert BadBatchSize(n);
        if (anyRecoveryActive() || (allowed && $.whitelistFrozen)) revert WhitelistWritesBlocked();
        if (nonce != $.whitelistNonce) revert BadNonce($.whitelistNonce, nonce);
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        if (deadline > block.timestamp + MAX_SIGNATURE_TTL) revert DeadlineTooFar(deadline);
        address signer = ECDSA.recover(hashWhitelistBatch(sortedAddrs, allowed, nonce, deadline), wlSignature);
        if (signer != $.whitelistManager) revert InvalidSigner(signer);
        $.whitelistNonce = nonce + 1;
        bytes32 listHash = keccak256(abi.encode(sortedAddrs));
        address prev = address(0);
        for (uint256 i; i < n; ++i) {
            address a = sortedAddrs[i];
            if (a == address(0)) revert ZeroAddress();
            if (i > 0 && a <= prev) revert AddressesNotSorted(i);
            prev = a;
            $.whitelisted[a] = allowed;
            emit WhitelistUpdated(a, allowed, listHash);
        }
        emit WhitelistBatchApplied(listHash, allowed, nonce, n);
    }

    function invalidateWhitelistNonce() external onlyWhitelistManager {
        uint256 old = _b().whitelistNonce++;
        emit WhitelistNonceInvalidated(old);
    }

    /// @notice Decision 10: admin freezes whitelist additions immediately.
    function freezeWhitelist() external onlyAdmin {
        _b().whitelistFrozen = true;
        emit WhitelistFrozen(msg.sender);
    }

    /// @notice A-class: unfreezing goes through the timelock and not while paused.
    function unfreezeWhitelist() external onlyTimelockA whenNotPaused {
        _b().whitelistFrozen = false;
        emit WhitelistUnfrozen();
    }

    /// @notice Decision 10: admin removes addresses immediately (tighten only).
    function emergencyRemove(address[] calldata addrs) external onlyAdmin {
        BaseStorage storage $ = _b();
        bytes32 listHash = keccak256(abi.encode(addrs));
        for (uint256 i; i < addrs.length; ++i) {
            $.whitelisted[addrs[i]] = false;
            emit WhitelistUpdated(addrs[i], false, listHash);
        }
        emit WhitelistEmergencyRemoval(msg.sender, listHash, addrs.length);
    }

    // ------------------------------------------------------------------ whitelist-wallet handover (§4.5)
    function beginWhitelistManagerTransfer(address candidate) external onlyWhitelistManager {
        if (anyRecoveryActive()) revert RecoveryInProgress();
        _checkWlCandidate(candidate);
        BaseStorage storage $ = _b();
        uint64 avail = uint64(block.timestamp + WL_TRANSFER_DELAY);
        uint64 exp = uint64(avail + WL_TRANSFER_TTL);
        $.pendingWl = candidate;
        $.pendingWlAvailableAt = avail;
        $.pendingWlExpiresAt = exp;
        emit WhitelistManagerTransferStarted(msg.sender, candidate, avail, exp);
    }

    /// @notice Current whitelist wallet cancels, or the admin wallet vetoes.
    function cancelWhitelistManagerTransfer() external onlyAdminOrWhitelistManager {
        BaseStorage storage $ = _b();
        address c = $.pendingWl;
        if (c == address(0)) revert NothingPending();
        _clearPendingWl();
        emit WhitelistManagerTransferCancelled(msg.sender, c);
    }

    function acceptWhitelistManagerTransfer() external {
        BaseStorage storage $ = _b();
        if (msg.sender != $.pendingWl || msg.sender == address(0)) revert NotCandidate(msg.sender);
        if (anyRecoveryActive()) revert RecoveryInProgress();
        if (block.timestamp < $.pendingWlAvailableAt) revert NotReady($.pendingWlAvailableAt);
        if (block.timestamp > $.pendingWlExpiresAt) revert Expired();
        _checkWlCandidate(msg.sender);
        _setWhitelistManager(msg.sender, false);
    }

    // ------------------------------------------------------------------ whitelist-wallet recovery (§4.5)
    function startWhitelistRecovery(address candidate) external onlyAdmin {
        BaseStorage storage $ = _b();
        if (anyRecoveryActive()) revert RecoveryInProgress();
        if (block.timestamp < $.recoveryCooldownUntil) revert RecoveryCooldown($.recoveryCooldownUntil);
        _checkWlCandidate(candidate);
        _clearPendingWl();
        uint64 readyAt = uint64(block.timestamp + WL_RECOVERY_DELAY);
        $.recoveryActive = true;
        $.recoveryCandidate = candidate;
        $.recoveryReadyAt = readyAt;
        emit WhitelistRecoveryStarted(msg.sender, candidate, readyAt);
    }

    /// @notice Current whitelist wallet or admin wallet cancels; the initiator side then cools down 3 days.
    function cancelWhitelistRecovery() external {
        BaseStorage storage $ = _b();
        if (!$.recoveryActive) revert NoRecovery();
        _checkAdminOrWl();
        address c = $.recoveryCandidate;
        _clearRecovery();
        uint64 until = uint64(block.timestamp + RECOVERY_COOLDOWN);
        $.recoveryCooldownUntil = until;
        emit WhitelistRecoveryCancelled(msg.sender, c, until);
    }

    function acceptWhitelistRecovery() external {
        BaseStorage storage $ = _b();
        if (!$.recoveryActive || msg.sender != $.recoveryCandidate) revert NotCandidate(msg.sender);
        if (block.timestamp < $.recoveryReadyAt) revert NotReady($.recoveryReadyAt);
        _checkWlCandidate(msg.sender);
        _clearRecovery();
        _setWhitelistManager(msg.sender, true);
    }

    // ------------------------------------------------------------------ pause (§4.3 C)
    function pause() external {
        address s = msg.sender;
        if (!hasRole(PAUSER_ROLE, s) && s != adminWallet() && s != _b().whitelistManager) revert NotAuthorized(s);
        _pause();
    }

    function unpause() external onlyAdminOrWhitelistManager {
        _unpause();
    }

    // ------------------------------------------------------------------ keys (§4.2, §4.3)
    /// @notice A-class: grant RELAYER_ROLE / PAUSER_ROLE via the timelock (allowed while paused). Mutual exclusion enforced.
    function grantRole(bytes32 role, address account) public override onlyTimelockA {
        if (role != RELAYER_ROLE && role != PAUSER_ROLE) revert InvalidRole(role);
        if (account == address(0)) revert ZeroAddress();
        if (isKeyHolder(account) || account == adminWallet()) revert KeyConflict(account);
        _grantRole(role, account);
    }

    function revokeRole(bytes32 role, address account) public override {
        if (msg.sender != _b().timelock) revert NotTimelock(msg.sender);
        _revokeKey(role, account);
    }

    /// @notice B-class: admin wallet revokes a relayer / pauser immediately.
    function revokeKey(bytes32 role, address account) external onlyAdmin {
        _revokeKey(role, account);
    }

    function renounceRole(bytes32 role, address callerConfirmation) public override {
        if (role == DEFAULT_ADMIN_ROLE) revert InvalidRole(role);
        super.renounceRole(role, callerConfirmation);
    }

    function _revokeKey(bytes32 role, address account) private {
        if (role != RELAYER_ROLE && role != PAUSER_ROLE) revert InvalidRole(role);
        _revokeRole(role, account);
    }

    // ------------------------------------------------------------------ payouts (§5.2 state machine, shared)
    /// @notice Void a source (None or Queued -> Voided). Admin or whitelist wallet; allowed while paused.
    function voidSource(uint256 srcEventNonce) external onlyAdminOrWhitelistManager {
        _void(srcEventNonce, false);
    }

    function voidSourceBatch(uint256[] calldata srcEventNonces) external onlyAdminOrWhitelistManager {
        for (uint256 i; i < srcEventNonces.length; ++i) {
            _void(srcEventNonces[i], false);
        }
    }

    /// @notice Cancel a queued release (Queued -> Voided). Admin or whitelist wallet; allowed while paused.
    function cancelRelease(uint256 srcEventNonce) external onlyAdminOrWhitelistManager {
        _void(srcEventNonce, true);
    }

    function _void(uint256 nonce, bool requireQueued) private {
        BaseStorage storage $ = _b();
        bytes32 key = eventKeyOf(nonce);
        Payout storage p = $.payouts[key];
        uint8 st = p.status;
        if (st == P_QUEUED) {
            // same-UTC-day comparison of day numbers, not of balances
            // slither-disable-next-line incorrect-equality
            if (p.queuedAt / 1 days == currentDay()) _unchargeQuota(p.to, p.amount);
        } else if (requireQueued || st != P_NONE) {
            revert BadPayoutStatus(key, st);
        }
        p.status = P_VOIDED;
        emit SourceVoided(key, nonce, msg.sender);
    }

    /// @dev Records a new payout. Returns replay=true (and changes nothing) for an identical re-queue of a Queued payout.
    function _recordPayout(uint256 nonce, address to, uint256 amount, uint8 status)
        internal
        returns (bytes32 key, bool replay)
    {
        key = eventKeyOf(nonce);
        Payout storage p = _b().payouts[key];
        uint8 st = p.status;
        if (st != P_NONE) {
            if (status == P_QUEUED && st == P_QUEUED && p.to == to && p.amount == amount) return (key, true);
            revert BadPayoutStatus(key, st);
        }
        p.to = to;
        p.amount = uint128(amount);
        p.queuedAt = uint64(block.timestamp);
        p.status = status;
    }

    /// @dev Queued -> Released after `delay`; returns the payout for the caller's extra checks.
    function _executePayout(uint256 nonce, uint256 delay) internal returns (bytes32 key, Payout storage p) {
        key = eventKeyOf(nonce);
        p = _b().payouts[key];
        if (p.status != P_QUEUED) revert BadPayoutStatus(key, p.status);
        uint256 readyAt = uint256(p.queuedAt) + delay;
        if (block.timestamp < readyAt) revert NotReady(readyAt);
        p.status = P_RELEASED;
    }

    /// @dev Return quota charged today for a queued payout that is being voided.
    function _unchargeQuota(address to, uint256 amount) internal virtual;

    // ------------------------------------------------------------------ quotas (UTC natural day)
    function _chargeDaily(uint256 amount, uint256 cap) internal {
        mapping(uint256 => uint256) storage m = _b().dailyUsed;
        uint256 d = currentDay();
        uint256 used = m[d] + amount;
        if (used > cap) revert DailyCapExceeded(used, cap);
        m[d] = used;
    }

    function _chargeAddr(address account, uint256 amount, uint256 cap) internal {
        mapping(address => uint256) storage m = _b().addrDailyUsed[currentDay()];
        uint256 used = m[account] + amount;
        if (used > cap) revert AddrDailyCapExceeded(account, used, cap);
        m[account] = used;
    }

    function _unchargeDaily(uint256 amount) internal {
        _b().dailyUsed[currentDay()] -= amount;
    }

    function _unchargeAddr(address account, uint256 amount) internal {
        _b().addrDailyUsed[currentDay()][account] -= amount;
    }

    // ------------------------------------------------------------------ reserve
    /// @notice Anyone tops up the reserve (§4.3 F).
    function fund(uint256 amount) external nonReentrant {
        uint256 received = _pull(msg.sender, amount);
        emit Funded(msg.sender, received);
    }

    /// @notice A-class: withdraw reserve, timelock only, not while paused.
    function withdraw(address to, uint256 amount) external onlyTimelockA whenNotPaused nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _b().token.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    // ------------------------------------------------------------------ internals
    function _pull(address from, uint256 amount) internal returns (uint256 received) {
        if (amount == 0) revert ZeroAmount();
        IERC20 t = _b().token;
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(from, address(this), amount);
        received = t.balanceOf(address(this)) - before;
    }

    function _push(address to, uint256 amount) internal {
        _b().token.safeTransfer(to, amount);
    }

    function _unit() internal view returns (uint256) {
        return _b().unit;
    }

    function _requireWhitelisted(address a) internal view {
        if (!_b().whitelisted[a]) revert NotWhitelisted(a);
    }

    function _checkAdmin() internal view {
        if (msg.sender != adminWallet()) revert NotAdmin(msg.sender);
    }

    function _checkWl() internal view {
        if (msg.sender != _b().whitelistManager) revert NotWhitelistManager(msg.sender);
    }

    function _checkAdminOrWl() internal view {
        if (msg.sender != adminWallet() && msg.sender != _b().whitelistManager) {
            revert NotAdminOrWhitelistManager(msg.sender);
        }
    }

    function _checkTimelockA() internal view {
        if (msg.sender != _b().timelock) revert NotTimelock(msg.sender);
        if (anyRecoveryActive()) revert RecoveryInProgress();
    }

    function _checkWlCandidate(address c) private view {
        if (c == address(0)) revert ZeroAddress();
        if (isKeyHolder(c) || c == adminWallet()) revert KeyConflict(c);
    }

    function _setWhitelistManager(address n, bool viaRecovery) private {
        BaseStorage storage $ = _b();
        address old = $.whitelistManager;
        $.whitelistManager = n;
        _clearPendingWl();
        emit WhitelistManagerChanged(old, n, viaRecovery);
    }

    function _clearPendingWl() private {
        BaseStorage storage $ = _b();
        $.pendingWl = address(0);
        $.pendingWlAvailableAt = 0;
        $.pendingWlExpiresAt = 0;
    }

    function _clearRecovery() private {
        BaseStorage storage $ = _b();
        $.recoveryActive = false;
        $.recoveryCandidate = address(0);
        $.recoveryReadyAt = 0;
    }

    /// @dev Upgrades: timelock only, allowed while paused, never during a recovery (§4.3 A).
    function _authorizeUpgrade(address) internal view override {
        _checkTimelockA();
    }
}
