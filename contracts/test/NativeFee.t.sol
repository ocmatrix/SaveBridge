// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BscFixture} from "./utils/Fixtures.sol";
import {WantosFixture} from "./utils/WantosFixture.sol";
import {BridgeBase} from "../src/BridgeBase.sol";

contract Rejector {
    receive() external payable {
        revert("no");
    }
}

abstract contract Tiers {
    function _limits(uint256 u) internal pure returns (uint256[3] memory l) {
        l = [200 * u, 1000 * u, 5000 * u];
    }

    function _fees() internal pure returns (uint256[4] memory f) {
        f = [uint256(0.0002 ether), 0.001 ether, 0.004 ether, 0.01 ether];
    }

    function _cfg(uint256[3] memory l, uint256[4] memory f, address to)
        internal
        pure
        returns (BridgeBase.FeeStorage memory c)
    {
        c = BridgeBase.FeeStorage({
            feeRecipient: to,
            l0: l[0],
            l1: l[1],
            l2: l[2],
            f0: f[0],
            f1: f[1],
            f2: f[2],
            f3: f[3]
        });
    }
}

contract NativeFeeBscTest is BscFixture, Tiers {
    address recipient = address(0xADCDe89431978C79ef66956Cfed67ac925426957);

    function setUp() public {
        _deployBsc();
    }

    function _set(address to) internal {
        _viaTimelock(address(vault), abi.encodeCall(BridgeBase.setNativeFeeTiers, (_cfg(_limits(U), _fees(), to))));
    }

    function _dep(address from, uint256 amt, uint256 value) internal returns (uint256 nonce) {
        token.mint(from, amt);
        vm.deal(from, 1 ether);
        vm.startPrank(from);
        token.approve(address(vault), amt);
        nonce = vault.deposit{value: value}(amt, makeAddr("wantosRecipient"));
        vm.stopPrank();
    }

    function test_defaultOff_zeroValueWorks_valueRejected() public {
        assertEq(vault.quoteNativeFee(100 * U), 0);
        _dep(alice, 100 * U, 0);
        token.mint(bob, 100 * U);
        vm.deal(bob, 1 ether);
        vm.startPrank(bob);
        token.approve(address(vault), 100 * U);
        vm.expectRevert(BridgeBase.WrongNativeFee.selector);
        vault.deposit{value: 1}(100 * U, bob);
        vm.stopPrank();
    }

    function test_storageMatchesLayoutSnapshot() public {
        string memory j = vm.readFile("contracts/test/layout/NativeFee.namespace.json");
        uint256 base = vm.parseJsonUint(j, ".base");
        assertEq(
            bytes32(base),
            keccak256(abi.encode(uint256(keccak256("wantos.bridge.v2.NativeFee")) - 1)) & ~bytes32(uint256(0xff))
        );
        assertEq(vm.parseJsonKeys(j, ".fields").length, 8);
        _set(recipient);
        string[8] memory names = ["feeRecipient", "l0", "l1", "l2", "f0", "f1", "f2", "f3"];
        uint256[8] memory want = [
            uint256(uint160(recipient)),
            200 * U,
            1000 * U,
            5000 * U,
            0.0002 ether,
            0.001 ether,
            0.004 ether,
            0.01 ether
        ];
        for (uint256 i; i < 8; ++i) {
            uint256 slot = vm.parseJsonUint(j, string.concat(".fields.", names[i], ".slot"));
            assertEq(uint256(vm.load(address(vault), bytes32(base + slot))), want[i], names[i]);
        }
    }

    function test_quoteTiers() public {
        _set(recipient);
        assertEq(vault.quoteNativeFee(10 * U), 0.0002 ether);
        assertEq(vault.quoteNativeFee(200 * U - 1), 0.0002 ether);
        assertEq(vault.quoteNativeFee(200 * U), 0.001 ether);
        assertEq(vault.quoteNativeFee(1000 * U - 1), 0.001 ether);
        assertEq(vault.quoteNativeFee(1000 * U), 0.004 ether);
        assertEq(vault.quoteNativeFee(5000 * U - 1), 0.004 ether);
        assertEq(vault.quoteNativeFee(5000 * U), 0.01 ether);
        assertEq(vault.quoteNativeFee(type(uint128).max), 0.01 ether);
    }

    function test_feeForwardedToRecipient_contractHoldsNothing() public {
        _set(recipient);
        uint256 before = recipient.balance;
        _dep(alice, 300 * U, 0.001 ether);
        assertEq(recipient.balance - before, 0.001 ether);
        assertEq(address(vault).balance, 0);
        assertEq(vault.depositNonce(), 1);
    }

    function test_wrongValueReverts() public {
        _set(recipient);
        token.mint(alice, 300 * U);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        token.approve(address(vault), 300 * U);
        vm.expectRevert(BridgeBase.WrongNativeFee.selector);
        vault.deposit(300 * U, alice);
        vm.expectRevert(BridgeBase.WrongNativeFee.selector);
        vault.deposit{value: 0.0002 ether}(300 * U, alice); // lower tier's fee is not enough
        vm.expectRevert(BridgeBase.WrongNativeFee.selector);
        vault.deposit{value: 0.001 ether + 1}(300 * U, alice);
        vm.stopPrank();
        assertEq(vault.depositNonce(), 0);
    }

    function test_rejectingRecipientRevertsWholeDeposit() public {
        _set(address(new Rejector()));
        token.mint(alice, 300 * U);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        token.approve(address(vault), 300 * U);
        vm.expectRevert(BridgeBase.NativeFeeTransferFailed.selector);
        vault.deposit{value: 0.001 ether}(300 * U, alice);
        vm.stopPrank();
        assertEq(vault.depositNonce(), 0);
        assertEq(token.balanceOf(alice), 300 * U);
    }

    function test_capAndOrderingEnforced() public {
        uint256[4] memory f = _fees();
        f[3] = 0.01 ether + 1;
        bytes memory data = abi.encodeCall(BridgeBase.setNativeFeeTiers, (_cfg(_limits(U), f, recipient)));
        bytes32 salt = _propose(address(vault), data);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        _execute(address(vault), data, salt);

        uint256[3] memory l = _limits(U);
        l[2] = l[1];
        data = abi.encodeCall(BridgeBase.setNativeFeeTiers, (_cfg(l, _fees(), recipient)));
        salt = _propose(address(vault), data);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        _execute(address(vault), data, salt);

        data = abi.encodeCall(BridgeBase.setNativeFeeTiers, (_cfg(_limits(U), _fees(), address(0))));
        salt = _propose(address(vault), data);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        _execute(address(vault), data, salt);
        assertEq(vault.quoteNativeFee(300 * U), 0);
    }

    function test_configViewAndKillSwitchEvent() public {
        _set(recipient);
        assertEq(vault.feeRecipient(), recipient);
        vm.expectEmit(true, true, false, false);
        emit BridgeBase.NativeFeeConfigUpdated(recipient, admin);
        vm.prank(admin);
        vault.disableNativeFee();
        assertEq(vault.quoteNativeFee(6000 * U), 0);
        assertEq(vault.feeRecipient(), recipient);
    }

    function _rejects(uint256[4] memory f) internal {
        bytes memory data = abi.encodeCall(BridgeBase.setNativeFeeTiers, (_cfg(_limits(U), f, recipient)));
        bytes32 salt = _propose(address(vault), data);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        _execute(address(vault), data, salt);
        assertEq(vault.quoteNativeFee(10 * U), 0);
    }

    function test_lowestTierFloor() public {
        _rejects([uint256(0.0001 ether - 1), 0.001 ether, 0.004 ether, 0.01 ether]);
        _rejects([uint256(0), 0, 0, 0]); // timelock cannot set "all zero"; the admin kill switch does that
        // exactly the floor is allowed
        _viaTimelock(
            address(vault),
            abi.encodeCall(
                BridgeBase.setNativeFeeTiers,
                (_cfg(_limits(U), [uint256(0.0001 ether), 0.0001 ether, 0.004 ether, 0.01 ether], recipient))
            )
        );
        assertEq(vault.quoteNativeFee(10 * U), 0.0001 ether);
    }

    function test_tiersNeverDecrease() public {
        _rejects([uint256(0.0004 ether), 0.0002 ether, 0.004 ether, 0.01 ether]);
        _rejects([uint256(0.0002 ether), 0.001 ether, 0.004 ether, 0.003 ether]);
    }

    function test_adminKillSwitchOnly() public {
        _set(recipient);
        vm.prank(admin);
        vault.disableNativeFee();
        assertEq(vault.quoteNativeFee(6000 * U), 0);
        _dep(alice, 300 * U, 0);
        // admin cannot set tiers, strangers cannot kill
        vm.prank(admin);
        vm.expectRevert();
        vault.setNativeFeeTiers(_cfg(_limits(U), _fees(), recipient));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BridgeBase.NotAdmin.selector, alice));
        vault.disableNativeFee();
    }
}

contract NativeFeeWantosTest is WantosFixture, Tiers {
    address recipient = address(0xADCDe89431978C79ef66956Cfed67ac925426957);

    function setUp() public {
        _deployWantos();
        _fundUser(alice, 10_000 * U);
        vm.deal(alice, 200 ether);
        _applyBatch(bridge, _one(alice), true);
    }

    function _set() internal {
        uint256[4] memory f = [uint256(2.5 ether), 12 ether, 50 ether, 120 ether];
        _viaTimelock(address(bridge), abi.encodeCall(BridgeBase.setNativeFeeTiers, (_cfg(_limits(U), f, recipient))));
    }

    function test_bridgeOut_feeForwarded_byTier() public {
        _set();
        uint256 before = recipient.balance;
        vm.prank(alice);
        bridge.bridgeOut{value: 12 ether}(300 * U);
        assertEq(recipient.balance - before, 12 ether);
        assertEq(address(bridge).balance, 0);
        assertEq(bridge.orderNonce(), 1);
    }

    function test_wantosFloorIs1p2() public {
        uint256[4] memory f = [uint256(1.2 ether - 1), 12 ether, 50 ether, 120 ether];
        bytes memory data = abi.encodeCall(BridgeBase.setNativeFeeTiers, (_cfg(_limits(U), f, recipient)));
        bytes32 salt = _propose(address(bridge), data);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert();
        _execute(address(bridge), data, salt);
        assertEq(bridge.quoteNativeFee(10 * U), 0);
    }

    function test_bridgeOut_wrongValueReverts() public {
        _set();
        vm.prank(alice);
        vm.expectRevert(BridgeBase.WrongNativeFee.selector);
        bridge.bridgeOut(300 * U);
    }

    function test_bridgeOut_defaultOffUnchanged() public {
        vm.prank(alice);
        bridge.bridgeOut(100 * U);
        assertEq(bridge.orderNonce(), 1);
    }
}
