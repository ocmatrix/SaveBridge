// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BridgeBase} from "./BridgeBase.sol";

/// @title BscVaultV2
/// @notice BSC side of the whitelist bridge v2 (DESIGN.md v0.9.4 §5.2). Holds BSC-USDT directly.
///         W2B payouts (release / queueRelease / executeRelease) only to whitelisted addresses, within
///         UTC-day global and per-address caps; B2W deposits; deposit refunds; timelocked legacy payouts.
contract BscVaultV2 is BridgeBase {
    // ------------------------------------------------------------------ types
    struct Params {
        uint256 dailyCap; // global, UTC day (includes queued and deposit refunds)
        uint256 perAddrDailyCap; // per address per UTC day; also the per-payout cap
        uint256 largeThreshold; // release() only up to this; above must be queued
        uint256 releaseDelay; // queue -> execute
        uint256 minDeposit;
        uint256 maxDepositPerTx;
    }

    struct InitArgs {
        address timelock;
        address token;
        address whitelistManager;
        address relayer;
        address pauser;
        uint256 peerChainId;
        address peerBridge;
        Params params;
    }

    // Deposit refund status (§5.4)
    uint8 internal constant D_NONE = 0;
    uint8 internal constant D_REFUNDING = 1;
    uint8 internal constant D_REFUNDED = 2;

    struct Deposit {
        address from;
        uint128 amount;
        uint64 refundRequestedAt;
        uint8 refundStatus;
    }

    uint256 public constant MAX_LEGACY_BATCH = 100;

    /// @custom:storage-location erc7201:wantos.bridge.v2.BscVaultV2
    struct VaultStorage {
        Params params;
        uint256 depositNonce; // last used nonce; first deposit is 1
        mapping(uint256 nonce => Deposit) deposits;
        mapping(bytes32 oldKey => bool) legacyPaid;
    }

    // keccak256(abi.encode(uint256(keccak256("wantos.bridge.v2.BscVaultV2")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant VAULT_STORAGE = 0x3bd3aa2096e9f4b3aa0d653c2fcdf8cde24fb7f30fa893e85a7f630b4e747000;

    function _v() private pure returns (VaultStorage storage $) {
        assembly {
            $.slot := VAULT_STORAGE
        }
    }

    // ------------------------------------------------------------------ errors / events
    error UnknownDeposit(uint256 nonce);
    error BadDepositStatus(uint256 nonce, uint8 status);
    error LegacyAlreadyPaid(bytes32 oldKey);

    event ParamsUpdated(Params params, address indexed by);
    event Deposited(uint256 indexed nonce, address indexed from, address indexed wantosRecipient, uint256 amount);
    event DepositRefundRequested(
        uint256 indexed nonce, bytes32 indexed eventKey, address indexed from, uint256 amount, uint256 executableAt
    );
    event DepositRefundCancelled(uint256 indexed nonce, address indexed by);
    event DepositRefunded(uint256 indexed nonce, address indexed from, uint256 amount);
    event LegacyPaid(bytes32 indexed oldKey, address indexed to, uint256 amount);

    // ------------------------------------------------------------------ init
    function initialize(InitArgs calldata a) external initializer {
        __BridgeBase_init(
            "BscVaultV2",
            BaseInit({
                timelock: a.timelock,
                token: a.token,
                whitelistManager: a.whitelistManager,
                relayer: a.relayer,
                pauser: a.pauser,
                peerChainId: a.peerChainId,
                peerBridge: a.peerBridge
            })
        );
        _validate(a.params);
        _v().params = a.params;
        emit ParamsUpdated(a.params, msg.sender);
    }

    // ------------------------------------------------------------------ views
    function params() external view returns (Params memory) {
        return _v().params;
    }

    function depositNonce() external view returns (uint256) {
        return _v().depositNonce;
    }

    function deposits(uint256 nonce)
        external
        view
        returns (address from, uint128 amount, uint64 refundRequestedAt, uint8 refundStatus)
    {
        Deposit storage d = _v().deposits[nonce];
        return (d.from, d.amount, d.refundRequestedAt, d.refundStatus);
    }

    function legacyPaid(bytes32 oldKey) external view returns (bool) {
        return _v().legacyPaid[oldKey];
    }

    /// @notice eventKey of a BSC deposit, as used by the WANTOS side's B2W payout records.
    function depositEventKey(uint256 nonce) public view returns (bytes32) {
        return computeEventKey(block.chainid, address(this), nonce);
    }

    // ------------------------------------------------------------------ W2B payouts (relayer)
    /// @notice Immediate payout (amount <= largeThreshold). srcEventNonce = WANTOS orderId.
    function release(uint256 srcEventNonce, address to, uint256 amount)
        external
        onlyRole(RELAYER_ROLE)
        whenNotPaused
        nonReentrant
    {
        Params storage p = _v().params;
        _checkPayout(to, amount, p);
        if (amount > p.largeThreshold) revert AmountAboveLimit(amount, p.largeThreshold);
        (bytes32 key,) = _recordPayout(srcEventNonce, to, amount, P_RELEASED);
        _charge(to, amount, p);
        _push(to, amount);
        emit Released(key, srcEventNonce, to, amount);
    }

    /// @notice Queue a payout; quota is charged now. Identical replay of a Queued payout is a no-op.
    function queueRelease(uint256 srcEventNonce, address to, uint256 amount)
        external
        onlyRole(RELAYER_ROLE)
        whenNotPaused
    {
        Params storage p = _v().params;
        _checkPayout(to, amount, p);
        (bytes32 key, bool replay) = _recordPayout(srcEventNonce, to, amount, P_QUEUED);
        if (replay) return;
        _charge(to, amount, p);
        emit ReleaseQueued(key, srcEventNonce, to, amount, block.timestamp + p.releaseDelay);
    }

    function executeRelease(uint256 srcEventNonce) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        (bytes32 key, Payout storage pay) = _executePayout(srcEventNonce, _v().params.releaseDelay);
        address to = pay.to;
        _requireWhitelisted(to);
        uint256 amount = pay.amount;
        _push(to, amount);
        emit Released(key, srcEventNonce, to, amount);
    }

    function _checkPayout(address to, uint256 amount, Params storage p) private view {
        if (amount == 0) revert ZeroAmount();
        _requireWhitelisted(to);
        if (amount > p.perAddrDailyCap) revert AmountAboveLimit(amount, p.perAddrDailyCap);
    }

    function _charge(address to, uint256 amount, Params storage p) private {
        _chargeDaily(amount, p.dailyCap);
        _chargeAddr(to, amount, p.perAddrDailyCap);
    }

    function _unchargeQuota(address to, uint256 amount) internal override {
        _unchargeDaily(amount);
        _unchargeAddr(to, amount);
    }

    // ------------------------------------------------------------------ B2W deposits
    function deposit(uint256 amount, address wantosRecipient)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 nonce)
    {
        if (wantosRecipient == address(0)) revert ZeroAddress();
        VaultStorage storage $ = _v();
        uint256 received = _pull(msg.sender, amount);
        if (received < $.params.minDeposit) revert AmountBelowMinimum(received, $.params.minDeposit);
        if (received > $.params.maxDepositPerTx) revert AmountAboveLimit(received, $.params.maxDepositPerTx);
        nonce = ++$.depositNonce;
        $.deposits[nonce] =
            Deposit({from: msg.sender, amount: uint128(received), refundRequestedAt: 0, refundStatus: D_NONE});
        emit Deposited(nonce, msg.sender, wantosRecipient, received);
        _collectNativeFee();
    }

    // ------------------------------------------------------------------ native fee (BNB, follows gas price)
    /// @custom:storage-location erc7201:wantos.bridge.v2.BscNativeFee
    struct FeeStorage {
        address feeRecipient; // receives every fee at once; the contract never holds native coin
        uint256 multiplier; // fee = gasPrice * FEE_GAS * multiplier; 0 = off
    }

    // keccak256(abi.encode(uint256(keccak256("wantos.bridge.v2.BscNativeFee")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant FEE_STORAGE = 0xda0cb208263a332850054218d87c370a3978ccc2c5835848c161d1a30a2e7c00;

    /// @dev Gas of one approve + deposit (about 200k); times the multiplier this is "N x the user's own BSC gas".
    uint256 public constant FEE_GAS = 200_000;
    uint256 public constant MIN_FEE = 0.0001 ether; // = 10x at BSC's 0.05 gwei floor
    uint256 public constant MAX_FEE = 0.01 ether;
    uint256 public constant MAX_MULTIPLIER = 100;

    error WrongNativeFee();
    error NativeFeeTransferFailed();

    event NativeFeeCollected(address indexed payer, address indexed recipient, uint256 fee);
    event NativeFeeConfigUpdated(address indexed recipient, uint256 multiplier, address indexed by);

    function _f() private pure returns (FeeStorage storage $) {
        assembly {
            $.slot := FEE_STORAGE
        }
    }

    /// @notice BNB fee for a deposit sent at `gasPrice` (wei): a flat multiple of the user's own gas, the same
    ///         for every amount, clamped to [MIN_FEE, MAX_FEE]. 0 when switched off.
    function quoteNativeFee(uint256 gasPrice) public view returns (uint256 fee) {
        uint256 m = _f().multiplier;
        if (m == 0) return 0;
        fee = gasPrice * FEE_GAS * m;
        if (fee < MIN_FEE) return MIN_FEE;
        if (fee > MAX_FEE) return MAX_FEE;
    }

    /// @notice Where fees go and the current multiplier, for the admin UI and the watcher to verify.
    function nativeFeeConfig() external view returns (address recipient, uint256 multiplier) {
        FeeStorage storage $ = _f();
        return ($.feeRecipient, $.multiplier);
    }

    /// @notice Timelock only (A-class, not while paused): set recipient and multiplier (0 = off).
    function setNativeFeeConfig(address recipient, uint256 multiplier) external onlyTimelockA whenNotPaused {
        if (multiplier > MAX_MULTIPLIER) revert ParamOutOfRange(0);
        if (multiplier != 0 && recipient == address(0)) revert ZeroAddress();
        FeeStorage storage $ = _f();
        ($.feeRecipient, $.multiplier) = (recipient, multiplier);
        emit NativeFeeConfigUpdated(recipient, multiplier, msg.sender);
    }

    /// @notice Admin wallet kill switch: multiplier to 0, effective at once.
    function disableNativeFee() external onlyAdmin {
        FeeStorage storage $ = _f();
        $.multiplier = 0;
        emit NativeFeeConfigUpdated($.feeRecipient, 0, msg.sender);
    }

    /// @dev Called last in deposit. The fee follows tx.gasprice, so the wallet cannot know it to the wei:
    ///      msg.value must be >= the fee; the fee goes to the recipient at once and any excess is returned to the
    ///      sender, so no native coin is ever stuck in or owned by the bridge.
    function _collectNativeFee() private {
        uint256 fee = quoteNativeFee(tx.gasprice);
        if (msg.value < fee) revert WrongNativeFee();
        if (fee != 0) {
            address to = _f().feeRecipient;
            (bool ok,) = to.call{value: fee}("");
            if (!ok) revert NativeFeeTransferFailed();
            emit NativeFeeCollected(msg.sender, to, fee);
        }
        uint256 extra = msg.value - fee;
        if (extra != 0) {
            (bool ok,) = msg.sender.call{value: extra}("");
            if (!ok) revert NativeFeeTransferFailed();
        }
    }

    /// @notice Admin requests a refund of deposit `nonce` (WANTOS side must have voided its eventKey first).
    function requestDepositRefund(uint256 nonce) external onlyAdmin {
        Deposit storage d = _deposit(nonce);
        if (d.refundStatus != D_NONE) revert BadDepositStatus(nonce, d.refundStatus);
        d.refundStatus = D_REFUNDING;
        d.refundRequestedAt = uint64(block.timestamp);
        emit DepositRefundRequested(nonce, depositEventKey(nonce), d.from, d.amount, block.timestamp + REFUND_DELAY);
    }

    function cancelDepositRefund(uint256 nonce) external onlyAdminOrWhitelistManager {
        Deposit storage d = _deposit(nonce);
        if (d.refundStatus != D_REFUNDING) revert BadDepositStatus(nonce, d.refundStatus);
        d.refundStatus = D_NONE;
        d.refundRequestedAt = 0;
        emit DepositRefundCancelled(nonce, msg.sender);
    }

    /// @notice Anyone executes after 24h; pays the original depositor the original amount; counts in dailyCap.
    function executeDepositRefund(uint256 nonce) external whenNotPaused nonReentrant {
        Deposit storage d = _deposit(nonce);
        if (d.refundStatus != D_REFUNDING) revert BadDepositStatus(nonce, d.refundStatus);
        uint256 readyAt = uint256(d.refundRequestedAt) + REFUND_DELAY;
        if (block.timestamp < readyAt) revert NotReady(readyAt);
        d.refundStatus = D_REFUNDED;
        uint256 amount = d.amount;
        _chargeDaily(amount, _v().params.dailyCap);
        _push(d.from, amount);
        emit DepositRefunded(nonce, d.from, amount);
    }

    function _deposit(uint256 nonce) private view returns (Deposit storage d) {
        d = _v().deposits[nonce];
        if (d.from == address(0)) revert UnknownDeposit(nonce);
    }

    // ------------------------------------------------------------------ legacy payouts (§10)
    /// @notice A-class: pay old-bridge orders; each oldKey = keccak256(oldTxHash, logIndex) pays at most once.
    function payLegacyBatch(bytes32[] calldata oldKeys, address[] calldata to, uint256[] calldata amounts)
        external
        onlyTimelockA
        whenNotPaused
        nonReentrant
    {
        uint256 n = oldKeys.length;
        if (to.length != n || amounts.length != n) revert LengthMismatch();
        if (n == 0 || n > MAX_LEGACY_BATCH) revert BadBatchSize(n);
        mapping(bytes32 => bool) storage paid = _v().legacyPaid;
        for (uint256 i; i < n; ++i) {
            bytes32 k = oldKeys[i];
            if (paid[k]) revert LegacyAlreadyPaid(k);
            if (to[i] == address(0)) revert ZeroAddress();
            if (amounts[i] == 0) revert ZeroAmount();
            paid[k] = true;
            _push(to[i], amounts[i]);
            emit LegacyPaid(k, to[i], amounts[i]);
        }
    }

    // ------------------------------------------------------------------ params (§5.5)
    /// @notice Admin wallet: tighten immediately (any loosening field reverts the whole call).
    ///         Timelock: any change within ranges (A-class, not while paused).
    function setParams(Params calldata n) external {
        Params storage o = _v().params;
        if (msg.sender == timelock()) {
            _checkTimelockA();
            _requireNotPaused();
        } else if (msg.sender == adminWallet()) {
            if (n.dailyCap > o.dailyCap) revert NotTightening(0);
            if (n.perAddrDailyCap > o.perAddrDailyCap) revert NotTightening(1);
            if (n.largeThreshold > o.largeThreshold) revert NotTightening(2);
            if (n.releaseDelay < o.releaseDelay) revert NotTightening(3);
            if (n.minDeposit < o.minDeposit) revert NotTightening(4);
            if (n.maxDepositPerTx > o.maxDepositPerTx) revert NotTightening(5);
        } else {
            revert NotAuthorized(msg.sender);
        }
        _validate(n);
        _v().params = n;
        emit ParamsUpdated(n, msg.sender);
    }

    function _validate(Params memory p) private view {
        uint256 u = _unit();
        if (p.dailyCap < 1_000 * u || p.dailyCap > 500_000 * u) revert ParamOutOfRange(0);
        if (p.perAddrDailyCap < 100 * u || p.perAddrDailyCap > 20_000 * u) revert ParamOutOfRange(1);
        if (p.releaseDelay < 6 hours || p.releaseDelay > 7 days) revert ParamOutOfRange(3);
        if (p.minDeposit == 0 || p.minDeposit > 20_000 * u) revert ParamOutOfRange(4);
        if (p.maxDepositPerTx == 0 || p.maxDepositPerTx > 10_000_000 * u) revert ParamOutOfRange(5);
        if (p.largeThreshold > p.perAddrDailyCap || p.perAddrDailyCap > p.dailyCap) revert ParamConstraint();
    }
}
