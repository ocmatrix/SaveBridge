// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BridgeBase} from "./BridgeBase.sol";

/// @title WantosBridgeV2
/// @notice WANTOS side of the whitelist bridge v2 (DESIGN.md v0.9.4 §5.3). Holds WANTOS-USDT.
///         W2B: bridgeOut (whitelisted EOAs only, per-address UTC-day cap, supply ceiling) creating Orders;
///         refunds of rejected orders (24h, counted in b2wDailyCap); B2W inbound releases always queued (b2wDelay).
contract WantosBridgeV2 is BridgeBase {
    // ------------------------------------------------------------------ types
    struct Params {
        uint256 w2bMinAmount;
        uint256 w2bPerAddrDailyCap; // per address per UTC day; also the per-order cap
        uint256 b2wDailyCap; // global UTC-day cap on inbound releases and refund executions
        uint256 b2wDelay; // queue -> execute for inbound releases
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
        uint256 supplyCeiling;
    }

    // Order status (§5.4; 0 = no such order)
    uint8 internal constant O_NONE = 0;
    uint8 internal constant O_LOCKED = 1;
    uint8 internal constant O_REFUNDING = 2;
    uint8 internal constant O_REFUNDED = 3;

    struct Order {
        address user;
        uint128 amount;
        uint64 createdAt;
        uint8 status;
        uint64 refundRequestedAt;
    }

    /// @custom:storage-location erc7201:wantos.bridge.v2.WantosBridgeV2
    struct WantosStorage {
        Params params;
        uint256 supplyCeiling;
        uint256 orderNonce; // last used orderId; first order is 1
        mapping(uint256 orderId => Order) orders;
    }

    // keccak256(abi.encode(uint256(keccak256("wantos.bridge.v2.WantosBridgeV2")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant WANTOS_STORAGE = 0x0387244fc401591078165e394a48ae68f7f99ff8e3e2c39eec4873b00e673300;

    function _w() private pure returns (WantosStorage storage $) {
        assembly {
            $.slot := WANTOS_STORAGE
        }
    }

    // ------------------------------------------------------------------ errors / events
    error ContractCaller(address caller);
    error SupplyCeilingExceeded(uint256 totalSupply, uint256 ceiling);
    error CeilingBelowSupply(uint256 ceiling, uint256 totalSupply);
    error BadOrderStatus(uint256 orderId, uint8 status);

    event ParamsUpdated(Params params, address indexed by);
    event SupplyCeilingUpdated(uint256 previous, uint256 current, address indexed by);
    event BridgeOut(uint256 indexed orderId, address indexed user, uint256 amount);
    event RefundRequested(
        uint256 indexed orderId, bytes32 indexed eventKey, address indexed user, uint256 amount, uint256 executableAt
    );
    event RefundCancelled(uint256 indexed orderId, address indexed by);
    event Refunded(uint256 indexed orderId, address indexed user, uint256 amount);

    // ------------------------------------------------------------------ init
    function initialize(InitArgs calldata a) external initializer {
        __BridgeBase_init(
            "WantosBridgeV2",
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
        _w().params = a.params;
        emit ParamsUpdated(a.params, msg.sender);
        _setCeiling(a.supplyCeiling);
    }

    // ------------------------------------------------------------------ views
    function params() external view returns (Params memory) {
        return _w().params;
    }

    function supplyCeiling() external view returns (uint256) {
        return _w().supplyCeiling;
    }

    function orderNonce() external view returns (uint256) {
        return _w().orderNonce;
    }

    function orders(uint256 orderId)
        external
        view
        returns (address user, uint128 amount, uint64 createdAt, uint8 status, uint64 refundRequestedAt)
    {
        Order storage o = _w().orders[orderId];
        return (o.user, o.amount, o.createdAt, o.status, o.refundRequestedAt);
    }

    /// @notice eventKey of the BSC payout for `orderId` (source = this chain, this contract).
    function orderEventKey(uint256 orderId) public view returns (bytes32) {
        return computeEventKey(block.chainid, address(this), orderId);
    }

    // ------------------------------------------------------------------ W2B: bridgeOut
    /// @notice Lock `amount` WANTOS-USDT for payout to msg.sender on BSC.
    function bridgeOut(uint256 amount) external whenNotPaused nonReentrant returns (uint256 orderId) {
        _requireWhitelisted(msg.sender);
        if (msg.sender.code.length != 0) revert ContractCaller(msg.sender);
        WantosStorage storage $ = _w();
        uint256 ts = token().totalSupply();
        if (ts > $.supplyCeiling) revert SupplyCeilingExceeded(ts, $.supplyCeiling);
        uint256 received = _pull(msg.sender, amount);
        if (received < $.params.w2bMinAmount) revert AmountBelowMinimum(received, $.params.w2bMinAmount);
        _chargeAddr(msg.sender, received, $.params.w2bPerAddrDailyCap);
        orderId = ++$.orderNonce;
        $.orders[orderId] = Order({
            user: msg.sender,
            amount: uint128(received),
            createdAt: uint64(block.timestamp),
            status: O_LOCKED,
            refundRequestedAt: 0
        });
        emit BridgeOut(orderId, msg.sender, received);
    }

    // ------------------------------------------------------------------ refunds of rejected orders
    function requestRefund(uint256 orderId) external onlyAdmin {
        _requestRefund(orderId);
    }

    function requestRefundBatch(uint256[] calldata orderIds) external onlyAdmin {
        for (uint256 i; i < orderIds.length; ++i) {
            _requestRefund(orderIds[i]);
        }
    }

    function _requestRefund(uint256 orderId) private {
        Order storage o = _order(orderId, O_LOCKED);
        o.status = O_REFUNDING;
        o.refundRequestedAt = uint64(block.timestamp);
        emit RefundRequested(orderId, orderEventKey(orderId), o.user, o.amount, block.timestamp + REFUND_DELAY);
    }

    function cancelRefund(uint256 orderId) external onlyAdminOrWhitelistManager {
        Order storage o = _order(orderId, O_REFUNDING);
        o.status = O_LOCKED;
        o.refundRequestedAt = 0;
        emit RefundCancelled(orderId, msg.sender);
    }

    /// @notice Anyone, after 24h: refunds the original user the original amount; counts in b2wDailyCap.
    function executeRefund(uint256 orderId) external whenNotPaused nonReentrant {
        Order storage o = _order(orderId, O_REFUNDING);
        uint256 readyAt = uint256(o.refundRequestedAt) + REFUND_DELAY;
        if (block.timestamp < readyAt) revert NotReady(readyAt);
        o.status = O_REFUNDED;
        uint256 amount = o.amount;
        _chargeDaily(amount, _w().params.b2wDailyCap);
        _push(o.user, amount);
        emit Refunded(orderId, o.user, amount);
    }

    function _order(uint256 orderId, uint8 expected) private view returns (Order storage o) {
        o = _w().orders[orderId];
        if (o.status != expected) revert BadOrderStatus(orderId, o.status);
    }

    // ------------------------------------------------------------------ B2W inbound (relayer)
    /// @notice Queue an inbound release for BSC deposit `srcEventNonce`. No whitelist check (§5.3).
    function queueRelease(uint256 srcEventNonce, address to, uint256 amount)
        external
        onlyRole(RELAYER_ROLE)
        whenNotPaused
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        (bytes32 key, bool replay) = _recordPayout(srcEventNonce, to, amount, P_QUEUED);
        if (replay) return;
        Params storage p = _w().params;
        _chargeDaily(amount, p.b2wDailyCap);
        emit ReleaseQueued(key, srcEventNonce, to, amount, block.timestamp + p.b2wDelay);
    }

    function executeRelease(uint256 srcEventNonce) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant {
        (bytes32 key, Payout storage pay) = _executePayout(srcEventNonce, _w().params.b2wDelay);
        address to = pay.to;
        uint256 amount = pay.amount;
        _push(to, amount);
        emit Released(key, srcEventNonce, to, amount);
    }

    function _unchargeQuota(address, uint256 amount) internal override {
        _unchargeDaily(amount);
    }

    // ------------------------------------------------------------------ supply ceiling (§5.5)
    /// @notice Admin wallet lowers immediately; timelock may raise (A-class, not while paused). Never below totalSupply.
    function setSupplyCeiling(uint256 newCeiling) external {
        if (msg.sender == timelock()) {
            _checkTimelockA();
            _requireNotPaused();
        } else if (msg.sender == adminWallet()) {
            if (newCeiling > _w().supplyCeiling) revert NotTightening(0);
        } else {
            revert NotAuthorized(msg.sender);
        }
        _setCeiling(newCeiling);
    }

    function _setCeiling(uint256 c) private {
        uint256 ts = token().totalSupply();
        if (c < ts) revert CeilingBelowSupply(c, ts);
        WantosStorage storage $ = _w();
        emit SupplyCeilingUpdated($.supplyCeiling, c, msg.sender);
        $.supplyCeiling = c;
    }

    // ------------------------------------------------------------------ params (§5.5)
    function setParams(Params calldata n) external {
        Params storage o = _w().params;
        if (msg.sender == timelock()) {
            _checkTimelockA();
            _requireNotPaused();
        } else if (msg.sender == adminWallet()) {
            if (n.w2bMinAmount < o.w2bMinAmount) revert NotTightening(0);
            if (n.w2bPerAddrDailyCap > o.w2bPerAddrDailyCap) revert NotTightening(1);
            if (n.b2wDailyCap > o.b2wDailyCap) revert NotTightening(2);
            if (n.b2wDelay < o.b2wDelay) revert NotTightening(3);
        } else {
            revert NotAuthorized(msg.sender);
        }
        _validate(n);
        _w().params = n;
        emit ParamsUpdated(n, msg.sender);
    }

    function _validate(Params memory p) private view {
        uint256 u = _unit();
        if (p.w2bMinAmount < 10 * u || p.w2bMinAmount > 20_000 * u) revert ParamOutOfRange(0);
        if (p.w2bPerAddrDailyCap < 10 * u || p.w2bPerAddrDailyCap > 20_000 * u) revert ParamOutOfRange(1);
        if (p.b2wDailyCap < 500 * u || p.b2wDailyCap > 100_000_000 * u) revert ParamOutOfRange(2);
        if (p.b2wDelay > 24 hours) revert ParamOutOfRange(3);
        if (p.w2bMinAmount > p.w2bPerAddrDailyCap) revert ParamConstraint();
    }
}
