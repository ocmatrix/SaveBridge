// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Plain 18-decimals ERC-20 with open mint (stands in for BSC-USDT / WANTOS-USDT).
contract MockToken is ERC20 {
    constructor() ERC20("Mock USDT", "USDT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Calls back into a target during transfer (re-entrancy probe).
contract ReentrantToken is ERC20 {
    address public target;
    bytes public payload;
    bool public lastOk;
    bytes public lastRet;

    constructor() ERC20("Re", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
        _approve(address(this), t, type(uint256).max); // so a nested pull would otherwise succeed
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (target != address(0)) {
            address t = target;
            target = address(0);
            (lastOk, lastRet) = t.call(payload);
        }
    }
}
