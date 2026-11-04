# SaveBridge 跨链手续费升级：App 前端（Flutter）改动文档

> 给 App 前端开发用，照着做即可。依据：合约分支 `native-fee-20261103`（`contracts/src/BscVaultV2.sol`、`contracts/src/WantosBridgeV2.sol`）和规范 `docs/SPEC-NATIVE-FEE-v1.md`。
> 状态：合约和测试已定稿，**尚未部署**。合约地址、ABI 以部署后为准，本文不写地址。
> 配套背景：原有接口见《SaveBridge前端接口文档.md》，本文只写「手续费升级带来的变化」，没写的都不用改。

## 1. 一句话

用户发起跨链的那一笔交易，要**额外附带一笔原生币**作为手续费：BSC 入金附带 BNB，WANTOS 出金附带 WANT。合约收到后立即转给收款地址。USDT 本金不变，订单、事件、后端接口都不变。

## 2. 要改什么（只有 3 件事）

| # | 改动 | 涉及的合约函数 |
|---|---|---|
| 1 | 发交易前先**报价**，把手续费作为交易的 `value` 带上 | `bridgeOut`、`deposit` |
| 2 | 转账确认页**展示手续费**，余额检查把手续费算进去 | — |
| 3 | 新增两个**错误**的中文提示 | `WrongNativeFee`、`NativeFeeTransferFailed` |

不用改：`approve`、白名单查询、订单查询、`Deposited`/`BridgeOut` 事件解析、relayer 后端接口、USDT 合约调用。

## 3. 接口变化

### 3.1 `bridgeOut` 变成 payable（WANTOS → BSC）

| 项 | 旧 | 新 |
|---|---|---|
| 函数 | `bridgeOut(uint256 amount)` | `bridgeOut(uint256 amount)`，**stateMutability 改为 `payable`** |
| 选择器 | `0xda98d9f5` | 不变（参数没变） |
| 交易 `value` | 不带（0） | **必须恰好等于** `quoteNativeFee(amount)`，单位 WANT 的最小单位（wei，18 位） |

新增只读函数，在 **WANTOS 侧**合约上调用：

```
quoteNativeFee(uint256 amount) view returns (uint256 fee)     选择器 0xec449aa4
feeRecipient() view returns (address)                          选择器 0x46904840
```

- `amount` 与 `bridgeOut(amount)` 用**同一个数**（USDT 的链上最小单位）。
- 返回值是应付的 WANT（wei）；手续费未启用时返回 **0**，此时 `value` 填 0，代码不用另写分支。
- 档位（上线值，仅供展示参考，**实际以 `quoteNativeFee` 返回为准，不要在 App 里写死**）：

| 存入金额（USDT） | 手续费 |
|---|---|
| < 200 | 2.5 WANT |
| 200 – 1000 | 12 WANT |
| 1000 – 5000 | 50 WANT |
| ≥ 5000 | 120 WANT |

- **`value` 必须精确等于报价**，多了少了都会回滚（`WrongNativeFee`）。这一侧不会退回多付的部分。

### 3.2 `deposit` 变成 payable（BSC → WANTOS）

| 项 | 旧 | 新 |
|---|---|---|
| 函数 | `deposit(uint256 amount, address wantosRecipient)` | 同，**stateMutability 改为 `payable`** |
| 选择器 | `0x6e553f65` | 不变 |
| 交易 `value` | 不带（0） | **不小于** `quoteNativeFee(gasPrice)`，单位 BNB 的最小单位（wei） |

新增只读函数，在 **BSC 侧**合约上调用：

```
quoteNativeFee(uint256 gasPrice) view returns (uint256 fee)    选择器 0xec449aa4
nativeFeeConfig() view returns (address recipient, uint256 multiplier)   选择器 0x425ec67d
```

- 参数是**这笔交易将使用的 gas 价**（wei），不是金额。手续费与存入金额无关。
- 公式：`fee = clamp(gasPrice × 200000 × multiplier, 0.0005 BNB, 0.002 BNB)`；`multiplier = 0`（未启用）时 `fee = 0`。上线 `multiplier = 50`，BSC 现价 0.05 gwei 时 fee = **0.0005 BNB**。
- 合约用的是 `tx.gasprice`，所以**报价用的 gas 价必须和交易实际使用的 gas 价一致**：
  - 请用 **legacy 交易**，并**显式设置 `gasPrice`**（BSC 支持）。先取 `eth_gasPrice`，用这个值报价，也用这个值发交易。
  - 不要让钱包库自动换成 EIP-1559（`maxFeePerGas`）：实际 gas 价会变成 baseFee + 小费，和报价对不上。
- **`value` 多附约 20% 余量**：`value = quote × 1.2`。多付的部分合约会**当场退回给发起人**，不会损失。少了则回滚（`WrongNativeFee`）。

### 3.3 其他新增只读接口（可选，用于核对）

| 合约 | 函数 | 用途 |
|---|---|---|
| BSC | `nativeFeeConfig()` | 返回收款地址和倍数，倍数为 0 表示手续费关闭 |
| WANTOS | `feeRecipient()` | 返回收款地址 |

App 不必调用它们；做「手续费收款地址展示」或自检时才需要。

### 3.4 新增事件（App 不用处理）

| 事件 | 合约 | 说明 |
|---|---|---|
| `NativeFeeCollected(payer indexed, recipient indexed, fee)` | 两侧 | 每次收费发出，监控程序用 |
| `NativeFeeConfigUpdated(...)` | 两侧 | 配置变更，监控程序用 |

`Deposited` 和 `BridgeOut` 的字段**没变**，订单历史的解析不用改。

## 4. 交易流程（改后）

**WANTOS → BSC（`bridgeOut`）**
1. 原有预检不变（暂停、白名单、额度等）。
2. 读 `quoteNativeFee(amount)` → 得 `fee`。
3. 余额检查：WANT 余额 ≥ `fee` + 本笔交易的 gas 费。
4. `approve`（如需）。
5. 发 `bridgeOut(amount)`，`value = fee`（精确）。

**BSC → WANTOS（`deposit`）**
1. 原有预检不变。
2. 取 `gasPrice = eth_gasPrice`；读 `quoteNativeFee(gasPrice)` → 得 `fee`。
3. 余额检查：BNB 余额 ≥ `fee × 1.2` + 本笔 gas 费（approve + deposit 各一笔）。
4. `approve`（如需）。
5. 发 `deposit(amount, recipient)`，`value = fee × 1.2`，**`gasPrice` 显式设为第 2 步那个值**。

估 gas：`eth_estimateGas` 必须**带上 `value`**，否则估算会因 `WrongNativeFee` 失败。

## 5. 错误处理

| 合约自定义错误 | 选择器 | 含义 | 建议提示（中文） |
|---|---|---|---|
| `WrongNativeFee()` | `0x308fb487` | 手续费金额不对：WANTOS 侧必须恰好等于；BSC 侧不能少于 | 手续费已变化，请刷新后重试 |
| `NativeFeeTransferFailed()` | `0xb6db9972` | 手续费转给收款地址失败，或多付部分退回失败 | 手续费转账失败，请稍后重试；如反复出现请联系客服 |

处理要点：
- 遇到 `WrongNativeFee`：重新报价再发一次，不要自动重复发送多次。
- BSC 侧最常见原因：报价用的 gas 价和交易实际 gas 价不一致，或手续费刚被调整。
- 其他已有错误（暂停、不在白名单、额度）沿用原来的处理。

## 6. 界面文案（建议）

转账确认页在金额下方加一行：

- WANTOS → BSC：`跨链手续费：{fee} WANT`
- BSC → WANTOS：`跨链手续费：约 {fee} BNB`（说明：多付部分会退回）

余额不足时给明确提示：「余额不足以支付跨链手续费」，不要只提示 gas 不够。

手续费为 0（未启用）时，这一行**不显示**。

## 7. 上线顺序与兼容

1. **手续费启用前，合约默认不收费**：`quoteNativeFee` 返回 0，旧 App 不带 `value` 也能正常转账；新 App 带 `value=0` 同样正常。
2. **所以 App 新版必须赶在手续费启用之前发布**，并确保绝大多数用户已升级。启用后，旧版 App 不带 `value` 的交易会全部回滚。
3. 启用靠链上配置：BSC 写倍数（上线 50），WANTOS 写档位，都要走 **48 小时时间锁**；管理钱包可以**立即关闭**手续费（关闭后报价为 0）。上线前会提前通知 App 团队具体生效时间。
4. 每次发交易前都要**重新读报价**，不要缓存：配置变更后报价立刻变。

## 8. 自测清单

| 场景 | 预期 |
|---|---|
| 手续费未启用，`bridgeOut` / `deposit` 带 `value=0` | 成功 |
| WANTOS 侧，`value` 等于报价 | 成功，收款地址到账 |
| WANTOS 侧，`value` 多 1 wei 或少 1 wei | 回滚 `WrongNativeFee` |
| BSC 侧，`value = 报价 × 1.2` | 成功，多付的部分退回到发起人 |
| BSC 侧，`value` 小于报价 | 回滚 `WrongNativeFee` |
| BSC 侧，使用 EIP-1559 交易 | 可能与报价不符，应避免 |
| 余额只够本金、不够手续费 | 界面提示余额不足，不发交易 |
| 订单历史、状态跟踪 | 与升级前一致 |

## 9. 待确认

1. **合约地址和 ABI**：部署后给 App 团队新的 ABI（`packages/abi` 重新生成）；如果是新桥重新部署，地址也会变。
2. **WANT / BNB 价格变动**：WANTOS 档位是固定 WANT 数，价格大变时由时间锁调整；App 一律读链上报价，不要写死。
3. **钱包库**：本文按通用 EVM 钱包库描述，没有针对具体的 Flutter 库（如 web3dart、walletconnect）写代码，需要开发人员按所用库设置 `value` 和 `gasPrice`。
