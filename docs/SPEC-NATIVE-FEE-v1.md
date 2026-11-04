# 规范：跨链原生币手续费 v1（定稿）

> 定稿日期：2026-11-04　状态：**已定稿，未部署**。本文是该功能的唯一规范；实现说明与测试清单见 `PR-NATIVE-FEE-20261103.md`。
> 本文不授权任何链上动作；部署、写入参数均需负责人在对话里明确授权。
> 代码：分支 `native-fee-20261103`（`contracts/src/BscVaultV2.sol`、`contracts/src/WantosBridgeV2.sol`；`BridgeBase.sol` 不变）。

## 1. 目的与范围

平台承担目的链放行 gas，用户只付源链 gas。本功能让用户在**入口交易里额外付一笔原生币**（BSC 付 BNB、WANTOS 付 WANT），由合约立即转给收款地址，把跨链成本转给用户。

- 不动 USDT 本金；不改对账口径（`Deposited`、`BridgeOut` 事件不变）。
- 只对两个用户入口收费：BSC `deposit`、WANTOS `bridgeOut`。放行、退款、白名单、暂停等流程不收费。
- 未配置时默认不收费（升级或新部署后，需时间锁写入参数才开始收）。

## 2. 规则

### 2.1 BSC 方向（用户跨进来，欢迎方向）

**两部分各管各的：** ①用户照常付给网络的**真实 gas**（合约不参与）；②**附加手续费**：由前端按「预估 gas 的高端 × 倍数」算出一个金额，作为 `value` 附带，合约只检查它在 [MIN_FEE, MAX_FEE] 内，然后**全额**转给收款地址。合约**不读 `tx.gasprice`**，所以钱包怎么定价 gas，都不会让附加费「不够」而回滚。

```
前端：fee = quoteNativeFee( 节点当前 gas 价 )
      = clamp( gasPrice × FEE_GAS × multiplier , MIN_FEE , MAX_FEE )     （multiplier = 0 时为 0）
合约：multiplier ≠ 0：要求 MIN_FEE ≤ msg.value ≤ MAX_FEE，全额转给 feeRecipient
      multiplier = 0：任何 msg.value 原路退回，手续费为 0
```

| 参数 | 值 | 位置 | 修改方式 |
|---|---|---|---|
| `FEE_GAS` | 200,000（一次 approve + deposit 的 gas，用于报价公式） | 代码常量 | 升级 |
| `MIN_FEE` | **0.0005 BNB**（= 现价下 50 倍 gas；**合约强制的最低收费**） | 代码常量 | 升级 |
| `MAX_FEE` | 0.002 BNB（现价费用的 4 倍；防止前端出错多付） | 代码常量 | 升级 |
| `MAX_MULTIPLIER` | 100 | 代码常量 | 升级 |
| `multiplier` | **上线值 50**（供前端报价用，也是「开/关」） | 链上参数 | 仅时间锁（48h）；管理钱包可立即置 0 |
| `feeRecipient` | 负责人离线钱包 `0xADCDe89431978C79ef66956Cfed67ac925426957` | 链上参数 | 仅时间锁（48h） |

- 现价（BSC gas 0.05 gwei）：0.05 gwei × 200,000 × 50 = **0.0005 BNB**（约 0.3 美元，BNB 按 600 美元估算）。
- **强制的是最低值，倍数是前端的责任：** 合约保证每笔至少收 `MIN_FEE`、至多 `MAX_FEE`；诚实的前端会按 gas 价的高端 × 50 报价，gas 价上涨时多收一些。绕过我们前端直接调合约的人，只需要付 `MIN_FEE`。负责人 2026-11-04 确认：不必严格 50 倍，大概收到即可。
- 收费口径允许有误差：附加费大致是用户自付 gas 的 50 倍（现价下恰好是下限）。

付款：

1. 金额不在 [MIN_FEE, MAX_FEE]（含没附带）→ 整笔回滚（`WrongNativeFee`）。
2. 手续费全额转给 `feeRecipient`；转账失败 → 整笔回滚（`NativeFeeTransferFailed`）。
3. **没有退款**（费用关闭时除外：此时附带的任何 `value` 原路退回，所以刚好在关闭瞬间发出的交易仍然成功）。因此智能合约钱包也能正常入金。
4. 正常流程下合约不留 BNB（强行转入如 selfdestruct 可能留下零头，无害，也无提取函数；不要把「合约余额恒为 0」当链上不变量）。

### 2.2 WANTOS 方向（出金）

按存入金额分 4 档，固定值，**`msg.value` 必须恰好等于该档费用**（否则 `WrongNativeFee`）。

| 档 | 存入金额（USDT） | 上线值 | 约合美元（WANT 0.5 美元） |
|---|---|---|---|
| 0 | < 200 | 2.5 WANT | 1.2 |
| 1 | 200 – 1000 | 12 WANT | 6 |
| 2 | 1000 – 5000 | 50 WANT | 24 |
| 3 | ≥ 5000 | 120 WANT | 60 |

- 档位按**实际到账额** `received` 计。档位边界：`amount < l0` → 档 0，`< l1` → 档 1，`< l2` → 档 2，否则档 3。
- 代码硬边界：最低档 `f0 ≥ 1.2 WANT`；每档 ≤ 250 WANT；`f0 ≤ f1 ≤ f2 ≤ f3`；`l0 < l1 < l2`；收款地址非零。
- 费用转给 `feeRecipient`，转账失败整笔回滚；合约不留任何 WANT。
- 拆单不省钱：档内费用随金额增长较慢，拆成多笔每笔都要交费。

## 3. 接口

### 3.1 `BscVaultV2`

| 函数 | 权限 | 说明 |
|---|---|---|
| `deposit(uint256 amount, address wantosRecipient) payable` | 任何人 | 原有入口，现为 `payable` |
| `quoteNativeFee(uint256 gasPrice) view → uint256` | 任何人 | 按给定 gas 价（wei）报价，公式见 §2.1；前端传节点当前 gas 价（若库能给出预估区间则取高端），附带恰好这个数 |
| `MIN_FEE()`、`MAX_FEE()` view | 任何人 | 合约强制的最低、最高手续费（常量） |
| `nativeFeeConfig() view → (address recipient, uint256 multiplier)` | 任何人 | 核对收款地址与倍数 |
| `setNativeFeeConfig(address recipient, uint256 multiplier)` | 仅时间锁；非暂停；A 类 | `multiplier ≤ 100`（否则 `ParamOutOfRange(0)`）；`multiplier ≠ 0` 时收款地址非零（`ZeroAddress`） |
| `disableNativeFee()` | 仅管理钱包 | `multiplier = 0`，立即生效；收款地址保留 |

事件：`NativeFeeCollected(payer, recipient, fee)`、`NativeFeeConfigUpdated(recipient, multiplier, by)`。
存储：命名空间 `wantos.bridge.v2.BscNativeFee`（slot `0xda0cb208263a332850054218d87c370a3978ccc2c5835848c161d1a30a2e7c00`），字段 `feeRecipient`（slot 0）、`multiplier`（slot 1）。

### 3.2 `WantosBridgeV2`

| 函数 | 权限 | 说明 |
|---|---|---|
| `bridgeOut(uint256 amount) payable` | 白名单 EOA | 原有入口，现为 `payable` |
| `quoteNativeFee(uint256 amount) view → uint256` | 任何人 | 按存入金额报价 |
| `nativeFeeTiers() view → FeeStorage` | 任何人 | 一次返回收款地址、三个金额分界和四档费用（监控与管理页核对用） |
| `feeRecipient() view → address` | 任何人 | 核对收款地址 |
| `nativeFeeTiers() view → FeeStorage` | 任何人 | 一次返回收款地址、三个金额分界和四档费用（监控与管理页核对用；2026-11-04 复审后新增） |
| `setNativeFeeTiers(FeeStorage n)` | 仅时间锁；非暂停；A 类 | `n = (feeRecipient, l0, l1, l2, f0, f1, f2, f3)`；越界 `ParamOutOfRange(0/1)`，顺序错 `ParamConstraint`，零地址 `ZeroAddress` |
| `disableNativeFee()` | 仅管理钱包 | 四档清零，立即生效 |

事件：`NativeFeeCollected`、`NativeFeeConfigUpdated(recipient, by)`。
存储：命名空间 `wantos.bridge.v2.NativeFee`（slot `0x996f0b223ec5eab56d57394bbc730586711d10f12e551944355aff15072b3a00`），字段 `feeRecipient`、`l0`、`l1`、`l2`、`f0`–`f3`（slot 0–7）。

> 时间锁不能把档位全设为 0；要关闭用 `disableNativeFee()`。重新开启需再走时间锁。

## 4. 安全与回退

| 项 | 做法 |
|---|---|
| 重入 | 转账发生在状态写入与事件之后；入口均 `nonReentrant` |
| 失败隔离 | 收款方拒收、无法收退款 → 整笔回滚，不会出现"收了费但没存入" |
| 极端值 | 代码硬边界（§2）；改边界要升级合约 |
| 总开关 | 管理钱包 `disableNativeFee()`，一笔交易、立即生效，不过时间锁 |
| 回退 | 关闭后合约行为与未加本功能一致；收款地址写错 → 先关闭，再经时间锁改 |
| 收款地址风险 | 收款地址必须是能收原生币的 EOA 或多签；合约地址拒收会让所有存入失败，此时用总开关止损 |
| 存储兼容 | 新命名空间，旧数据不动；未配置全 0 即不收费 |
| 字节余量 | BscVaultV2 余量 1,028 B（运行时 23,548 B）、WantosBridgeV2 余量 1,539 B（23,037 B，含 `nativeFeeTiers()`）；2026-11-04 BSC 改为前端报价后重新测得；`SizeGateTest` 门槛 900 B（原 1,500 B） |

## 5. 前端集成

- **BSC**：取节点当前 gas 价 `p`；`fee = quoteNativeFee(p)`；`deposit` 附 `msg.value = fee`（恰好这个数，合约不退款）；界面显示"将收取约 `fee` BNB"。**不需要**自己设置 gas 价或 gas 上限，交给钱包。授权完成后、发送前重新报价一次。
- **WANTOS**：`fee = quoteNativeFee(amount)`；`bridgeOut` 附 `msg.value = fee`（必须恰好）。
- 用户余额需覆盖"手续费 + 自身 gas"；不足时提前提示。
- 手续费与退回的说明文案：手续费不可退；被拒绝或退款的订单，已收手续费不退。

## 6. 监控（watcher）

- 订阅 `NativeFeeCollected`，累计收入；对账 `Deposited`/`BridgeOut` 笔数与该事件笔数一致（已启用收费后）。
- 订阅 `NativeFeeConfigUpdated`；任何变更（尤其 `disableNativeFee`）立即告警。
- 定时读取 `nativeFeeConfig()`/`feeRecipient()`，核对仍是批准的收款地址。
- 合约余额（BNB、WANT）正常应为 0；非零只作提示（可能是被强行转入的零头），不当作不变量告警。

## 7. 上线步骤与验收

1. 并入重新部署（`REDEPLOY-PLAN-20261103.md`）：合并 `native-fee-20261103` 与 `redeploy-20261103`，重算哈希、预测地址、`vectors.json`；若桥已上线则改走 48h UUPS 升级并重新审计。
2. 部署演练（WANTON 或副本）：确认 WANTOS 链合约大小上限、收费、退款、总开关。
3. 时间锁（48h）写入：BSC `setNativeFeeConfig(0xADCD…6957, 50)`；WANTOS `setNativeFeeTiers`（§2.2 上线值）。
4. 上线前核对两项（独立审查提示）：① WANTOS-USDT 没有转账扣费（档位按到账额计，扣费币会让报价与实际档位错位而回滚）——**已核对（2026-11-04，只读）**：在 rpc.wantos.io 的本地分叉里用最大持币地址模拟 `transfer`（1、123.456…、1000 USDT）与 `transferFrom`（500 USDT），收款方增量与发送方减量都精确等于转账额，总供给不变；该代币非代理合约（4,507 字节，仅 ERC20 + `owner` + `mint`，无手续费相关函数）；
   ② WANTOS 最低档 `f0`（1.2 WANT 起）远小于 `w2bMinAmount`（否则最小单的手续费超过本金；上线值 2.5 WANT ≈ 1.25 美元 < 10 USDT）。
5. 验收：各档各发一笔测试交易，核对收款地址到账、合约余额为 0、事件齐全、关闭再开启生效。

每步链上写入都需要负责人在对话里明确授权，授权不外推。

## 8. 测试验收（已满足）

`forge test` 292 项通过；`BridgeBase`、`BscVaultV2`、`WantosBridgeV2` 覆盖率 100%；存储布局快照（`layout/BscNativeFee.namespace.json`、`layout/NativeFee.namespace.json`）已核对；改坏验证：忽略 gas 价、去掉不足检查、去掉退款、去掉上限夹取、去掉最低档下限、去掉档位不降检查、改错档位边界、去掉转账，相应用例均变红。

## 9. 刻意不做的

| 不做 | 少了什么 | 缓解 | 何时再做 |
|---|---|---|---|
| 价格预言机 / 自动调价 | BNB、WANT 价格大变时 WANTOS 档位偏离 | 档位是时间锁参数；BSC 已随 gas 价自动浮动 | 每周需调多次时 |
| BSC 按存入金额收费 | 大额与小额付同样的费 | 欢迎入金的策略取向 | 策略变化时 |
| 失败/退款订单退手续费 | 被拒订单的手续费不退 | 界面写明；此类订单极少 | 出现投诉时 |
| 手续费自动换成 gas 币 | 币种需人工平衡 | 手续费进离线钱包，油箱由负责人补 | 一个方向长期失衡时 |
| 链上返回整张档位表的接口 | 档位只能经 `quoteNativeFee` 和事件核对 | 多占字节，余量不够 | 余量变大或拆分合约后 |
| 按实际消耗 gas 计费 | 用 20 万 gas 的固定估计 | 单笔交易 gas 用量基本固定，浮动的是 gas 价 | 用量明显变化时（改常量需升级） |
