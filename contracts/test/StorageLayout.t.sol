// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BscFixture} from "./utils/Fixtures.sol";
import {WantosFixture} from "./utils/WantosFixture.sol";
import {BscVaultV2} from "../src/BscVaultV2.sol";
import {BscVaultV2Appended} from "./mocks/UpgradeMocks.sol";

/// B5: committed storage-layout snapshots (contracts/test/layout/*.json) checked against live storage.
/// solc's storageLayout is empty for ERC-7201 namespaced storage, so each namespace has its own
/// field table (slot / byte offset / size) that these tests verify with vm.load.
contract BscLayoutTest is BscFixture {
    string baseJson;
    string vaultJson;
    uint256 base;
    uint256 vbase;

    function setUp() public {
        _deployBsc();
        baseJson = vm.readFile("contracts/test/layout/BridgeBase.namespace.json");
        vaultJson = vm.readFile("contracts/test/layout/BscVaultV2.namespace.json");
        base = vm.parseJsonUint(baseJson, ".base");
        vbase = vm.parseJsonUint(vaultJson, ".base");
    }

    function _field(string memory json, string memory name) internal view returns (uint256 s, uint256 o, uint256 n) {
        string memory k = string.concat(".fields.", name);
        s = vm.parseJsonUint(json, string.concat(k, ".slot"));
        o = vm.parseJsonUint(json, string.concat(k, ".offset"));
        n = vm.parseJsonUint(json, string.concat(k, ".bytes"));
    }

    function _read(uint256 slot, uint256 off, uint256 size) internal view returns (uint256) {
        uint256 w = uint256(vm.load(address(vault), bytes32(slot)));
        uint256 mask = size == 32 ? type(uint256).max : (uint256(1) << (size * 8)) - 1;
        return (w >> (off * 8)) & mask;
    }

    function _b(string memory name) internal view returns (uint256) {
        (uint256 s, uint256 o, uint256 n) = _field(baseJson, name);
        return _read(base + s, o, n);
    }

    function _v(string memory name) internal view returns (uint256) {
        (uint256 s, uint256 o, uint256 n) = _field(vaultJson, name);
        return _read(vbase + s, o, n);
    }

    function _bslot(string memory name) internal view returns (uint256 s) {
        (s,,) = _field(baseJson, name);
        s += base;
    }

    function test_solcLayoutSnapshotsHaveNoSequentialStorage() public view {
        // bridges must keep ALL state in ERC-7201 namespaces
        assertEq(
            vm.parseJsonKeys(vm.readFile("contracts/test/layout/BscVaultV2.storageLayout.json"), ".types").length, 0
        );
        assertEq(
            vm.parseJsonKeys(vm.readFile("contracts/test/layout/WantosBridgeV2.storageLayout.json"), ".types").length, 0
        );
    }

    function test_namespaceSlotsMatchFormula() public view {
        assertEq(
            bytes32(base),
            keccak256(abi.encode(uint256(keccak256("wantos.bridge.v2.BridgeBase")) - 1)) & ~bytes32(uint256(0xff))
        );
        assertEq(
            bytes32(vbase),
            keccak256(abi.encode(uint256(keccak256("wantos.bridge.v2.BscVaultV2")) - 1)) & ~bytes32(uint256(0xff))
        );
        assertEq(vm.parseJsonKeys(baseJson, ".fields").length, 19);
        assertEq(vm.parseJsonKeys(vaultJson, ".fields").length, 9);
    }

    function test_baseNamespaceFieldsMatchSnapshot() public {
        // populate state
        _applyBatch(vault, _one(alice), true);
        vm.prank(admin);
        vault.freezeWhitelist();
        vm.prank(wl);
        vault.beginWhitelistManagerTransfer(bob);
        vm.prank(relayer);
        vault.queueRelease(7, alice, 1_500 * U);

        assertEq(_b("timelock"), uint160(address(tl)));
        assertEq(_b("token"), uint160(address(token)));
        assertEq(_b("unit"), 1e18);
        assertEq(_b("peerChainId"), WANTOS_CHAIN);
        assertEq(_b("peerBridge"), uint160(address(vault)));
        assertEq(_b("whitelistManager"), uint160(wl));
        assertEq(_b("whitelistNonce"), 1);
        assertEq(_b("whitelistFrozen"), 1);
        (address c, uint64 avail, uint64 exp) = vault.pendingWhitelistManager();
        assertEq(_b("pendingWl"), uint160(c));
        assertEq(_b("pendingWlAvailableAt"), avail);
        assertEq(_b("pendingWlExpiresAt"), exp);
        // mappings
        assertEq(uint256(vm.load(address(vault), keccak256(abi.encode(alice, _bslot("whitelisted"))))), 1);
        bytes32 pslot = keccak256(abi.encode(_key(7), _bslot("payouts")));
        assertEq(uint256(vm.load(address(vault), pslot)), uint160(alice)); // Payout.to
        uint256 w1 = uint256(vm.load(address(vault), bytes32(uint256(pslot) + 1)));
        assertEq(uint128(w1), 1_500 * U); // Payout.amount
        assertEq(uint64(w1 >> 128), block.timestamp); // Payout.queuedAt
        assertEq(uint8(w1 >> 192), 1); // Payout.status = Queued
        uint256 day = vault.currentDay();
        assertEq(uint256(vm.load(address(vault), keccak256(abi.encode(day, _bslot("dailyUsed"))))), 1_500 * U);
        bytes32 inner = keccak256(abi.encode(day, _bslot("addrDailyUsed")));
        assertEq(uint256(vm.load(address(vault), keccak256(abi.encode(alice, inner)))), 1_500 * U);
    }

    function test_recoveryFieldsMatchSnapshot() public {
        vm.prank(admin);
        vault.startWhitelistRecovery(bob);
        vm.prank(wl);
        vault.cancelWhitelistRecovery();
        vm.warp(block.timestamp + 3 days);
        vm.prank(admin);
        vault.startWhitelistRecovery(carol);
        (bool active, address cand, uint64 readyAt, uint64 cooldown) = vault.whitelistRecovery();
        assertEq(_b("recoveryActive"), active ? 1 : 0);
        assertEq(_b("recoveryCandidate"), uint160(cand));
        assertEq(_b("recoveryReadyAt"), readyAt);
        assertEq(_b("recoveryCooldownUntil"), cooldown);
        assertTrue(cooldown != 0);
    }

    function test_vaultNamespaceFieldsMatchSnapshot() public {
        token.mint(carol, 100 * U);
        vm.startPrank(carol);
        token.approve(address(vault), 100 * U);
        uint256 n = vault.deposit(100 * U, carol);
        vm.stopPrank();
        bytes32[] memory k = new bytes32[](1);
        k[0] = bytes32("old");
        uint256[] memory amt = new uint256[](1);
        amt[0] = 1;
        vm.prank(address(tl));
        vault.payLegacyBatch(k, _one(bob), amt);
        BscVaultV2.Params memory p = vault.params();
        assertEq(_v("params_dailyCap"), p.dailyCap);
        assertEq(_v("params_perAddrDailyCap"), p.perAddrDailyCap);
        assertEq(_v("params_largeThreshold"), p.largeThreshold);
        assertEq(_v("params_releaseDelay"), p.releaseDelay);
        assertEq(_v("params_minDeposit"), p.minDeposit);
        assertEq(_v("params_maxDepositPerTx"), p.maxDepositPerTx);
        assertEq(_v("depositNonce"), n);
        (uint256 ds,,) = _field(vaultJson, "deposits");
        bytes32 dslot = keccak256(abi.encode(n, vbase + ds));
        assertEq(uint256(vm.load(address(vault), dslot)), uint160(carol));
        assertEq(uint128(uint256(vm.load(address(vault), bytes32(uint256(dslot) + 1)))), 100 * U);
        // Deposit packing (B1): slot+1 = amount (16 B @0) | refundRequestedAt (8 B @16) | refundStatus (1 B @24)
        vm.prank(admin);
        vault.requestDepositRefund(n);
        uint256 dw1 = uint256(vm.load(address(vault), bytes32(uint256(dslot) + 1)));
        assertEq(uint128(dw1), 100 * U, "Deposit.amount @ slot+1 offset 0");
        assertEq(uint64(dw1 >> 128), block.timestamp, "Deposit.refundRequestedAt @ slot+1 offset 16");
        assertEq(uint8(dw1 >> 192), 1, "Deposit.refundStatus (Refunding) @ slot+1 offset 24");
        assertEq(dw1 >> 200, 0, "nothing above offset 25");
        (,, uint64 rq, uint8 rs) = vault.deposits(n);
        assertEq(rq, block.timestamp);
        assertEq(rs, 1);
        (uint256 ls,,) = _field(vaultJson, "legacyPaid");
        assertEq(uint256(vm.load(address(vault), keccak256(abi.encode(bytes32("old"), vbase + ls)))), 1);
    }

    /// Appending a field at the end of the namespace struct keeps every old value; the new field starts at zero.
    function test_upgradeWithAppendedFieldKeepsDataAndZeroesNewField() public {
        _applyBatch(vault, _one(alice), true);
        vm.prank(relayer);
        vault.queueRelease(7, alice, 1_500 * U);
        token.mint(carol, 100 * U);
        vm.startPrank(carol);
        token.approve(address(vault), 100 * U);
        vault.deposit(100 * U, carol);
        vm.stopPrank();
        bytes32[] memory k = new bytes32[](1);
        k[0] = bytes32("old");
        uint256[] memory amt = new uint256[](1);
        amt[0] = 1;
        vm.prank(address(tl));
        vault.payLegacyBatch(k, _one(bob), amt);
        bytes memory paramsBefore = abi.encode(vault.params());

        BscVaultV2Appended next = new BscVaultV2Appended();
        _viaTimelock(address(vault), abi.encodeCall(vault.upgradeToAndCall, (address(next), "")));
        BscVaultV2Appended v2 = BscVaultV2Appended(address(vault));
        assertEq(v2.appendedField(), 0);
        assertEq(keccak256(abi.encode(v2.params())), keccak256(paramsBefore));
        assertEq(v2.depositNonce(), 1);
        (address from, uint128 a,,) = v2.deposits(1);
        assertEq(from, carol);
        assertEq(a, 100 * U);
        assertTrue(v2.legacyPaid(bytes32("old")));
        assertTrue(v2.whitelisted(alice));
        (,,, uint8 st) = v2.payouts(_key(7));
        assertEq(st, 1);
        v2.setAppendedField(42); // writing the new field does not disturb old data
        assertEq(v2.appendedField(), 42);
        assertEq(v2.depositNonce(), 1);
        assertTrue(v2.legacyPaid(bytes32("old")));
        assertEq(keccak256(abi.encode(v2.params())), keccak256(paramsBefore));
        vm.prank(relayer);
        v2.executeRelease(7);
        assertEq(token.balanceOf(alice), 1_500 * U);
    }
}

contract WantosLayoutTest is WantosFixture {
    function test_wantosNamespaceFieldsMatchSnapshot() public {
        _deployWantos();
        string memory j = vm.readFile("contracts/test/layout/WantosBridgeV2.namespace.json");
        uint256 b = vm.parseJsonUint(j, ".base");
        assertEq(
            bytes32(b),
            keccak256(abi.encode(uint256(keccak256("wantos.bridge.v2.WantosBridgeV2")) - 1)) & ~bytes32(uint256(0xff))
        );
        assertEq(vm.parseJsonKeys(j, ".fields").length, 7);
        _fundUser(alice, 1_000 * U);
        _applyBatch(bridge, _one(alice), true);
        vm.prank(alice);
        uint256 id = bridge.bridgeOut(300 * U);
        vm.prank(admin);
        bridge.requestRefund(id);
        assertEq(
            uint256(vm.load(address(bridge), bytes32(b + vm.parseJsonUint(j, ".fields.params_w2bMinAmount.slot")))),
            10 * U
        );
        assertEq(
            uint256(vm.load(address(bridge), bytes32(b + vm.parseJsonUint(j, ".fields.params_b2wDelay.slot")))),
            15 minutes
        );
        assertEq(
            uint256(vm.load(address(bridge), bytes32(b + vm.parseJsonUint(j, ".fields.supplyCeiling.slot")))),
            bridge.supplyCeiling()
        );
        assertEq(uint256(vm.load(address(bridge), bytes32(b + vm.parseJsonUint(j, ".fields.orderNonce.slot")))), 1);
        bytes32 os = keccak256(abi.encode(id, b + vm.parseJsonUint(j, ".fields.orders.slot")));
        assertEq(uint256(vm.load(address(bridge), os)), uint160(alice)); // Order.user
        uint256 w1 = uint256(vm.load(address(bridge), bytes32(uint256(os) + 1)));
        assertEq(uint128(w1), 300 * U); // amount
        assertEq(uint64(w1 >> 128), block.timestamp); // createdAt
        assertEq(uint8(w1 >> 192), 2); // status Refunding
        // refundRequestedAt (8 B) does not fit after status at offset 25 -> starts slot 2
        assertEq(uint64(uint256(vm.load(address(bridge), bytes32(uint256(os) + 2)))), block.timestamp);
    }
}
