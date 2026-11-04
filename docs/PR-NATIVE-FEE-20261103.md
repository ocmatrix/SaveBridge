# PR：跨链原生币手续费（BSC 随 gas 浮动、WANTOS 阶梯，转给收款地址）

> 状态：**代码与测试完成，未部署，不授权任何链上动作。** 分支 `native-fee-20261103`。

## 1. 目标

平台目前承担目的链放行 gas，用户只付源链 gas。要把用户的跨链成本抬高：用户存入时额外付一笔 BNB（BSC 方向）或 WANT（WANTOS 方向），收到后立刻转给收款地址（负责人离线钱包 `0xADCDe89431978C79ef66956Cfed67ac925426957`）。不动 USDT 本金，不改对账口径。

## 2. 设计

| | BSC 方向（跨进来，欢迎方向） | WANTOS 方向（出金） |
|---|---|---|
| 入口 | `BscVaultV2.deposit`（`payable`） | `WantosBridgeV2.bridgeOut`（`payable`） |
| 费用 | **前端按「节点当前 gas 价 × 20 万 × 倍数」算出一个金额附带**，与存入金额无关，合约强制其落在 [0.0005, 0.002] BNB（`MIN_FEE`/`MAX_FEE`）。**合约不读 `tx.gasprice`**。上线建议 `multiplier` = **50**（11-04 负责人定：收用户 BSC 自付 gas 的 50 倍） | 按存入金额分 4 档固定值（见下表） |
| 浮动 | 随用户交易的 gas 价轻微浮动，像正常转账一样；BSC gas 价 0.05 gwei（现价）时 = 0.0005 BNB，约 0.3 美元 | 不浮动 |
| 付款 | `MIN_FEE ≤ msg.value ≤ MAX_FEE`，**全额**转给收款地址，不退款（费用关闭时附带的 `value` 原路退回） | `msg.value` 必须恰好等于该档费用 |
| 转账 | 状态写入之后转给 `feeRecipient`，合约不留余额；转账失败整笔回滚；`nonReentrant` | 同左 |
| 配置 | `setNativeFeeConfig(recipient, multiplier)`：仅时间锁（48h），`multiplier ≤ 100`，0 = 关 | `setNativeFeeTiers`：仅时间锁，最低档 ≥ 1.2 WANT、每档 ≤ 250 WANT、档位不降、限额升序 |
| 总开关 | `disableNativeFee()`：管理钱包立即把 `multiplier` 置 0 | 管理钱包立即把四档清零 |
| 报价 | `quoteNativeFee(gasPrice)`；`nativeFeeConfig()` | `quoteNativeFee(amount)`；`feeRecipient()` |
| 存储 | 新命名空间 `wantos.bridge.v2.BscNativeFee`；快照 `layout/BscNativeFee.namespace.json` | 新命名空间 `wantos.bridge.v2.NativeFee`；快照 `layout/NativeFee.namespace.json` |
| 事件 | `NativeFeeCollected`、`NativeFeeConfigUpdated`（`Deposited` 不变） | 同左（`BridgeOut` 不变） |

两条路径的代码分别放在各自合约里，`BridgeBase` 不变（避免 BSC 合约背上用不到的阶梯代码）。未配置时两边默认不收费。

### 为什么 BSC 的手续费由前端算、合约只夹上下限（2026-11-04 改）

最初版本由合约按 `tx.gasprice` 重新计算，要求 `msg.value ≥ fee` 并退回多付部分。问题：前端无法知道钱包最终用什么 gas 价，钱包一旦改价，实际手续费高于附带的 `value`，交易就回滚；为了避免失败只能多附带再退款，钱包确认页上显示的金额偏高，智能合约钱包还可能收不了退款。

改为：**前端按节点当前 gas 价 × 倍数算出手续费，附带恰好这个数；合约只检查它在 [MIN_FEE, MAX_FEE] 内并全额转走**。真实 gas 照常付给网络，附加手续费是独立的一笔。效果：入金不会因手续费问题回滚、不需要退款、确认页显示真实金额。代价：合约只能强制最低值，不能强制「恰好 50 倍」；负责人确认允许误差（见规范 §2.1）。

### WANTOS 档位（WANT 按 0.5 美元估算）

| 存入金额（USDT） | 收 | 约合美元 |
|---|---|---|
| < 200 | 2.5 WANT | 1.2 |
| 200 – 1000 | 12 WANT | 6 |
| 1000 – 5000 | 50 WANT | 24 |
| ≥ 5000 | 120 WANT | 60 |

拆单不省钱：档内费用随金额增长较慢，拆成多笔每笔都要交费。

## 3. 字节余量

2026-11-04 BSC 改为「前端报价、合约夹上下限」后重新测得（`forge build --sizes`，运行时字节，硬上限 24,576）：

| 合约 | 运行时 | 余量 |
|---|---|---|
| BscVaultV2 | 23,548 | 1,028 |
| WantosBridgeV2 | 22,722 | 1,854 |

`SizeGateTest` 门槛 900 B（硬上限 24,576 不变）。

## 4. 测试

整套 `forge test` 292 项通过；`BridgeBase`、`BscVaultV2`、`WantosBridgeV2` 覆盖率 100%。`contracts/test/NativeFee.t.sol` 覆盖：BSC 的附带金额在 [MIN_FEE, MAX_FEE] 内全额转走且与 `tx.gasprice` 无关、区间外回滚、费用关闭时附带的 `value` 原路退回、收款方拒收回滚、智能合约钱包可入金、配置边界与权限、总开关；WANTOS 的档位边界、金额不符回滚、下限/上限/顺序/零地址校验、总开关；两个命名空间的存储布局核对。改坏验证：忽略 gas 价、去掉不足检查、去掉退款、去掉上限夹取，用例均变红（WANTOS 侧此前已验证）。

## 5. 部署方式

`REDEPLOY-PLAN-20261103.md` 正在重新部署新桥，**本改动应并入该重新部署（无需 UUPS 升级）**。并入后字节码与 codehash 会变，该文档 §4 的哈希与预测地址、`packages/offline-check/vectors.json` 都要重算。若桥已上线，则走 48h 时间锁的 UUPS 升级并重新审计。

上线时由时间锁（48h）写入收款地址与 `multiplier`（BSC）、档位（WANTOS）；写入前合约默认不收费。

## 6. 待办 / 待确认

- 前端：BSC 方向读取节点当前 gas 价，调 `quoteNativeFee(gasPrice)`，附带恰好这个数（合约不退款、不看 `tx.gasprice`）；WANTOS 方向调 `quoteNativeFee(amount)`。重新生成 `packages/abi`。
- slither 未跑；WANTOS 链的合约大小上限未实测（设计按 24,576），演练时验证。
- 上线价格：`multiplier` = 50。BSC gas 价长期贴近最低价 0.05 gwei，只有轻微波动，此时手续费 = 0.0005 BNB（约 0.3 美元，BNB 按 600 美元估算），随 gas 价小幅上下。

  代码上下限 [0.0005, 0.002] BNB：下限等于现价费用（gas 价为 0 也不能少付），上限是现价费用的 4 倍，只防 gas 价异常或用户乱设高 gas 价的极端情况，正常波动不会碰到。BNB 与 WANT 价格以真实行情为准。
- 任何链上写入需负责人明确授权。

## 7. 刻意不做的

| 不做 | 少了什么 | 缓解 | 何时再做 |
|---|---|---|---|
| 价格预言机 / 自动调价 | BNB、WANT 价格大变时 WANTOS 档位偏离 | 档位是时间锁参数；BSC 由前端按当前 gas 价报价，随 gas 价浮动 | 每周需调多次时 |
| BSC 按存入金额比例收费 | 大额存入与小额付同样的费 | 欢迎入金的策略取向，费用低 | 需要时 |
| 失败/退款订单退手续费 | 被拒订单的手续费不退 | 界面写明；此类订单极少 | 出现投诉时 |
| 手续费自动换成 gas 币 | 币种需人工平衡 | 手续费进离线钱包，油箱由负责人补 | 一个方向长期失衡时 |
