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
- **`value` 要多附，不能只附刚好等于报价的数（失败率最低的规则）。** 合约要求 `value ≥ fee`，多付的部分**当场退回给发起人**，不会损失。如果钱包没按我们给的 `gasPrice` 发，实际 gas 价更高，费用就会比报价高，只附报价的钱就不够（回滚 `WrongNativeFee`）。所以：
  1. 读合约常量 `MAX_FEE()`（BSC 侧，选择器 `0xbc063e1a`，上线值 0.002 BNB）：无论钱包用什么 gas 价，费用都不会超过它。
  2. 先算一个 gas 预留：`reserve = gasPrice × 600,000 × 2`。
  3. `value = min(MAX_FEE, 余额 − reserve)`；如果这个数小于报价 `fee`，就取 `fee`（再由余额检查提示不足）。
  4. **例外：发起人地址本身有合约代码**（智能合约钱包，或 EIP-7702 授权过的地址，`eth_getCode` 不是 `0x`）：这类地址可能收不了退款，会让整笔回滚，所以 `value` 取**恰好等于 `fee`**。
  - 效果：余额充足的普通用户，`value` 就是 0.002 BNB，退回约 0.0015 BNB（同一笔交易内退回）；余额紧的用户尽量多附；只有余额连手续费都不够时才被拦下，并给出明确提示。

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
3. 余额检查：BNB 余额 ≥ `fee` + 本笔 gas 费（approve + deposit 各一笔）。
4. `approve`（如需）。
5. `approve` 完成后**重新取 gas 价并重新报价**，按 §3.2 的规则算 `value`，发 `deposit(amount, recipient)`，**`gasPrice` 显式设为这次报价用的值**。

估 gas：`eth_estimateGas` 必须**带上 `value`**，否则估算会因 `WrongNativeFee` 失败。

**模拟调用要显式给 `gas`（BSC 入金，复审补充）：** 做 `eth_call` 模拟或预检时，如果同时设置了 `gasPrice`，请**同时指定 `gas`（建议 1,000,000）**。部分 BSC 节点（如 `rpc-bsc.48.club`、`bsc-dataseed1.bnbchain.org`）在没给 `gas` 时会按它们的 gas 上限（数千万）乘以价格去检查余额，余额不多的用户会被误报「余额不足」，实测加上 `gas` 后正常。这个 `gas` 只用于模拟，**发给钱包的交易里不要带它**，让钱包自己估算。网页版已按此实现，可参考 `apps/bridge-web/src/lib/flows.ts` 的 `sendGuarded`。

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

## 7. 上线顺序与兼容（一步打包方案，2026-11-04 定）

合约升级和手续费配置会放进**同一个批量提案**，经过 48 小时时间锁后**一次性执行**：执行的那一刻，合约升级并且手续费立刻生效。具体流程见 `NATIVE-FEE-UPGRADE-RUNBOOK.md`。

对 App 的要求：

1. **App 新版必须在批量提案执行之前上架，并覆盖绝大多数用户。** 执行后，不带 `value` 的老调用会回滚（`WrongNativeFee`），**老版 App 将无法跨链转账**。覆盖率标准由负责人定，开发团队需要告知预计上架时间。
2. **新版 App 必须兼容旧合约（升级之前的合约）。** 新版 App 会在合约升级之前就上架，那时线上合约还没有 `quoteNativeFee`，调用它会**回滚**。处理规则：
   - 调用 `quoteNativeFee` **被合约回滚**（execution reverted，无返回数据）→ 按「**手续费 0**」处理：`value` 不带，BSC 方向也不设置 `gasPrice`，界面不显示手续费行。
   - **网络错误、超时、RPC 报错不算回滚**：不能当成「没有手续费」，要提示用户稍后重试。用户页（网页）已经按这个规则实现并测过，可作参考：`apps/bridge-web/src/lib/fee.ts` 里的 `quoteOrZero`。
3. 升级执行之后，同一套代码无需改动：报价返回非 0 时自动带上手续费。
4. 每次发交易前都要**重新读报价**，不要缓存：配置变更后报价立刻变。
5. 管理钱包可以**立即关闭手续费**（报价回到 0），App 这边不用做任何事，下一次报价读到 0 即可。
6. 执行的具体时间会提前通知 App 团队。

## 8. 自测清单

| 场景 | 预期 |
|---|---|
| 手续费未启用，`bridgeOut` / `deposit` 带 `value=0` | 成功 |
| WANTOS 侧，`value` 等于报价 | 成功，收款地址到账 |
| WANTOS 侧，`value` 多 1 wei 或少 1 wei | 回滚 `WrongNativeFee` |
| BSC 侧，普通钱包、余额充足，`value = MAX_FEE` | 成功，多付的部分退回到发起人 |
| BSC 侧，钱包把 gas 价改成报价的 2 倍以上 | 仍然成功（`value` 够用），退回的部分变少 |
| BSC 侧，余额只比手续费多一点 | `value` 取 `fee` 或余额减 gas 预留，不会因 `value` 为 0 而失败；不够时给出明确提示 |
| BSC 侧，发起人地址有合约代码 | `value` 恰好等于 `fee`，不依赖退款 |
| BSC 侧，`value` 小于报价 | 回滚 `WrongNativeFee` |
| BSC 侧，使用 EIP-1559 交易 | 可能与报价不符，应避免 |
| 余额只够本金、不够手续费 | 界面提示余额不足，不发交易 |
| 合约还是旧版（`quoteNativeFee` 回滚） | 按无手续费处理，转账照常成功，界面没有手续费行 |
| RPC 超时或网络错误 | 提示重试，不发交易，不当作无手续费 |
| 订单历史、状态跟踪 | 与升级前一致 |

## 9. 待确认

1. **合约地址和 ABI**：部署后给 App 团队新的 ABI（`packages/abi` 重新生成）；如果是新桥重新部署，地址也会变。
2. **WANT / BNB 价格变动**：WANTOS 档位是固定 WANT 数，价格大变时由时间锁调整；App 一律读链上报价，不要写死。
3. **钱包库**：本文按通用 EVM 钱包库描述，没有针对具体的 Flutter 库（如 web3dart、walletconnect）写代码，需要开发人员按所用库设置 `value` 和 `gasPrice`。
