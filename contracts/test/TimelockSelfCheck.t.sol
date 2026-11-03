// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BscFixture} from "./utils/Fixtures.sol";
import {W} from "./utils/Windows.sol";
import {BridgeTimelock} from "../src/BridgeTimelock.sol";
import {
    BscVaultV2Next,
    DroppedViewsImpl,
    StuckRecoveryImpl,
    LostNamespaceImpl,
    OneBrokenViewImpl
} from "./mocks/UpgradeMocks.sol";

/// A1: a bad upgrade must not be able to brick the timelock. The timelock re-checks the bridge after every
/// execution; an upgrade that breaks the views it depends on reverts as a whole.
contract TimelockSelfCheckTest is BscFixture {
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function setUp() public {
        _deployBsc();
    }

    function _impl() internal view returns (address) {
        return address(uint160(uint256(vm.load(address(vault), IMPL_SLOT))));
    }

    function _upgradeMustRevert(address newImpl) internal {
        bytes memory data = abi.encodeCall(vault.upgradeToAndCall, (newImpl, ""));
        bytes32 salt = _propose(address(vault), data);
        vm.warp(block.timestamp + W.TL_MIN_DELAY);
        vm.expectRevert();
        _execute(address(vault), data, salt);
        assertEq(_impl(), address(impl)); // upgrade rolled back
    }

    function test_upgradeToImplWithoutViewsReverts() public {
        _upgradeMustRevert(address(new DroppedViewsImpl()));
    }

    function test_upgradeToImplStuckInRecoveryReverts() public {
        StuckRecoveryImpl bad = new StuckRecoveryImpl(address(tl), wl);
        bytes memory data = abi.encodeCall(vault.upgradeToAndCall, (address(bad), ""));
        bytes32 salt = _propose(address(vault), data);
        vm.warp(block.timestamp + W.TL_MIN_DELAY);
        vm.expectRevert(BridgeTimelock.BridgeCheckFailed.selector);
        _execute(address(vault), data, salt);
        assertEq(_impl(), address(impl));
    }

    function test_upgradeToImplThatLostNamespaceReverts() public {
        LostNamespaceImpl bad = new LostNamespaceImpl();
        bytes memory data = abi.encodeCall(vault.upgradeToAndCall, (address(bad), ""));
        bytes32 salt = _propose(address(vault), data);
        vm.warp(block.timestamp + W.TL_MIN_DELAY);
        vm.expectRevert(BridgeTimelock.BridgeCheckFailed.selector);
        _execute(address(vault), data, salt);
    }

    function test_upgradeViaBatchAlsoChecked() public {
        address[] memory t = new address[](1);
        t[0] = address(vault);
        uint256[] memory v = new uint256[](1);
        bytes[] memory p = new bytes[](1);
        p[0] = abi.encodeCall(vault.upgradeToAndCall, (address(new DroppedViewsImpl()), ""));
        vm.prank(admin);
        tl.scheduleBatch(t, v, p, bytes32(0), "b", W.TL_MIN_DELAY);
        vm.warp(block.timestamp + W.TL_MIN_DELAY);
        vm.expectRevert();
        tl.executeBatch(t, v, p, bytes32(0), "b");
        assertEq(_impl(), address(impl));
    }

    function _upgradeWithOneBroken(uint256 mode, bytes memory expectedRevert) internal {
        OneBrokenViewImpl bad = new OneBrokenViewImpl(address(tl), wl, mode);
        bytes memory data = abi.encodeCall(vault.upgradeToAndCall, (address(bad), ""));
        bytes32 salt = _propose(address(vault), data);
        vm.warp(block.timestamp + W.TL_MIN_DELAY);
        vm.expectRevert(expectedRevert);
        _execute(address(vault), data, salt);
        assertEq(_impl(), address(impl));
    }

    /// A-1, real vault, exactly one view broken per case.
    function test_upgradeOneBroken_timelockView() public {
        _upgradeWithOneBroken(1, abi.encodeWithSelector(BridgeTimelock.BridgeCheckFailed.selector));
    }

    function test_upgradeOneBroken_zeroWhitelistManager() public {
        _upgradeWithOneBroken(2, abi.encodeWithSelector(BridgeTimelock.BridgeCheckFailed.selector));
    }

    function test_upgradeOneBroken_whitelistManagerNotKeyHolder() public {
        _upgradeWithOneBroken(3, abi.encodeWithSelector(BridgeTimelock.BridgeCheckFailed.selector));
    }

    function test_upgradeOneBroken_pausedReverts() public {
        // raw revert data of the view bubbles up
        _upgradeWithOneBroken(4, abi.encodeWithSelector(OneBrokenViewImpl.PausedProbeBroken.selector));
    }

    function test_goodUpgradeStillPasses() public {
        BscVaultV2Next next = new BscVaultV2Next();
        _viaTimelock(address(vault), abi.encodeCall(vault.upgradeToAndCall, (address(next), "")));
        assertEq(_impl(), address(next));
        // and governance keeps working afterwards
        _viaTimelock(address(vault), abi.encodeCall(vault.upgradeToAndCall, (address(impl), "")));
        assertEq(_impl(), address(impl));
    }
}
