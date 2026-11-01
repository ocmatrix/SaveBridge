// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BscVaultV2} from "../../src/BscVaultV2.sol";
import {WantosBridgeV2} from "../../src/WantosBridgeV2.sol";

/// @dev "Next version" implementations: same namespaced storage, one new view.
contract BscVaultV2Next is BscVaultV2 {
    function version() external pure returns (string memory) {
        return "v2.1";
    }
}

contract WantosBridgeV2Next is WantosBridgeV2 {
    function version() external pure returns (string memory) {
        return "v2.1";
    }
}

/// @dev Not UUPS-compatible (no proxiableUUID): upgrade must be rejected.
contract NotUups {
    function hello() external pure returns (uint256) {
        return 1;
    }
}

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @dev A1: implementation that dropped every IBridgeForTimelock view (still UUPS so the upgrade itself succeeds).
contract DroppedViewsImpl is UUPSUpgradeable {
    function _authorizeUpgrade(address) internal override {}
}

/// @dev A1: implementation whose views look plausible but report a recovery forever.
contract StuckRecoveryImpl is UUPSUpgradeable {
    address immutable tl;
    address immutable wlm;

    constructor(address timelock_, address wl_) {
        tl = timelock_;
        wlm = wl_;
    }

    function _authorizeUpgrade(address) internal override {}

    function timelock() external view returns (address) {
        return tl;
    }

    function whitelistManager() external view returns (address) {
        return wlm;
    }

    function paused() external pure returns (bool) {
        return false;
    }

    function whitelistRecoveryActive() external pure returns (bool) {
        return true;
    }

    function isKeyHolder(address a) external view returns (bool) {
        return a == wlm;
    }
}

/// @dev A1: implementation that lost its storage namespace (reads zero for timelock / whitelist manager).
contract LostNamespaceImpl is UUPSUpgradeable {
    function _authorizeUpgrade(address) internal override {}

    function timelock() external pure returns (address) {
        return address(0);
    }

    function whitelistManager() external pure returns (address) {
        return address(0);
    }

    function paused() external pure returns (bool) {
        return false;
    }

    function whitelistRecoveryActive() external pure returns (bool) {
        return false;
    }

    function isKeyHolder(address) external pure returns (bool) {
        return false;
    }
}

/// @dev B5: next version that APPENDS a field at the end of the BscVaultV2 namespace struct
///      (the only allowed kind of layout change).
contract BscVaultV2Appended is BscVaultV2 {
    struct VaultStorageNext {
        Params params;
        uint256 depositNonce;
        mapping(uint256 nonce => Deposit) deposits;
        mapping(bytes32 oldKey => bool) legacyPaid;
        uint256 appendedField; // new
    }

    bytes32 private constant VAULT_STORAGE_NEXT = 0x3bd3aa2096e9f4b3aa0d653c2fcdf8cde24fb7f30fa893e85a7f630b4e747000;

    function _vn() private pure returns (VaultStorageNext storage $) {
        assembly {
            $.slot := VAULT_STORAGE_NEXT
        }
    }

    function appendedField() external view returns (uint256) {
        return _vn().appendedField;
    }

    function setAppendedField(uint256 v) external {
        _vn().appendedField = v;
    }
}
