// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BscFixture} from "./utils/Fixtures.sol";
import {WantosFixture} from "./utils/WantosFixture.sol";
import {BridgeBase} from "../src/BridgeBase.sol";
import {BscVaultV2} from "../src/BscVaultV2.sol";
import {WantosBridgeV2} from "../src/WantosBridgeV2.sol";

contract Rejector {
    receive() external payable {
        revert("no");
    }
}

/// a depositor that cannot receive native coin back
contract NoReceiveDepositor {
    function go(BscVaultV2 v, IERC20 t, uint256 amt) external payable {
        t.approve(address(v), amt);
        v.deposit{value: msg.value}(amt, address(this));
    }
}

// =================================================================== BSC: fee follows the gas price
contract NativeFeeBscTest is BscFixture {
    address recipient = address(0xADCDe89431978C79ef66956Cfed67ac925426957);
    uint256 constant GWEI = 1e9;
    uint256 constant FLOOR = 0.05 gwei; // BSC's minimum gas price

    function setUp() public {
        _deployBsc();
    }

    function _set(address to, uint256 m) internal {
        _viaTimelock(address(vault), abi.encodeCall(BscVaultV2.setNativeFeeConfig, (to, m)));
    }

    function _dep(address from, uint256 amt, uint256 value) internal {
        token.mint(from, amt);
        vm.deal(from, 1 ether);
        vm.startPrank(from);
        token.approve(address(vault), amt);
        vault.deposit{value: value}(amt, makeAddr("wantosRecipient"));
        vm.stopPrank();
    }

    function test_defaultOff() public {
        assertEq(vault.quoteNativeFee(FLOOR), 0);
        _dep(alice, 100 * U, 0);
        assertEq(vault.depositNonce(), 1);
    }

    function test_defaultOff_overpaymentReturned() public {
        uint256 before = alice.balance;
        _dep(alice, 100 * U, 0.5 ether);
        assertEq(alice.balance, 1 ether); // dealt 1 ether, got the 0.5 back
        before;
        assertEq(address(vault).balance, 0);
    }

    function test_quoteFollowsGasPrice_sameForAnyAmount() public {
        _set(recipient, 10);
        assertEq(vault.quoteNativeFee(FLOOR), 0.0005 ether); // 10x gives 0.0001, the floor lifts it to 0.0005
        assertEq(vault.quoteNativeFee(0.5 gwei), 0.001 ether);
        assertEq(vault.quoteNativeFee(0.25 gwei), 0.0005 ether); // exactly the floor
        assertEq(vault.quoteNativeFee(0.35 gwei), 0.0007 ether);
        assertEq(vault.quoteNativeFee(0), 0.0005 ether); // gas price 0 cannot dodge the fee
        assertEq(vault.quoteNativeFee(100 gwei), 0.002 ether); // cap
        (address r, uint256 m) = vault.nativeFeeConfig();
        assertEq(r, recipient);
        assertEq(m, 10);
    }

    function test_floatingFee_chargedAtTxGasPrice() public {
        _set(recipient, 10);
        vm.txGasPrice(0.5 gwei);
        uint256 before = recipient.balance;
        _dep(alice, 300 * U, 0.001 ether);
        assertEq(recipient.balance - before, 0.001 ether);
        assertEq(address(vault).balance, 0);
        assertEq(vault.depositNonce(), 1);
    }

    function test_underpaymentReverts_overpaymentReturned() public {
        _set(recipient, 10);
        vm.txGasPrice(0.5 gwei);
        token.mint(alice, 400 * U);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        token.approve(address(vault), 400 * U);
        vm.expectRevert(BscVaultV2.WrongNativeFee.selector);
        vault.deposit{value: 0.001 ether - 1}(300 * U, alice);
        vm.expectRevert(BscVaultV2.WrongNativeFee.selector);
        vault.deposit(300 * U, alice);
        uint256 before = alice.balance;
        uint256 r0 = recipient.balance;
        vault.deposit{value: 0.003 ether}(300 * U, alice);
        vm.stopPrank();
        assertEq(recipient.balance - r0, 0.001 ether);
        assertEq(before - alice.balance, 0.001 ether); // paid the fee, the rest came back
        assertEq(address(vault).balance, 0);
    }

    function test_rejectingRecipientRevertsWholeDeposit() public {
        _set(address(new Rejector()), 10);
        token.mint(alice, 300 * U);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        token.approve(address(vault), 300 * U);
        vm.expectRevert(BscVaultV2.NativeFeeTransferFailed.selector);
        vault.deposit{value: 0.0005 ether}(300 * U, alice);
        vm.stopPrank();
        assertEq(vault.depositNonce(), 0);
    }

    function test_depositorThatCannotReceiveRefundReverts() public {
        _set(recipient, 10);
        NoReceiveDepositor d = new NoReceiveDepositor();
        token.mint(address(d), 100 * U);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(BscVaultV2.NativeFeeTransferFailed.selector);
        d.go{value: 0.5 ether}(vault, token, 100 * U);
        d.go{value: 0.0005 ether}(vault, token, 100 * U); // exact payment needs no refund
        assertEq(vault.depositNonce(), 1);
    }

    function test_configBoundsAndAuth() public {
        bytes memory data = abi.encodeCall(BscVaultV2.setNativeFeeConfig, (recipient, 101));
        bytes32 salt = _propose(address(vault), data);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        _execute(address(vault), data, salt);

        data = abi.encodeCall(BscVaultV2.setNativeFeeConfig, (address(0), 10));
        salt = _propose(address(vault), data);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        _execute(address(vault), data, salt);

        _set(address(0), 0); // off needs no recipient
        assertEq(vault.quoteNativeFee(FLOOR), 0);

        vm.prank(admin);
        vm.expectRevert();
        vault.setNativeFeeConfig(recipient, 10); // admin cannot set, only the timelock
    }

    function test_killSwitch() public {
        _set(recipient, 10);
        vm.expectEmit(true, true, false, true);
        emit BscVaultV2.NativeFeeConfigUpdated(recipient, 0, admin);
        vm.prank(admin);
        vault.disableNativeFee();
        assertEq(vault.quoteNativeFee(10 gwei), 0);
        (address r, uint256 m) = vault.nativeFeeConfig();
        assertEq(r, recipient);
        assertEq(m, 0);
        _dep(alice, 100 * U, 0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdmin.selector, alice));
        vault.disableNativeFee();
    }

    function test_storageMatchesLayoutSnapshot() public {
        string memory j = vm.readFile("contracts/test/layout/BscNativeFee.namespace.json");
        uint256 base = vm.parseJsonUint(j, ".base");
        assertEq(
            bytes32(base),
            keccak256(abi.encode(uint256(keccak256("wantos.bridge.v2.BscNativeFee")) - 1)) & ~bytes32(uint256(0xff))
        );
        assertEq(vm.parseJsonKeys(j, ".fields").length, 2);
        _set(recipient, 10);
        assertEq(
            uint256(vm.load(address(vault), bytes32(base + vm.parseJsonUint(j, ".fields.feeRecipient.slot")))),
            uint256(uint160(recipient))
        );
        assertEq(uint256(vm.load(address(vault), bytes32(base + vm.parseJsonUint(j, ".fields.multiplier.slot")))), 10);
    }
}

// =================================================================== WANTOS: tiered by amount
contract NativeFeeWantosTest is WantosFixture {
    address recipient = address(0xADCDe89431978C79ef66956Cfed67ac925426957);

    function setUp() public {
        _deployWantos();
        _fundUser(alice, 10_000 * U);
        vm.deal(alice, 1000 ether);
        _applyBatch(bridge, _one(alice), true);
    }

    function _cfg(uint256[4] memory f, address to) internal pure returns (WantosBridgeV2.FeeStorage memory) {
        return WantosBridgeV2.FeeStorage({
            feeRecipient: to,
            l0: 200 * U,
            l1: 1000 * U,
            l2: 5000 * U,
            f0: f[0],
            f1: f[1],
            f2: f[2],
            f3: f[3]
        });
    }

    function _fees() internal pure returns (uint256[4] memory f) {
        f = [uint256(2.5 ether), 12 ether, 50 ether, 120 ether];
    }

    function _set() internal {
        _viaTimelock(address(bridge), abi.encodeCall(WantosBridgeV2.setNativeFeeTiers, (_cfg(_fees(), recipient))));
    }

    function _rejects(WantosBridgeV2.FeeStorage memory c) internal {
        bytes memory data = abi.encodeCall(WantosBridgeV2.setNativeFeeTiers, (c));
        bytes32 salt = _propose(address(bridge), data);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        _execute(address(bridge), data, salt);
        assertEq(bridge.quoteNativeFee(10 * U), 0);
    }

    function test_defaultOff_unchanged() public {
        vm.prank(alice);
        bridge.bridgeOut(100 * U);
        assertEq(bridge.orderNonce(), 1);
        vm.prank(alice);
        vm.expectRevert(WantosBridgeV2.WrongNativeFee.selector);
        bridge.bridgeOut{value: 1}(100 * U);
    }

    function test_quoteTiers() public {
        _set();
        assertEq(bridge.quoteNativeFee(10 * U), 2.5 ether);
        assertEq(bridge.quoteNativeFee(200 * U - 1), 2.5 ether);
        assertEq(bridge.quoteNativeFee(200 * U), 12 ether);
        assertEq(bridge.quoteNativeFee(1000 * U - 1), 12 ether);
        assertEq(bridge.quoteNativeFee(1000 * U), 50 ether);
        assertEq(bridge.quoteNativeFee(5000 * U - 1), 50 ether);
        assertEq(bridge.quoteNativeFee(5000 * U), 120 ether);
        assertEq(bridge.quoteNativeFee(type(uint128).max), 120 ether);
        assertEq(bridge.feeRecipient(), recipient);
    }

    function test_feeForwarded_contractHoldsNothing() public {
        _set();
        uint256 before = recipient.balance;
        vm.prank(alice);
        bridge.bridgeOut{value: 12 ether}(300 * U);
        assertEq(recipient.balance - before, 12 ether);
        assertEq(address(bridge).balance, 0);
        assertEq(bridge.orderNonce(), 1);
    }

    function test_wrongValueReverts() public {
        _set();
        vm.startPrank(alice);
        vm.expectRevert(WantosBridgeV2.WrongNativeFee.selector);
        bridge.bridgeOut(300 * U);
        vm.expectRevert(WantosBridgeV2.WrongNativeFee.selector);
        bridge.bridgeOut{value: 2.5 ether}(300 * U); // lower tier's fee
        vm.expectRevert(WantosBridgeV2.WrongNativeFee.selector);
        bridge.bridgeOut{value: 12 ether + 1}(300 * U);
        vm.stopPrank();
        assertEq(bridge.orderNonce(), 0);
    }

    function test_rejectingRecipientReverts() public {
        _viaTimelock(
            address(bridge),
            abi.encodeCall(WantosBridgeV2.setNativeFeeTiers, (_cfg(_fees(), address(new Rejector()))))
        );
        vm.prank(alice);
        vm.expectRevert(WantosBridgeV2.NativeFeeTransferFailed.selector);
        bridge.bridgeOut{value: 12 ether}(300 * U);
        assertEq(bridge.orderNonce(), 0);
    }

    function test_floorCapOrderingAndRecipient() public {
        _rejects(_cfg([uint256(1.2 ether - 1), 12 ether, 50 ether, 120 ether], recipient)); // below floor
        _rejects(_cfg([uint256(2.5 ether), 12 ether, 50 ether, 250 ether + 1], recipient)); // above cap
        _rejects(_cfg([uint256(0), 0, 0, 0], recipient)); // all zero: use the kill switch
        _rejects(_cfg([uint256(5 ether), 2.5 ether, 50 ether, 120 ether], recipient)); // decreasing
        _rejects(_cfg([uint256(2.5 ether), 12 ether, 50 ether, 40 ether], recipient)); // decreasing
        WantosBridgeV2.FeeStorage memory c = _cfg(_fees(), recipient);
        c.l2 = c.l1;
        _rejects(c); // limits not ascending
        _rejects(_cfg(_fees(), address(0)));
        // exactly the floor is fine
        _viaTimelock(
            address(bridge),
            abi.encodeCall(
                WantosBridgeV2.setNativeFeeTiers,
                (_cfg([uint256(1.2 ether), 1.2 ether, 50 ether, 120 ether], recipient))
            )
        );
        assertEq(bridge.quoteNativeFee(10 * U), 1.2 ether);
    }

    function test_killSwitch() public {
        _set();
        vm.expectEmit(true, true, false, false);
        emit WantosBridgeV2.NativeFeeConfigUpdated(recipient, admin);
        vm.prank(admin);
        bridge.disableNativeFee();
        assertEq(bridge.quoteNativeFee(6000 * U), 0);
        assertEq(bridge.feeRecipient(), recipient);
        vm.prank(alice);
        bridge.bridgeOut(100 * U);
        vm.prank(admin);
        vm.expectRevert();
        bridge.setNativeFeeTiers(_cfg(_fees(), recipient));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdmin.selector, alice));
        bridge.disableNativeFee();
    }

    function test_storageMatchesLayoutSnapshot() public {
        string memory j = vm.readFile("contracts/test/layout/NativeFee.namespace.json");
        uint256 base = vm.parseJsonUint(j, ".base");
        assertEq(
            bytes32(base),
            keccak256(abi.encode(uint256(keccak256("wantos.bridge.v2.NativeFee")) - 1)) & ~bytes32(uint256(0xff))
        );
        assertEq(vm.parseJsonKeys(j, ".fields").length, 8);
        _set();
        string[8] memory names = ["feeRecipient", "l0", "l1", "l2", "f0", "f1", "f2", "f3"];
        uint256[8] memory want = [
            uint256(uint160(recipient)), 200 * U, 1000 * U, 5000 * U, 2.5 ether, 12 ether, 50 ether, 120 ether
        ];
        for (uint256 i; i < 8; ++i) {
            uint256 slot = vm.parseJsonUint(j, string.concat(".fields.", names[i], ".slot"));
            assertEq(uint256(vm.load(address(bridge), bytes32(base + slot))), want[i], names[i]);
        }
    }
}
