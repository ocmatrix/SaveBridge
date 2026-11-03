# PR-2 外部审计送审包：白名单跨链桥 v2

> 依据：`docs/DESIGN.md` v0.9.4（唯一权威；v0.9.5 只改链下风控 / 部署形态，合约与本送审范围不变）、`docs/PR1-NOTES.md`、`docs/PR0-FINDINGS.md`。分支 `pr-2-9-10-docs`。
> 范围：**只是规划与送审材料文档**。不部署、不发交易、不接触私钥。17 条决定未改。
> 审计方的选择、合同、付款均由负责人决定（`docs/TRAIN.md`：PR-2 状态 blocked，需用户选审计方）；本文不替负责人选择。

## 0. 使用方式

1. 合约冻结（负责人批准冻结点）后，把本文第 1～9 节连同冻结 commit 一并交给审计方。
2. 审计与 PR-3～PR-7 并行；PR-10 的硬门槛是「高危、中危全部修复」（DESIGN §13）。
3. 本文引用的事实均来自 `PR1-NOTES.md`；与合约源码不一致时，以源码和 DESIGN 为准，并回头修正本文。

## 1. 送审范围

### 1.1 范围内（in scope）

| 文件 | 行数 | 说明 |
|---|---|---|
| `contracts/src/BridgeBase.sol` | 682 | 两个桥共享：钥匙互斥、EIP-712 白名单批次、白名单钱包交接/恢复、暂停、UTC 日额度、放款状态机、`fund`/`withdraw`、UUPS 授权 |
| `contracts/src/BridgeTimelock.sol` | 310 | 继承 OZ v5 `TimelockController`，不可升级；48h、cancel 覆盖、管理钱包交接/恢复、epoch、执行后自检 |
| `contracts/src/BscVaultV2.sol` | 287 | BSC 金库：release/queue/execute、deposit、入账退款、`payLegacyBatch`、参数 |
| `contracts/src/WantosBridgeV2.sol` | 265 | WANTOS 桥：`bridgeOut`、订单、退款、B2W 入账、`supplyCeiling`、参数 |
| `contracts/src/interfaces/IBridgeV2.sol` | 20 | 时间锁 ↔ 桥的最小接口 |
| 合计（src） | 1,564 | |

部署与验收脚本（建议列入范围，因为它们决定部署出来的合约是否正确）：

| 文件 | 行数 |
|---|---|
| `contracts/script/PredictAddresses.s.sol` | 34 |
| `contracts/script/Deploy.s.sol` | 136 |
| `contracts/script/Verify.s.sol` | 110 |

### 1.2 范围外（out of scope，但需审计方知悉）

- OpenZeppelin Contracts / Contracts-Upgradeable **v5.1.0**（`lib/`，git 子模块，原样引用；请审计方核对子模块 commit 与上游 tag 一致）。
- `contracts/test/*`（测试代码，13 个套件，约 4,000 行；供审计方复现与参考，不要求审计）。
- 链下组件：付款程序（PR-3）、用户页（PR-5）、管理后台（PR-6）、监控（PR-7）；风控（PR-4）已于 v0.9.5 取消。它们是合约的使用者，**不在本轮合约审计范围**；如负责人另行委托，另列清单。
- WANTOS-USDT `0xc74F2e7fBdA2af9D1fc26b85E341229063Dc0873`（无源码；字节码层面结论见 `PR0-FINDINGS.md` ①）与 BSC-USDT。

### 1.3 冻结 commit

- **冻结 commit：待负责人批准冻结后填入**（见 §11 待用户确认）。
- 当前候选：`pr-1-contracts @ e8ad4fd`（DH 账本：gate2-passed(local)）。本分支基线 `1a2af08754d82c025529cda5288c43863f61b7ea` 的 `contracts/`、`foundry.toml`、`foundry.lock` 与 `e8ad4fd` 零差异（已用 `git diff --stat e8ad4fd HEAD -- contracts foundry.toml foundry.lock` 核对）。
- 冻结后：打 tag（建议 `audit-freeze-1`），冻结之后合约目录任何改动都视为「审计后修复」，走 §10 流程。
- 送审时必须同时给出：`foundry.toml`、`foundry.lock`、`remappings.txt`、子模块 commit 列表、PR1-NOTES §6 的三份 initcode keccak256。

## 2. 编译与测试复现步骤

环境：Foundry（forge）、solc **0.8.28**（`foundry.toml` 固定）、`evm_version = cancun`、optimizer **runs = 1**、`via_ir = false`。

```bash
git clone <仓库> && cd <仓库> && git checkout <冻结 commit>
git submodule update --init --recursive      # forge-std、OZ v5.1.0 两个库

forge build --sizes                          # 余量检查；SizeGateTest 另有 ≥900 B 的门槛
forge test                                   # 预期 240 通过 / 0 失败（13 套件；fuzz 512 轮；invariant runs=256 depth=64）
forge coverage --report summary --no-match-coverage "(test|script)/"   # 预期四个核心合约行/语句/分支/函数 100%
forge fmt --check

# 存储布局快照（每个桥必须为空，全部状态在 ERC-7201 命名空间）
for c in BridgeTimelock BscVaultV2 WantosBridgeV2; do
  diff <(forge inspect $c storageLayout --json) contracts/test/layout/$c.storageLayout.json
done
```

预期的构建数字（PR1-NOTES §6，runs = 1）：

| 合约 | 运行时 | 余量 | initcode keccak256 |
|---|---|---|---|
| BridgeTimelock | 11,635 B | 12,941 B | `0xa870375f…619b633` |
| BscVaultV2 | 22,483 B | 2,093 B | `0x537205b1…f92ba` |
| WantosBridgeV2 | 21,661 B | 2,915 B | `0x78c2abb1…2bb2033b` |

（完整哈希见 `PR1-NOTES.md` §6；复现不一致时先查 solc 版本、optimizer_runs、子模块 commit。）

**检查清单**
- [ ] 审计方在干净环境复现 `forge build/test/coverage` 与上表哈希一致
- [ ] 审计方独立复现 slither（§9）
- [ ] 审计方确认子模块 commit 与 OZ v5.1.0 上游一致

**运行时 codehash 说明**：实现合约含 UUPS `__self` immutable，时间锁含 `bridge` / `MIN_DELAY` immutable，所以运行时 codehash 取决于部署地址与构造参数，不能离线写死（PR1-NOTES §6）。`Verify.s.sol` 的 `IMPLEMENTATION_CODEHASH` 须用同一提交、同一编译设置，在预测的实现地址上重放部署（或 fork 演练）取得。

## 3. 系统概览（给审计方的 5 分钟版）

- 两条链各部署：`BridgeTimelock`（不可升级）+ 桥实现 + `ERC1967Proxy`（UUPS）。WANTOS 链为 `WantosBridgeV2`，BSC 为 `BscVaultV2`；全新部署者 EOA，CREATE nonce n / n+1 / n+2，三个地址在两条链上相同（DESIGN §5.1）。
- 白名单为空起步；添加/移除只能由白名单钱包的 EIP-712 签名批次完成，**任何人**可提交。
- 钥匙四类两两不同：管理钱包、白名单钱包（WL，必须 EOA）、付款钥匙（RELAYER）、暂停钥匙（PAUSER）。
- 放宽类（升级、提取、放宽参数、授予钥匙、换管理钱包、旧单补付、解冻、提高 supplyCeiling）一律经 48h 时间锁，管理钱包提议，管理钱包或 WL 可取消；收紧类管理钱包立即执行。
- 两种恢复对称：管理钱包恢复（WL 发起，14 天）、WL 恢复（管理钱包发起，7 天）；任一现任持有人可取消。
- 完整权力矩阵见 DESIGN §4.3；接口精确定义见 `PR1-NOTES.md` §5。

## 4. 威胁模型与信任假设

### 4.1 目标（DESIGN §0）

1. 原技术人员残留的任何旧私钥拿不走新桥的钱。
2. 原技术人员控制的地址不在白名单，无法直接跨出；转给白名单用户代跨不做来源判断，由白名单 + 每地址额度 + 暂停兜底（v0.9.5）。
3. 任何一把新钥匙单独泄露，资金不会被直接拿走，损失有链上上限。**前提是负责人在恢复窗口内（WL 恢复 7 天、管理钱包恢复 14 天）响应告警。**
4. 钥匙丢失可按期恢复；被盗且真主握有副本时可能僵持（桥受限、资金不被拿走），决定 15 接受此结果。

### 4.2 对手与能力

| 对手 / 事件 | 能做什么（合约层） | 链上上限 | 预期防线 |
|---|---|---|---|
| 付款钥匙泄露（BSC） | 只能付给白名单地址；当日全局 ≤ `dailyCap`，单地址 ≤ `perAddrDailyCap`（跨 UTC 零点最坏 2 倍） | 约 `dailyCap`（初值 5,000） | 监控逐笔核对源链事件，不符暂停；管理钱包吊销 |
| 付款钥匙泄露（WANTOS） | B2W 入账一律排队 `b2wDelay`（15 分钟），当日 ≤ `b2wDailyCap` | 正常情况下零损失（排队期内监控暂停） | 同上 |
| 暂停钥匙泄露 | 只能暂停 | 无资金损失 | 任一钱包解除；吊销 |
| 管理钱包被盗 | 收紧类立即；放宽/升级/提取要 48h；可发起 WL 恢复 | 资金不被拿走（WL 可取消） | WL 逐条取消；**7 天内响应恢复告警** |
| WL 被盗 | 往白名单加地址（仍受额度）；取消提议；暂停/解除；发起交接给自己；作废未来 orderId | 受额度约束 | 管理钱包冻结、移除、否决交接、启动 WL 恢复 |
| 两个钱包同时被盗 | 全部权力 | **整个储备** | 无法阻止；靠分设备分地点保管 |
| 验证者（WANTOS 单验证者链 S1） | 理论上可伪造 `BridgeOut` 事件、回滚链 | 见 §4.3 | 监控回滚检测暂停；PR-0 ② 待负责人回复 |
| 管理后台被篡改 | 诱导签错批次 | 不签就无损失 | 离线核对 `listHash` 与 message hash |
| 增发 WANTOS-USDT（`0xc081`） | 增发后无法直接跨出（不在白名单）；超 `supplyCeiling` 后 `bridgeOut` 被拒 | 小额不影响业务 | 只告警；负责人经时间锁提高上限 |

### 4.3 信任假设（请审计方显式评估）

1. **验证者**：WANTOS 为单验证者链，合约无法验证 `BridgeOut` 在共识层面真实存在；控制验证者者可伪造事件诱使 BSC 放款。合约层只能靠「白名单 + 额度 + 监控」封顶。验证者密钥保管情况是 PR-0 ② 的待办（负责人未回复）。
2. **付款钥匙**：合约无法验证源链事件真实存在（DESIGN §5.2）。被攻破时只能付给白名单地址并受额度约束。KMS 只防钥匙被拷走，真正的防线是链上白名单与额度。
3. **暂停钥匙**：热钥匙，只能暂停；合约层无取消权。
4. **两个管理钱包**：管理钱包（负责人，之后可交接给多签）与 WL 必须是不同钱包、分设备分地点；WL 必须是 EOA（不做 ERC-1271）。
5. **跨链退款**：WANTOS 合约无法读取 BSC 状态；「BSC 已作废」由三道防线保证——管理钱包发起且 WL 24h 内可取消；监控在可执行前 2 小时核对 BSC 上 `eventKey` 为 `Voided`；付款程序在每次 BSC 放款前重读 WANTOS `orders[id].status == Locked`（DESIGN §5.3）。合约层只保证单向一致：**BSC 放款后不能再作废（Released 终态），Voided 后不能放款**。
6. **WANTOS 链**：主网 `f93d05c3` 基线 + flood mempool；WANTON 1345 为 stock v0.7.3，行为不同（PR0-FINDINGS ⑦）。`BLOBBASEFEE` 报错、`PREVRANDAO` 全 `ff`；合约不得依赖（已反汇编核对）。
7. **WANTOS-USDT**：owner 仅可增发/转让所有权，无销毁、冻结、暂停（字节码层面，PR0-FINDINGS ①）；`approve` 是否要求先清零未确认。
8. **时间戳**：所有 `block.timestamp` 比较均为小时/天级，秒级操纵无实质影响（PR1-NOTES §4）。
9. **BSC finalized 语义**：监控与付款程序只处理 finalized 区块；合约不依赖。

## 5. 十四条不变量与测试索引

完整对照表见 `docs/PR1-NOTES.md` §7（正例/反例测试名）。摘要如下，审计方应逐条判断「测试是否真能抓住违反」：

| # | 不变量（DESIGN §5.6） | 测试入口（文件） |
|---|---|---|
| 1 | 白名单为空时无法跨出、无法放款 | `Invariants.t.sol`（`test_inv01_*`）、`WantosInvariants.t.sol` |
| 2 | 同一 eventKey 只放款一次或作废一次，Voided 后不可放款 | `Invariants.t.sol`（`test_inv02_*`） |
| 3 | UTC 日额度（含排队、入账退款、退款执行）；跨零点 2 倍照实 | `Invariants.t.sol`（含 `testFuzz_inv03_*`）、`WantosInvariants.t.sol`、`test_cap_resetsAtUtcMidnight` |
| 4 | A 类只经时间锁；48h；14 天过期；暂停/恢复期间的限制；交接后旧地址 cancel 被拒 | `Invariants.t.sol`、`BridgeTimelock.t.sol` |
| 5 | 钥匙两两不同；提议人恰好一个；WL 只经交接/恢复；DEFAULT_ADMIN 仅时间锁 | `Invariants.t.sol`、`BscVaultV2.t.sol` |
| 6 | 升级后数据不变；存储布局 | `Invariants.t.sol`、`WantosInvariants.t.sol`、`StorageLayout.t.sol` |
| 7 | 暂停矩阵 | `Invariants.t.sol`、`BscVaultV2.t.sol` |
| 8 | 批次：当前 WL 签名、nonce、跨链/跨合约、24h、冻结/恢复不可加、严格递增 | `Invariants.t.sol`、`BscVaultV2.t.sol`（`test_wl_*`） |
| 9 | 交接/恢复全部规则；完成/取消后自动可写 | `Invariants.t.sol`、`BscVaultV2.t.sol` |
| 10 | `supplyCeiling` | `WantosInvariants.t.sol` |
| 11 | 退款只退原地址原金额；eventKey 由 orderId 推导 | `WantosInvariants.t.sol` |
| 12 | 收紧不破下限；夹带放宽整笔回滚 | `Invariants.t.sol`、`BscVaultV2.t.sol` |
| 13 | 重放 `queueRelease` 不重复扣额度 | `Invariants.t.sol` |
| 14 | 同一 `oldKey` 只付一次 | `Invariants.t.sol` |

补充测试：`EdgeCases.t.sol`、`TimelockSelfCheck.t.sol`（执行后自检，含「恰好坏一项」）、`DeployScripts.t.sol`（内存演练两链部署）、`SizeGate.t.sol`（字节码余量门槛）。

**跨链不变量**（「同一订单 BSC 放款与 WANTOS 退款最多一个」）**合约单链测试无法覆盖**，在 PR-9 端到端验证（`PR9-TESTNET-PLAN.md` §8）。请审计方在审计报告中单独评述该跨链性质依赖的三道防线是否足够。

**变异验证**（DH 控制器独立复跑，TRAIN.md）：PR-1 的 7 个变异全部被测试抓住；时间锁自检每个子条件做过「删掉该检查」的变异。

## 6. 已知限制与有意取舍

来自 DESIGN 与 PR1-NOTES §3.1 / §4.1 / §5.11a。审计方不必把下列各项当作新发现，但欢迎对取舍本身提出反对意见。

### 6.1 设计层面

1. 决定 15：钥匙被盗且双方互相取消时可能长期僵持，不设链上「最后手段」出口。
2. 决定 14：WANTOS-USDT 增发只告警，不自动暂停；`supplyCeiling` 兜底。
3. 额度跨 UTC 零点最坏为单日上限 2 倍，文档照实写明。
4. 单验证者链与付款钥匙的「源事件真实性」合约无法验证（§4.3）。
5. 合约不在链上检查白名单地址是否为合约（签名后可能变委托地址、两链代码状态不一致）；WANTOS 侧 `bridgeOut` 拒绝合约调用者（含 EIP-7702 委托地址，`msg.sender.code.length == 0`）。**BSC 侧 `release` 对合约地址不设限**，合约地址仅在管理后台提示。
6. `emergencyRemove` 不推进白名单批次 nonce；已签未提交的添加批次仍能把地址加回来，**处置顺序必须是先 `freezeWhitelist` 再移除**（PR1-NOTES §5.11a-1）。
7. 被盗的 WL 能 `voidSource` 尚未出现的 orderId（None→Voided），订单在 BSC 永久无法放款，只能在 WANTOS 走退款（资金不丢，需人工处理）。
8. 重复 `pause()` 回滚 `EnforcedPause`；监控把它当作成功。
9. 付款钥匙可提前把任意 nonce 的放款排进队列（受白名单与额度约束），规格接受，监控兜底。
10. `pendingAdmin`（已执行待接收）无单独取消函数，只能等 7 天过期、被覆盖，或由 WL 启动恢复作废（PR1-NOTES Q4）。

### 6.2 实现取舍（PR1-NOTES D1～D21 摘选，审计相关）

| # | 取舍 | 审计关注点 |
|---|---|---|
| D1 | 订单状态加 `None=0`，`Order` 多 `refundRequestedAt` | 下游「status == Locked」判断不会把不存在订单误判 |
| D3 | `queueRelease` 同 `(to, amount)` 重放 → 成功空操作；payload 不同 → `BadPayoutStatus` | 不变量 13 的边界 |
| D4 | 恢复期间白名单批次添加与移除都拒绝（取更严读法）；`emergencyRemove` 仍可用 | DESIGN §4.4 与 §4.5 措辞差异 |
| D5 | 「同一时刻只允许一个恢复」跨两种恢复实现 | 双方能否互相锁死 |
| D6 | 恢复期间多项钥匙变化被拒；管理钱包恢复不作废待接收的 WL 交接 | 状态交叉 |
| D7 | 时间锁取消权通过覆盖 `_checkRole` 实现；`CANCELLER_ROLE` 仍授给管理钱包 | OZ 内部不变量是否被破坏 |
| D8 | 时间锁所有角色构造后冻结（含经时间锁自提议的 grant/revoke） | 是否过严导致不可运维 |
| D9/D10 | 交接 7 天从 48h 结束后起算；两种恢复无过期时间 | 恢复悬而不决的风险 |
| D11 | 签名「24h」按提交时 `deadline ≤ now + 24h` | 合约不知签名时间 |
| D12 | `initialize` 强制 `peerBridge == address(this)`、`timelock.bridge() == address(this)` | 地址一致性的链上断言 |
| D13/D14 | 收紧方向定义；参数范围按 `10**decimals()`（initialize 读取一次） | 两链精度不同的行为 |
| D16 | 批量函数任一项不合格整批回滚 | 活性（大批量被单项阻塞） |
| D17 | `executeRelease` 只限付款钥匙 | 与 §4.3 F 的差异 |
| D18 | `executeDepositRefund` 只计全局 `dailyCap`，不计每地址额度 | 额度口径 |
| D20 | WANTOS 侧也有 `voidSource`/`cancelRelease`/`voidSourceBatch` | 入账退款前提 |
| D21 | 下限/上限/额度按实际到账 `received` 检查 | fee-on-transfer 代币行为 |

### 6.3 待决（影响审计范围，见 §11）

- Q1 单批 500 上限待硬件钱包显示能力（PR-0 ④）；改它需要升级。
- Q2 `oldKey` 编码未定稿（合约只去重，不计算）；PR-8 定稿后公布。
- Q3 恢复期间是否应允许 WL 的移除批次（D4）。
- Q5 存储布局：已提交快照并由测试核对；未使用 `openzeppelin-foundry-upgrades`，建议审计时交叉核对 `validateUpgrade`。
- Q7 两条链的 fork 部署演练（PR-0 ⑧）未做。

## 7. 重点审计问题清单

按风险排序。每项给出入口与建议动作；审计方应对每项给出「通过 / 发现 / 无法判断」。

### 7.1 升级与时间锁（最高优先）

- [ ] `upgradeToAndCall` 是否只能经时间锁执行；`_authorizeUpgrade` 的恢复期间限制、暂停期间可升级是否与 §4.3 A 一致。
- [ ] 时间锁 `cancel` 经 `_checkRole` 覆盖：是否存在绕过（例如 OZ `cancel`/`schedule` 的其他路径、`executeBatch`、`updateDelay`、`grantRole` 路径）。
- [ ] `schedule` 的 delay 下限、`updateDelay` 区间 [48h, 7d]、`isOperationExpired` 与 `execute` 的 14 天过期；过期 id 不能复用需换 salt 的后果。
- [ ] 提议人恰好一个：构造期与迁移标志（`address(this).code.length == 0` 判断构造期）是否可被构造阶段之外利用。
- [ ] epoch：管理钱包恢复完成时 `+1`，旧提议执行回滚；正常交接不 `+1`——是否有旧提议在正常交接后被不该有的人执行。
- [ ] **执行后自检 `_checkBridgeSane`**：坏升级是否一定整笔回滚；视图本身回滚时冒出原始数据（可能为空）的行为；「语义上错误但看起来合理」的新实现（例如 `isKeyHolder` 恒真）超出自检能力——请评估是否值得追加检查。
- [ ] UUPS：实现合约 `_disableInitializers()`；新实现是否必须 UUPS（`test_inv06_neg_nonUupsImplementationRejected`）；ERC-7201 命名空间与升级追加字段的安全性（`StorageLayout.t.sol`）。
- [ ] `transferAdmin`/`acceptAdmin`：`pendingAdmin` 7 天窗口、互斥检查、多签作为新地址。

### 7.2 恢复与自动冻结

- [ ] 两种恢复的状态机：启动前置条件、`冷却 3 天`、对称取消、一次只允许一个（D5）、完成后自动可写、手动冻结独立。
- [ ] 恢复进行期间：白名单批次拒绝（添加+移除，D4）、时间锁 `execute` 一律 `RecoveryInProgress`、交接 `begin/accept` 拒绝（D6）。
- [ ] 能否通过「互相取消」造成永久不可恢复以外的更坏结果（例如锁死 `unpause`、锁死 `emergencyRemove`）。
- [ ] 钥匙真丢失（无人取消）时恢复能否按期完成；恢复无过期时间（D10）是否可被利用。

### 7.3 eventKey 与重放

- [ ] `eventKey = keccak256(abi.encode("WANTOS-BSC-BRIDGE-V2", srcChainId, srcBridge, srcEventNonce))`：域分隔、两链地址相同（`peerBridge == address(this)`）是否带来跨方向碰撞（W2B 与 B2W 的 key 能否相同、`peerChainId` 取值）。
- [ ] `queueRelease` 重放语义（D3）；`release` 与 `queueRelease` 状态互斥；Voided 终态。
- [ ] EIP-712 白名单批次：domain 含 name（两链不同）/ version / chainId / verifyingContract；nonce 严格等于当前值并 +1；`invalidateWhitelistNonce`；ECDSA 可塑性（OZ `recover` 拒绝高 s）。
- [ ] `listHash` 重算与严格递增、零地址拒绝、单批上限 500。
- [ ] 存款 `nonce` 与 `orderId` 从 1 起，递增溢出/冲突。

### 7.4 额度

- [ ] UTC 日历 `block.timestamp / 1 days`；`Voided` 退还额度的「扣额度那天」判断（D15，slither 误报已说明）；`release` 也记录 `queuedAt`。
- [ ] 额度在 `release/queueRelease` 时扣，入账退款/退款执行也计入；`uint128` 截断前受额度约束的论证（PR1-NOTES §4 整数）。
- [ ] `setParams`：收紧立即（一笔内任一项放宽整笔回滚）、放宽走时间锁；参数间约束；范围按 `decimals`。
- [ ] 跨零点 2 倍上限是否会被组合利用（例如排队跨日执行）。

### 7.5 退款与 voidSource 互斥

- [ ] `voidSource`/`cancelRelease`/`voidSourceBatch` 与 `release`/`executeRelease` 的互斥（同 key 至多一个终态）。
- [ ] WANTOS 退款：`requestRefund`（含暂停期间可申请）→ 24h → `executeRefund`（暂停不可）；只退原地址原金额；计入 `b2wDailyCap`；`cancelRefund` 回到 Locked；批量版。
- [ ] 入账退款（BSC）：`requestDepositRefund` → 24h → `executeDepositRefund`；D18。
- [ ] 「被盗 WL 作废未来 orderId」的后果面（§6.1-7）。
- [ ] **跨链一致性**（合约无法读对端）：请就「BSC 放款后 WANTOS 退款」的双花窗口，评估三道防线之外是否需要额外合约层约束。

### 7.6 旧单补付（仅 BSC）

- [ ] `payLegacyBatch`：仅时间锁、非暂停、无恢复；1–100 条；任一 `oldKey` 已付整批回滚；收款地址不要求白名单；不占日额度；储备口径。
- [ ] `oldKey` 由调用者提供，合约只去重——请评估「提议内容错误（但 WL 未发现）」的最坏后果（等同 `withdraw`）。

### 7.7 supplyCeiling

- [ ] `bridgeOut` 的 `totalSupply ≤ supplyCeiling` 检查点（先检查还是按到账后）；`setSupplyCeiling` 管理钱包只能降（立即）、时间锁可提高、任何情况 `c ≥ totalSupply`。
- [ ] 增发导致 `bridgeOut` 停摆（活性）与「不暂停」的取舍。

### 7.8 其他通用项

- [ ] 重入：所有转入转出函数 `nonReentrant` 且先写状态再转账（`ReentrancyTest`）；ERC-777/回调代币假设（USDT 为普通 ERC-20）。
- [ ] 余额差额记账（`fund`、`deposit`、`bridgeOut`）与 fee-on-transfer / 重基代币假设。
- [ ] 角色系统：`DEFAULT_ADMIN_ROLE` 只给时间锁；`grantRole/revokeRole/renounceRole` 对 WL 无效；`revokeKey`；付款/暂停钥匙可自行放弃。
- [ ] 暂停矩阵（DESIGN §4.3 C）逐函数核对：暂停期间应可用/不可用的函数清单。
- [ ] 部署脚本：`PredictAddresses` 的 CREATE 地址公式、`Deploy` 对 nonce 0 与预测地址无代码的断言、`Verify` 的检查项是否覆盖全部角色/参数/白名单为空。
- [ ] Gas / DoS：批量函数上限、`emergencyRemove` 数量、事件体积。

## 8. 对审计方的材料清单（交付物）

- [ ] 本文
- [ ] `docs/DESIGN.md`（v0.9.4）、`docs/PR1-NOTES.md`（含接口清单 §5、事件 §5.10、错误 §5.11）、`docs/PR0-FINDINGS.md`
- [ ] 冻结 commit（含子模块 commit 列表）与 tag
- [ ] 测试运行日志（`forge test`、`forge coverage`、`forge build --sizes`）
- [ ] slither 报告原文（§9）
- [ ] 部署参数草案（初值见 DESIGN §5.5，**仍待负责人确认**）
- [ ] 联系人：开发联系人（待填）、负责人（决策人）

## 9. 静态分析与 slither 结果引用位置

- 结果与处理表：`docs/PR1-NOTES.md` §4.0（slither 0.11.6，Python 3.14.7）。
- 命令：`slither . --foundry-out-directory out --filter-paths "lib/|contracts/test/|contracts/script/"`（slither 自行 `forge clean` + `forge build --build-info --skip test/script`）。
- 结论：处理后 **High 0 / Medium 0** / Low 13 / Informational 6。三条 Medium 已处理（1 条代码修复、2 条带 `slither-disable-next-line` 注释的误报）；Low 13 为误报或预期（`timestamp` ×11 等）。
- `forge lint`：block-timestamp、unsafe-typecast 两类警告均为预期（见 PR1-NOTES §4）。
- 字节码层检查：三份运行时字节码可执行区无 `BLOBBASEFEE` / `PREVRANDAO` / `SELFDESTRUCT` / `CALLCODE` / `TLOAD` / `TSTORE`；唯一 `DELEGATECALL` 来自 UUPS 升级。
- **要求**：审计方须自行重跑 slither 并把输出附进审计报告；送审前由开发方在冻结 commit 上再跑一次存档（存档位置：待定，建议随送审包提交，见 §11）。

## 10. 审计后修复流程与重跑要求

1. **分级**：审计方按高危 / 中危 / 低危 / 信息分级。PR-10 门槛：**高危、中危全部修复**；低危与信息逐项给出「修复 / 接受并说明」。
2. **修复提交**：每个发现一个小提交，提交信息引用发现编号；不得夹带无关改动。冻结 tag 之后的合约改动必须有对应审计发现编号。
3. **规格影响判断**：若修复改变 DESIGN 已拍板的 17 条决定或权力矩阵，**暂停修复，上报负责人**，不得自行取舍。
4. **回归**（每次修复后）：`forge build --sizes`（余量 ≥ 900 B）、`forge test`（全绿，测试数不得减少）、`forge coverage`（核心合约 100%）、存储布局快照 diff（布局有变必须解释）、slither 重跑（High/Medium 为 0）、必要时变异验证（新增的检查须配有「删掉即变红」的测试）。
5. **审计方复核**：修复提交交审计方确认关闭每个发现，出具终版报告。
6. **重新冻结**：修复后更新冻结 commit 与 initcode 哈希表，打新 tag（如 `audit-freeze-2`）。
7. **下游重跑**：合约 ABI 或行为有变 → 重新生成 `@bridge/abi`（`scripts/gen-abi.sh`）；PR-3/PR-5/PR-7 的相关测试重跑；**PR-9 全部重跑**（DESIGN §13：「修复后 PR-9 重跑」）；`Verify.s.sol` 的期望哈希重新取值。
8. **主网部署只用最终冻结 commit**；部署前再次核对 initcode 哈希与审计终版报告引用的版本一致。

## 11. 待用户确认

1. **审计方选择、预算、排期**（TRAIN.md：PR-2 blocked，需用户选审计方）。
2. **冻结点**：是否以 `e8ad4fd`（及等价的本分支基线）冻结，何时冻结；PR-1 合并「#N」须用户亲口说「合并 #N」。
3. **仓库访问方式**：GitHub 令牌已失效（TRAIN.md 授权边界 4），远端仓库名待确认；送审是给仓库访问权、还是打包归档？
4. **范围**：是否把部署/验收脚本与链下组件（付款程序 PR-3、监控 PR-7）一并列入审计；默认仅合约 + 脚本。
5. **PR-0 未决项对审计结论的影响**：②验证者信任假设、④硬件钱包 EIP-712 显示（决定单批 500 上限，改它需要升级，应在冻结前定稿）、⑥WANTOS 同 nonce 替换、⑧fork 部署演练。建议至少 ④ 在冻结前出结论。
6. **参数初值**（DESIGN §14-4）：额度等是否按 §5.5 初值；审计方需要具体值做经济分析。
7. **`oldKey` 编码**（PR1-NOTES Q2）：是否采用建议的 `keccak256(abi.encode(bytes32 txHash, uint256 logIndex))`；影响补付清单与审计对 `payLegacyBatch` 的评述。
8. **Q3 / Q4**：恢复期间是否允许 WL 移除批次；是否需要 `pendingAdmin` 单独取消函数——任一改动都属冻结前的规格变更，需负责人决定。
9. **slither 存档位置**与终版审计报告是否公开发布。
10. **审计期间的沟通联系人**（负责人 / 开发方）。
