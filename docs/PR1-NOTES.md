# PR-1 合约：实现说明、偏差与待决、下游接口清单

> 依据：`docs/DESIGN.md` v0.9.3（唯一权威）、`docs/PR0-FINDINGS.md`。分支 `pr-1-contracts`。
> 范围：只写代码与本地测试。**未部署、未广播、未接触任何节点或真实私钥。**
> 工具链：solc 0.8.28，`evm_version = cancun`，optimizer **1 run**（B1，原 200），OpenZeppelin Contracts / Contracts-Upgradeable v5.1.0。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `contracts/src/BridgeTimelock.sol` | 继承 OZ v5 `TimelockController`，不可升级（§4.2 规格 1–8、§4.6） |
| `contracts/src/BridgeBase.sol` | 两个桥共享：钥匙互斥、EIP-712 白名单批次、白名单钱包交接/恢复、暂停、UTC 自然日额度、放款状态机、`fund`/`withdraw`、UUPS 授权 |
| `contracts/src/BscVaultV2.sol` | §5.2：release/queue/execute、deposit、入账退款、`payLegacyBatch`、参数 |
| `contracts/src/WantosBridgeV2.sol` | §5.3：bridgeOut、订单、退款、B2W 入账、`supplyCeiling`、参数 |
| `contracts/src/interfaces/IBridgeV2.sol` | 时间锁 ↔ 桥互相读取的最小接口 |
| `contracts/script/PredictAddresses.s.sol` | §5.1 nonce 表 n/n+1/n+2 的 CREATE 地址预测（纯计算） |
| `contracts/script/Deploy.s.sol` | §5.1 部署脚本，**只写好、未运行广播**；测试里在内存中演练两条链 |
| `contracts/script/Verify.s.sol` | §5.1 部署后验收（角色、时间锁成员与延迟、实现 codehash、参数、白名单为空、地址一致） |
| `contracts/test/*` | 203 个测试（含 2 个 fuzz，各 512 轮），见 §7 |

## 2. 实现说明（按规格条目）

### 2.1 BridgeTimelock（§4.2）
1. `MIN_DELAY = 48h`（immutable）。OZ 把 `_minDelay` 设为 private、`updateDelay` 为 external，无法 `super` 调用，所以延迟值存在本合约 `_delay` 并覆盖 `getMinDelay()`；`updateDelay` 只能由时间锁自身调用，新延迟必须在 `[MIN_DELAY, MAX_DELAY] = [48h, 7d]`（B2：防止填错超大延迟永久冻结治理）。
2. `admin = address(0)`。构造函数：提议人 = 管理钱包（同时持 `CANCELLER_ROLE`），执行人 = `address(0)`（任何人），桥地址 `bridge` 为 immutable。**构造期间不调用桥**（桥还没部署），互斥检查由桥的 `initialize` 做一次。
3. 提议人恰好一个：`_grantRole/_revokeRole` 在构造之后一律 `RoleChangeForbidden`（判断依据 `address(this).code.length == 0` 即构造期，或内部迁移标志），**包括经时间锁提议的 grantRole/revokeRole**；`renounceRole` 一律拒绝。换管理钱包时 `PROPOSER_ROLE` 与 `CANCELLER_ROLE` 一起迁移。
4. `cancel`：OZ 的 `cancel` 带 `onlyRole(CANCELLER_ROLE)` 且 `_timestamps` 为 private，无法重写函数体。最小改法：覆盖 `_checkRole(role, account)`，当 `role == CANCELLER_ROLE` 时只判断 `account == adminWallet()` 或 `account == IBridge(bridge).whitelistManager()`（运行时读取），否则 `NotCanceller(account)`；角色成员资格对取消不起作用。
5. `transferAdmin(newAdmin)`：仅时间锁自身；桥暂停时拒绝（A 类"暂停期间：否"）；新地址非零、非现任、非时间锁/桥地址、非桥上钥匙（`isKeyHolder`）→ `pendingAdmin`，7 天有效 → `acceptAdmin()`（再查一次互斥）。
6. 过期：`isOperationExpired(id)` = 已排期且 `block.timestamp > readyAt + 14 天`。`execute/executeBatch` 先检查过期 → `OperationExpired(id)`。OZ 枚举没有 Expired，`getOperationState` 对过期操作仍返回 Ready；该 id 仍处于"已登记"，同 salt 无法再次提议，**必须换 salt**。
7. `epoch`：每次 `schedule/scheduleBatch` 记录 `proposalEpoch[id] = epoch`（事件 `ProposalRecorded`）；执行时 `proposalEpoch[id] != epoch` → `OperationStaleEpoch`。管理钱包**恢复**完成时 `epoch += 1`（正常交接不加）。
8. `adminWallet()` 对外；桥合约的"管理钱包直接可调"函数全部运行时读取它。
9. 恢复：`startAdminRecovery(candidate)` 仅 `bridge.whitelistManager()`；14 天；现任管理钱包或白名单钱包可 `cancelAdminRecovery()`；取消后发起方（白名单钱包一侧）3 天冷却；启动即 `adminRecoveryActive = true`，并作废 `pendingAdmin`；完成走 `acceptAdmin()`。
10. 任一恢复（本合约的管理钱包恢复，或桥上的白名单钱包恢复）进行期间，`execute/executeBatch` 一律 `RecoveryInProgress`（"恢复期间不执行任何 A 类操作"）。取消（`cancel`）不受影响。

### 2.2 BridgeBase（两条链共享）
- 存储：ERC-7201 命名空间 `wantos.bridge.v2.BridgeBase`（slot `0x79137872…c3e000`），子合约各一个命名空间（见 §5.8）。OZ v5 upgradeable 组件本身也是命名空间存储。
- `initialize`：时间锁/代币/对端链 ID 非零；`timelock.bridge() == address(this)`；`peerBridge == address(this)`；四类钥匙（`timelock.adminWallet()`、白名单钱包、付款钥匙、暂停钥匙）非零且两两不同；`DEFAULT_ADMIN_ROLE` 只授给时间锁。
- 钥匙：`grantRole` 仅时间锁且无恢复（A 类，暂停期间可执行），只允许 `RELAYER_ROLE`/`PAUSER_ROLE`，目标不得是管理钱包、白名单钱包或已持有任一钥匙；`DEFAULT_ADMIN_ROLE` 不能授予、吊销、放弃。`revokeKey(role, account)` 管理钱包立即吊销（B 类）；时间锁 `revokeRole` 也可。付款/暂停钥匙可自行 `renounceRole`。
- 白名单批次：见 §5.4。
- 冻结：`freezeWhitelist()` 管理钱包立即；`unfreezeWhitelist()` 仅时间锁、非暂停、无恢复。`emergencyRemove(addrs)` 管理钱包立即，暂停/冻结/恢复期间都可用。
- 白名单钱包交接：`begin`（仅现任 WL，无恢复）→ 48h → `accept`（7 天窗口，无恢复，再查互斥）；`cancel` 现任 WL 或管理钱包（否决）。
- 白名单钱包恢复：`startWhitelistRecovery` 仅管理钱包，无任一恢复、过冷却；作废待接收交接；7 天后 `acceptWhitelistRecovery`；`cancelWhitelistRecovery` 现任 WL 或管理钱包，之后发起方（管理钱包一侧）冷却 3 天。完成或取消后白名单自动可写；手动冻结独立，仍须时间锁解冻。
- 暂停：`pause()` 暂停钥匙/管理钱包/白名单钱包；`unpause()` 管理钱包或白名单钱包（决定 17）。
- 额度：`currentDay() = block.timestamp / 1 days`（UTC 自然日）；`dailyUsed(day)` 全局、`addrDailyUsed(day, addr)` 每地址。
- 放款状态机（两条链共用）：`_recordPayout` 要求 None（同 payload 的 Queued 重放为空操作）；`_executePayout` 要求 Queued 且满延迟；`voidSource`（None/Queued→Voided）、`cancelRelease`（Queued→Voided）、`voidSourceBatch`；Voided 时若扣额度的那天就是今天则退还额度。
- `fund(amount)` 任何人（按余额差额，`Funded`）；`withdraw(to, amount)` 仅时间锁、非暂停、无恢复。
- 升级 `_authorizeUpgrade`：仅时间锁、无恢复；**暂停期间可升级**。

### 2.3 BscVaultV2（§5.2）
- `release`：付款钥匙、非暂停；`to` 在白名单；`0 < amount ≤ perAddrDailyCap` 且 `≤ largeThreshold`；状态 None → Released；扣全局 + 每地址日额度；先写状态再转账；`nonReentrant`。
- `queueRelease`：同上但不限 `largeThreshold`；None → Queued，扣额度；同 `(to, amount)` 重放 → 空操作（不扣额度、不发事件）。
- `executeRelease`：付款钥匙、非暂停；Queued、满 `releaseDelay`（读当前参数）、`to` 仍在白名单。
- `deposit(amount, wantosRecipient)`：非暂停；`wantosRecipient ≠ 0`；按余额差额 `received`，`minDeposit ≤ received ≤ maxDepositPerTx`；`nonce` 从 1 开始；`Deposited(nonce, from, wantosRecipient, received)`。
- 入账退款：`requestDepositRefund(nonce)` 管理钱包（None→Refunding，事件带 `eventKey = depositEventKey(nonce)`）；`cancelDepositRefund` 管理钱包或 WL（→None）；`executeDepositRefund` 任何人、非暂停、满 24h，退给原存款人原金额，**计入 `dailyCap`**（全局）。
- `payLegacyBatch(oldKeys, to, amounts)`：仅时间锁、非暂停、无恢复；1–100 条；任一 `oldKey` 已付则整批回滚；收款地址不要求白名单；不占日额度。
- `setParams`：见 §5.6。

### 2.4 WantosBridgeV2（§5.3）
- `bridgeOut(amount)`：非暂停；`whitelisted[msg.sender]`；`msg.sender.code.length == 0`（EIP-7702 委托地址同样拒绝）；`totalSupply ≤ supplyCeiling`；按余额差额；`received ≥ w2bMinAmount`；`received` 计入 `w2bPerAddrDailyCap`（也是单笔上限）；`orderId` 从 1 递增；收款地址固定 `msg.sender`。
- 退款：`requestRefund(orderId)` / `requestRefundBatch` 管理钱包（Locked→Refunding，可在暂停期间申请）；`cancelRefund` 管理钱包或 WL（→Locked）；`executeRefund` 任何人、非暂停、满 24h，退给 `orders[id].user` 原金额，**计入 `b2wDailyCap`**。`eventKey` 只由 `orderId` 推导：`orderEventKey(id)`。
- B2W：`queueRelease(srcEventNonce, to, amount)` 付款钥匙、非暂停、不查白名单；扣 `b2wDailyCap`；`executeRelease` 付款钥匙、满 `b2wDelay`。`eventKey` 的 `srcChainId = peerChainId`（BSC）。
- `setSupplyCeiling(c)`：管理钱包只能降低（立即）；时间锁可提高（A 类：非暂停、无恢复）；任何情况下 `c ≥ totalSupply`。

## 3. 偏差与待决

### 3.1 偏差（已实现的保守选择，均未改变 17 条决定）

| # | 偏差 | 依据章节 | 理由 |
|---|---|---|---|
| D1 | 订单状态加 `None = 0`：`None/Locked/Refunding/Refunded = 0/1/2/3`；`Order` 结构多一个 `refundRequestedAt` 字段 | §5.3、§5.4 | 若 `Locked = 0`，不存在的订单会读成 Locked，付款程序"放款前重读 `status == Locked`"会误判；24h 退款计时需要申请时间 |
| D2 | `orderId`、存款 `nonce` 都从 **1** 开始 | §5.2、§5.3 | 0 与"未设置"无法区分 |
| D3 | `queueRelease` 重放：状态已是 Queued 且 `(to, amount)` 相同 → **成功返回、无状态变化、无事件**；payload 不同则 `BadPayoutStatus` | §5.6 #13 | "合约返回已 Queued，不重复扣额度"；其他状态一律回滚 |
| D4 | 恢复进行期间白名单批次**添加和移除都拒绝**（`WhitelistWritesBlocked`）；冻结只拒绝添加 | §4.4 写"拒绝添加"，§4.5 写"禁止写入" | 取更严格的"禁止写入"；恢复期间管理钱包的 `emergencyRemove` 仍可用 |
| D5 | "同一时刻只允许一个恢复"按**跨两种恢复**实现：白名单钱包恢复与管理钱包恢复不能同时进行 | §4.5 step 2 | 更保守；双方都能先取消对方再发起，不会锁死 |
| D6 | 恢复期间：`beginWhitelistManagerTransfer`、`acceptWhitelistManagerTransfer`、正常交接的 `acceptAdmin` 均拒绝。管理钱包恢复**不**作废待接收的白名单钱包交接（规格只要求白名单钱包恢复作废），但期间无法接收 | §4.5、§4.6 | 恢复期间不让钥匙变化 |
| D7 | 时间锁取消权通过覆盖 `_checkRole` 实现；`CANCELLER_ROLE` 仍授给管理钱包并随交接迁移（仅为链下工具一致），白名单钱包无该角色也能取消 | §4.2 #4 | OZ `cancel` 函数体不可重写 |
| D8 | 时间锁所有角色在构造后冻结（含经时间锁自提议的 grant/revoke） | §4.2 #3 | "禁止直接增删"的最严格读法 |
| D9 | 白名单钱包交接 7 天有效期从 48h 等待期**结束后**起算（总窗口 begin + 48h + 7d）；`pendingAdmin` 7 天从 `transferAdmin` 执行时起算 | §4.5 #5、§4.6 #3 | 规格未写起点 |
| D10 | 两种恢复都**没有过期时间**；只能完成或取消 | §4.5、§4.6 | 规格未写；钥匙真丢失时需要它一直有效 |
| D11 | 签名有效期"24h"按**提交时** `deadline ≤ block.timestamp + 24h` 检查 | §4.4 | 合约无法知道签名时间 |
| D12 | `initialize` 强制 `peerBridge == address(this)` 且 `timelock.bridge() == address(this)` | §5.1 | 把"两链地址一致"的前提写成链上断言 |
| D13 | 收紧方向定义：`minDeposit`、`w2bMinAmount` **增大**为收紧；`maxDepositPerTx`、各类 cap、`largeThreshold` **减小**为收紧；`releaseDelay`、`b2wDelay` **增大**为收紧。规格未写下限的：`minDeposit > 0`、`maxDepositPerTx > 0`，`largeThreshold` 只受 `≤ perAddrDailyCap` 约束。**没有**加 `minDeposit ≤ maxDepositPerTx` 约束 | §5.5 | 不发明新约束；设反只会让存入失败，不影响资金安全 |
| D14 | 参数范围按"整币 × `10**decimals()`"（`decimals` 在 `initialize` 读取一次） | §5.5 | 两链 USDT 小数位不写死 |
| D15 | `Payout.queuedAt` 对 `release()` 也记录（= 扣额度时间） | §5.2 | 作废退额度按"扣额度那天" |
| D16 | `voidSourceBatch` 严格：任一项不是 None/Queued 则整批回滚；`payLegacyBatch` 任一 `oldKey` 已付整批回滚；空批拒绝 | §4.3、§10 | 宁可重提，不部分成功 |
| D17 | `executeRelease` 两条链都**只限付款钥匙** | §4.3 E | 规格 F（任何人）未列它 |
| D18 | `executeDepositRefund` 只计入全局 `dailyCap`，不计每地址额度 | §5.2 | 规格只写 dailyCap |
| D19 | `emergencyRemove` 每个地址发 `WhitelistUpdated(addr, false, listHash)`，另发 `WhitelistEmergencyRemoval(by, listHash, count)`，便于日报区分"管理钱包紧急移除" | §4.4、§9.3 | — |
| D20 | WANTOS 侧也有 `voidSource/cancelRelease/voidSourceBatch`（入账退款前提"WANTOS 先作废该 eventKey"） | §5.2 入账退款 | — |
| D21 | `bridgeOut` / `deposit` 的下限、上限和额度都按实际到账 `received` 检查 | §5.2、§5.3 | 按余额差额记账 |

### 3.2 待决（需要总控 / 负责人确认）

| # | 问题 | 章节 | 当前实现 / 备选 |
|---|---|---|---|
| Q1 | 单批上限 500 待 PR-0 ④（硬件钱包显示）定稿 | §4.4 | `MAX_WHITELIST_BATCH = 500` 常量；改它需要升级 |
| Q2 | `oldKey = keccak256(oldTxHash, logIndex)` 的**确切编码**（`abi.encode` 还是 `abi.encodePacked`、logIndex 位宽） | §10 | 合约不计算 oldKey，只做去重；**PR-8 必须定稿并在补付清单公布**。建议 `keccak256(abi.encode(bytes32 txHash, uint256 logIndex))` |
| Q3 | 恢复期间是否应允许白名单钱包的**移除**批次（D4） | §4.4 vs §4.5 | 当前禁止；如要允许，改一行条件 |
| Q4 | `pendingAdmin`（已执行、待接收）没有单独的取消函数；只能等 7 天过期、被下一次 `transferAdmin` 覆盖，或由白名单钱包启动恢复作废 | §4.6 | 规格未要求；若要加"白名单钱包可撤销 pendingAdmin"属新机制，未加 |
| Q5 | 存储布局检查：已提交快照并由测试核对（B5，§4.1 第 2 条）；仍未使用 `openzeppelin-foundry-upgrades` | §5.6 #6 | 建议 PR-2 审计时再用 OZ Upgrades 插件做 `validateUpgrade` 交叉核对 |
| Q6 | ~~slither 未运行~~ → **已完成（A2）**：High 0 / Medium 0，见 §4.0 | §13 PR-1 | — |
| Q7 | 两条链的实际 fork 部署演练（PR-0 ⑧）未做；`Deploy.s.sol` 只在内存演练 | §5.1 | 需负责人授权后在 fork / 测试网做 |

## 4. 自查清单

| 项 | 结论 |
|---|---|
| 重入 | 所有转出资金的函数（`release`、`executeRelease`、`executeRefund`、`executeDepositRefund`、`withdraw`、`payLegacyBatch`）与转入函数（`fund`、`deposit`、`bridgeOut`）都有 `nonReentrant`，且先写状态再转账。`ReentrancyTest` 用回调代币证明嵌套调用被 `ReentrancyGuardReentrantCall` 拦下 |
| 权限 | 每个外部写函数的调用者在 §5 接口表"调用者"列；`DEFAULT_ADMIN_ROLE` 只能是时间锁；时间锁角色构造后冻结；取消权运行时读取 |
| 整数 | 0.8 检查算术；`uint128/uint64/uint32` 截断：金额在写入前已受 ≤ 2 万/20 万整币的额度约束（`queueRelease` 在 WANTOS 上先记录后扣额度，超限整笔回滚），时间戳 `uint64` 足够；`forge lint` 的 10 处 unsafe-typecast 均属此类 |
| 签名重放 | EIP-712 domain 含 chainId + verifyingContract + 合约名（两链名字不同）；nonce 严格等于当前值并 +1；deadline ≤ 24h；OZ `ECDSA.recover` 拒绝高 s 和错误长度；签名者必须是**当前**白名单钱包 |
| 升级存储 | ERC-7201 命名空间，无顺序存储变量；实现合约构造函数 `_disableInitializers()`；升级测试验证白名单、放款、存款、额度、参数、储备不变 |
| 初始化 | `initializer` 只能一次；代理部署与初始化同一笔交易（`ERC1967Proxy` 构造）；实现合约不可初始化（已测试） |
| EVM 版本 | 反汇编三份运行时字节码的可执行区（第一个 `0xFE` 之前）：**无** `BLOBBASEFEE`/`PREVRANDAO`/`SELFDESTRUCT`/`CALLCODE`/`TLOAD`/`TSTORE`；唯一 `DELEGATECALL` 来自 UUPS 升级。`0xFE` 之后是数据区，反汇编出的零星"操作码"不可执行 |
| 时间戳 | 13 处 `block.timestamp` 比较均为小时/天量级的等待期，验证者可操纵的秒级偏差无实质影响 |

### 4.0 slither（A2）

- 版本 **slither 0.11.6**（装在 scratchpad 的 venv 中，未全局安装）；Python 3.14.7。
- 命令：`slither . --foundry-out-directory out --filter-paths "lib/|contracts/test/|contracts/script/"`（slither 自己会 `forge clean` + `forge build --build-info --skip test/script`）。
- 首次结果：High 0 / Medium 3 / Low 13 / Informational 6。处理：

| 检测器 | 等级 | 位置 | 处理 |
|---|---|---|---|
| uninitialized-local | Medium | `BridgeBase.applyWhitelistBatch` 的 `prev` | **修复**：显式 `address prev = address(0)`（行为不变，首个地址由 `i > 0` 守卫） |
| incorrect-equality | Medium | `BridgeBase._void`：`p.queuedAt / 1 days == currentDay()` | **误报**：比较的是 UTC 日序号（"同一天才退额度"的规格本意），不是余额；加 `// slither-disable-next-line incorrect-equality` |
| unused-return | Medium | `BridgeTimelock._checkBridgeSane`：`b.paused()` | **误报**：A1 自检里的可调用性探针，返回值本就不用；加 `// slither-disable-next-line unused-return` |
| missing-zero-check | Low | `transferAdmin(newAdmin)`、`startAdminRecovery(candidate)` | **误报**：两处都先调用 `_checkCandidate`，第一行即 `if (a == address(0)) revert ZeroAddress()`（slither 不跟进内部函数）；有测试 `test_transferAdminRejectsZeroSelfAndKeyHolder`、`test_startAdminRecoveryRejectsBadCandidates` |
| timestamp | Low ×11 | 各等待期/过期比较 | 预期：小时/天量级的等待期 |
| assembly / naming-convention / unused-state | Info | ERC-7201 取槽、`_b/_v/_w`、OZ 常量 | 预期 |

- 处理后：**High 0 / Medium 0** / Low 13（均为上表误报或预期）/ Informational 6。

### 4.1 升级检查清单（每次升级桥合约前逐条确认）

1. **新实现必须保留 `IBridgeForTimelock` 的五个视图且语义不变**：`timelock()`、`whitelistManager()`、`paused()`、`whitelistRecoveryActive()`、`isKeyHolder(address)`。
   时间锁在每次 `execute/executeBatch`（含升级本身）之后做自检 `_checkBridgeSane()`：`paused()` 可调用；任一恢复都不在进行中；`whitelistManager() != 0` 且 `isKeyHolder(whitelistManager())`；`timelock() == 时间锁地址`。任一项回滚或不成立 → `BridgeCheckFailed()`，整笔执行（含升级）回滚，治理不会被坏升级锁死（A1，测试 `TimelockSelfCheckTest`）。
2. 存储只能在各命名空间 struct **末尾追加**字段；不得改动、删除、重排已有字段；不得改命名空间字符串。对比 `contracts/test/layout/*.json` 快照（B5）：
   - `*.storageLayout.json` = `forge inspect <C> storageLayout --json` 的提交快照。两个桥必须为空（全部状态在 ERC-7201 命名空间里），时间锁是普通顺序存储。CI 命令：`for c in BridgeTimelock BscVaultV2 WantosBridgeV2; do diff <(forge inspect $c storageLayout --json) contracts/test/layout/$c.storageLayout.json; done`。
   - `*.namespace.json` = 每个命名空间的字段表（slot / 字节偏移 / 字节数）。solc 不输出命名空间布局，所以由 `StorageLayout.t.sol` 用 `vm.load` 逐字段核对（含映射与结构体打包：`Payout`、`Order`、`Deposit`）。字段被重排时测试变红（已用"交换 `unit` 与 `peerChainId`"变异验证）。
   - 追加字段的升级由 `test_upgradeWithAppendedFieldKeepsDataAndZeroesNewField`（mock `BscVaultV2Appended`）覆盖：旧数据不变，新字段为零，写新字段不影响旧数据。
   - 打包细节（下游直接读槽时注意）：`Order.refundRequestedAt` 不在 `amount/createdAt/status` 那个槽，而在结构体第 3 个槽。
3. 新实现先开源验证，codehash 与可复现构建一致（`Verify.s.sol`）。
4. 先在测试网走一次"时间锁升级 → 再升级回旧实现"的演练。

**自查发现但未修的风险**（见 §8 报告）：
1. ~~治理活性依赖桥的视图函数~~ → **已修（A1）**：执行后自检让坏升级整笔回滚。剩余风险：新实现视图"语义上错误但看起来合理"（例如 `isKeyHolder` 永远返回 true）不在自检能识别的范围内，靠上面的升级检查清单与审计。
2. ~~BscVaultV2 余量仅 917 B~~ → **B1 已缓解**：optimizer_runs 200 → 1 后余量 2,093 B，并有 ≥ 1,500 B 的测试门槛。代价：运行时 gas 略升（对低频桥操作可忽略）。
3. 付款钥匙可提前把任意 nonce 的放款排进队列（受白名单与额度约束），这是规格接受的风险（§5.2 最后一条），由监控兜底。

## 5. 下游接口清单（PR-3 付款程序 / PR-5 用户页 / PR-6 管理后台 / PR-7 监控 / PR-8 迁移的契约）

> ABI JSON 以构建产物为准：`forge inspect <BridgeTimelock|BscVaultV2|WantosBridgeV2> abi --json`。下表为人工可读版本，签名与 ABI 一致。

### 5.1 常量

| 名称 | 值 |
|---|---|
| `RELAYER_ROLE` | `keccak256("RELAYER_ROLE")` = `0xe2b7fb3b832174769106daebcfd6d1970523240dda11281102db9363b83b0dc4` |
| `PAUSER_ROLE` | `keccak256("PAUSER_ROLE")` = `0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a` |
| `DEFAULT_ADMIN_ROLE` | `0x00…00` |
| 时间锁 `PROPOSER_ROLE` / `EXECUTOR_ROLE` / `CANCELLER_ROLE` | OZ 标准：`0xb09aa5ae…19cc1` / `0xd8aa0f31…69e63` / `0xfd643c72…6f783` |
| `EVENT_KEY_TAG` | `"WANTOS-BSC-BRIDGE-V2"` |
| `MAX_WHITELIST_BATCH` | 500 |
| `MAX_SIGNATURE_TTL` | 24 h |
| `WL_TRANSFER_DELAY` / `WL_TRANSFER_TTL` | 48 h / 7 d |
| `WL_RECOVERY_DELAY` / 时间锁 `ADMIN_RECOVERY_DELAY` | 7 d / 14 d |
| `RECOVERY_COOLDOWN`（两处） | 3 d |
| `REFUND_DELAY` | 24 h（订单退款与入账退款共用） |
| 时间锁 `MIN_DELAY` / `MAX_DELAY` / `EXPIRY_PERIOD` / `PENDING_ADMIN_TTL` | 48 h / 7 d / 14 d / 7 d |
| `MAX_LEGACY_BATCH`（BSC） | 100 |

### 5.2 eventKey 编码（精确）

```solidity
eventKey = keccak256(abi.encode(string("WANTOS-BSC-BRIDGE-V2"), uint256 srcChainId, address srcBridge, uint256 srcEventNonce))
```
- `abi.encode` 中字符串是**动态类型**（head 为偏移 0x80，尾部为长度 20 + 内容右填充）。等价于 Solidity `keccak256(abi.encode("WANTOS-BSC-BRIDGE-V2", srcChainId, srcBridge, srcEventNonce))`。
- W2B（WANTOS→BSC）：`srcChainId = 13555`，`srcBridge = WANTOS 桥代理`，`srcEventNonce = orderId`。
  - BSC 侧：`vault.eventKeyOf(orderId)`；WANTOS 侧：`bridge.orderEventKey(orderId)`（两者相等）。
- B2W（BSC→WANTOS）：`srcChainId = 56`，`srcBridge = BSC 金库代理`，`srcEventNonce = Deposited.nonce`。
  - WANTOS 侧：`bridge.eventKeyOf(nonce)`；BSC 侧：`vault.depositEventKey(nonce)`（两者相等）。
- 通用：`computeEventKey(uint256 srcChainId, address srcBridge, uint256 srcEventNonce) pure`。
- **to / amount 不参与 key**。付款函数的参数是 `srcEventNonce`，合约自己推导 key。

### 5.3 状态枚举取值（`uint8`）

| 记录 | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| `payouts(eventKey).status`（BSC 放款、WANTOS B2W） | None | Queued | Released | Voided |
| `orders(orderId).status`（WANTOS） | None（不存在） | Locked | Refunding | Refunded |
| `deposits(nonce).refundStatus`（BSC） | None | Refunding | Refunded | — |

`getOperationState`（时间锁，OZ）：0 Unset / 1 Waiting / 2 Ready / 3 Done；过期另查 `isOperationExpired(id)`，陈旧另比 `proposalEpoch(id) != epoch()`。

### 5.4 EIP-712 白名单批次（精确）

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
  typehash 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f
  name    = "BscVaultV2"（BSC） | "WantosBridgeV2"（WANTOS）
  version = "1"
  chainId = 56 | 13555
  verifyingContract = 桥代理地址（两链相同）

WhitelistBatch(bytes32 listHash,uint32 count,bool allowed,uint256 nonce,uint256 deadline)
  typehash 0x5a100c8996927acc3ae2b696188b99aa517fc144b559fc238612fc884bec2a20

listHash   = keccak256(abi.encode(address[] sortedAddrs))   // 动态数组编码：偏移 0x20、长度、各地址左填充 32 字节
count      = sortedAddrs.length
structHash = keccak256(abi.encode(TYPEHASH, listHash, uint32(count), allowed, nonce, deadline))
digest     = keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)
```
- 链上辅助：`domainSeparator()`、`hashWhitelistBatch(sortedAddrs, allowed, nonce, deadline)`（返回 digest）、`eip712Domain()`（EIP-5267）。
- 提交：`applyWhitelistBatch(address[] sortedAddrs, bool allowed, uint256 nonce, uint256 deadline, bytes wlSignature)`，任何账户可提交；签名 65 字节 `r‖s‖v`。
- 校验顺序与错误：`BadBatchSize(n)`（0 或 >500）→ `WhitelistWritesBlocked()`（任一恢复中；或冻结且 `allowed=true`）→ `BadNonce(expected, provided)` → `SignatureExpired(deadline)`（`now > deadline`）→ `DeadlineTooFar(deadline)`（`deadline > now + 24h`）→ ECDSA 错误 / `InvalidSigner(recovered)` → 逐地址 `ZeroAddress()` / `AddressesNotSorted(index)`（必须严格递增，重复也算）。
- 成功：`whitelistNonce += 1`；每个地址 `WhitelistUpdated(addr, allowed, listHash)`；最后 `WhitelistBatchApplied(listHash, allowed, nonce, count)`。
- 作废已签批次：`invalidateWhitelistNonce()`（仅白名单钱包）→ `WhitelistNonceInvalidated(invalidatedNonce)`。

### 5.5 外部函数（两条链共有，来自 BridgeBase）

| 函数 | 调用者 | 暂停时 | 恢复时 |
|---|---|---|---|
| `applyWhitelistBatch(address[],bool,uint256,uint256,bytes)` | 任何人（带 WL 签名） | 可 | 拒绝 |
| `invalidateWhitelistNonce()` | WL | 可 | 可 |
| `freezeWhitelist()` | 管理钱包 | 可 | 可 |
| `unfreezeWhitelist()` | 时间锁 | 拒绝 | 拒绝 |
| `emergencyRemove(address[])` | 管理钱包 | 可 | 可 |
| `beginWhitelistManagerTransfer(address candidate)` | WL | 可 | 拒绝 |
| `cancelWhitelistManagerTransfer()` | WL 或管理钱包 | 可 | 可 |
| `acceptWhitelistManagerTransfer()` | 候选地址 | 可 | 拒绝 |
| `startWhitelistRecovery(address candidate)` | 管理钱包 | 可 | 拒绝（已有恢复） |
| `cancelWhitelistRecovery()` | WL 或管理钱包 | 可 | — |
| `acceptWhitelistRecovery()` | 候选地址（满 7 天） | 可 | — |
| `pause()` | PAUSER / 管理钱包 / WL | — | 可 |
| `unpause()` | 管理钱包 / WL | — | 可 |
| `grantRole(bytes32 role, address account)` | 时间锁（仅 RELAYER/PAUSER） | 可 | 拒绝 |
| `revokeRole(bytes32 role, address account)` | 时间锁 | 可 | （时间锁不执行） |
| `revokeKey(bytes32 role, address account)` | 管理钱包 | 可 | 可 |
| `renounceRole(bytes32 role, address self)` | 持有人（不含 DEFAULT_ADMIN） | 可 | 可 |
| `voidSource(uint256 srcEventNonce)` | 管理钱包 / WL | 可 | 可 |
| `voidSourceBatch(uint256[] srcEventNonces)` | 管理钱包 / WL | 可 | 可 |
| `cancelRelease(uint256 srcEventNonce)` | 管理钱包 / WL | 可 | 可 |
| `fund(uint256 amount)` | 任何人（需 approve） | 可 | 可 |
| `withdraw(address to, uint256 amount)` | 时间锁 | 拒绝 | 拒绝 |
| `upgradeToAndCall(address impl, bytes data)` | 时间锁 | **可** | 拒绝 |

视图：`timelock()`、`token()`、`peerChainId()`、`peerBridge()`、`adminWallet()`、`whitelistManager()`、`whitelisted(address)`、`whitelistNonce()`、`whitelistFrozen()`、`pendingWhitelistManager() → (candidate, availableAt, expiresAt)`、`whitelistRecovery() → (active, candidate, readyAt, cooldownUntil)`、`whitelistRecoveryActive()`、`anyRecoveryActive()`、`isKeyHolder(address)`、`payouts(bytes32) → (to, amount, queuedAt, status)`、`computeEventKey(...)`、`eventKeyOf(uint256)`、`currentDay()`、`dailyUsed(uint256 day)`、`addrDailyUsed(uint256 day, address)`、`domainSeparator()`、`hashWhitelistBatch(...)`、`paused()`、`hasRole(...)`、`eip712Domain()`。

### 5.6 BscVaultV2 专有

```solidity
struct Params { uint256 dailyCap; uint256 perAddrDailyCap; uint256 largeThreshold; uint256 releaseDelay; uint256 minDeposit; uint256 maxDepositPerTx; }
struct InitArgs { address timelock; address token; address whitelistManager; address relayer; address pauser; uint256 peerChainId; address peerBridge; Params params; }
```

| 函数 | 调用者 | 说明 |
|---|---|---|
| `initialize(InitArgs)` | 代理构造 | 一次 |
| `release(uint256 srcEventNonce, address to, uint256 amount)` | RELAYER | 非暂停；白名单；`amount ≤ largeThreshold` 且 `≤ perAddrDailyCap`；None→Released |
| `queueRelease(uint256 srcEventNonce, address to, uint256 amount)` | RELAYER | 非暂停；白名单；`≤ perAddrDailyCap`；None→Queued；同 payload 重放为空操作 |
| `executeRelease(uint256 srcEventNonce)` | RELAYER | 非暂停；Queued；满 `releaseDelay`；`to` 仍在白名单 |
| `deposit(uint256 amount, address wantosRecipient) returns (uint256 nonce)` | 任何人 | 非暂停 |
| `requestDepositRefund(uint256 nonce)` | 管理钱包 | None→Refunding |
| `cancelDepositRefund(uint256 nonce)` | 管理钱包 / WL | Refunding→None |
| `executeDepositRefund(uint256 nonce)` | 任何人 | 非暂停；满 24h；计入 `dailyCap` |
| `payLegacyBatch(bytes32[] oldKeys, address[] to, uint256[] amounts)` | 时间锁 | 非暂停；无恢复；≤100；每个 oldKey 一次 |
| `setParams(Params)` | 管理钱包（只收紧）/ 时间锁（任意，非暂停） | 范围与约束见下 |

视图：`params()`、`depositNonce()`（最后一个已用 nonce）、`deposits(uint256) → (from, amount, refundRequestedAt, refundStatus)`、`legacyPaid(bytes32)`、`depositEventKey(uint256)`。

参数范围（整币；`ParamOutOfRange(index)`，index 即字段序号）：0 `dailyCap` 1,000–500,000；1 `perAddrDailyCap` 100–20,000；3 `releaseDelay` 6h–7d；4 `minDeposit` (0, 20,000]；5 `maxDepositPerTx` (0, 20,000]；约束 `largeThreshold ≤ perAddrDailyCap ≤ dailyCap`（`ParamConstraint()`）。管理钱包放宽任一字段 → `NotTightening(index)` 整笔回滚。

### 5.7 WantosBridgeV2 专有

```solidity
struct Params { uint256 w2bMinAmount; uint256 w2bPerAddrDailyCap; uint256 b2wDailyCap; uint256 b2wDelay; }
struct InitArgs { address timelock; address token; address whitelistManager; address relayer; address pauser; uint256 peerChainId; address peerBridge; Params params; uint256 supplyCeiling; }
```

| 函数 | 调用者 | 说明 |
|---|---|---|
| `initialize(InitArgs)` | 代理构造 | 一次；`supplyCeiling ≥ totalSupply` |
| `bridgeOut(uint256 amount) returns (uint256 orderId)` | 白名单 EOA | 非暂停；见 §2.4 |
| `requestRefund(uint256 orderId)` / `requestRefundBatch(uint256[] orderIds)` | 管理钱包 | Locked→Refunding |
| `cancelRefund(uint256 orderId)` | 管理钱包 / WL | Refunding→Locked |
| `executeRefund(uint256 orderId)` | 任何人 | 非暂停；满 24h；计入 `b2wDailyCap` |
| `queueRelease(uint256 srcEventNonce, address to, uint256 amount)` | RELAYER | 非暂停；不查白名单；计入 `b2wDailyCap`；同 payload 重放为空操作 |
| `executeRelease(uint256 srcEventNonce)` | RELAYER | 非暂停；满 `b2wDelay` |
| `setSupplyCeiling(uint256)` | 管理钱包（只降）/ 时间锁（可升，非暂停） | 不得低于 `totalSupply` |
| `setParams(Params)` | 管理钱包（只收紧）/ 时间锁 | — |

视图：`params()`、`supplyCeiling()`、`orderNonce()`（最后一个已用 orderId）、`orders(uint256) → (user, amount, createdAt, status, refundRequestedAt)`、`orderEventKey(uint256)`。

参数范围（整币）：0 `w2bMinAmount` 10–20,000；1 `w2bPerAddrDailyCap` 10–20,000；2 `b2wDailyCap` 500–200,000；3 `b2wDelay` 10min–24h；约束 `w2bMinAmount ≤ w2bPerAddrDailyCap`。

### 5.8 存储命名空间（ERC-7201）

| 命名空间 | slot |
|---|---|
| `wantos.bridge.v2.BridgeBase` | `0x79137872e54e4a642e840f1b8680e7d27de6c15649eda752b94eb42353c3e000` |
| `wantos.bridge.v2.BscVaultV2` | `0x3bd3aa2096e9f4b3aa0d653c2fcdf8cde24fb7f30fa893e85a7f630b4e747000` |
| `wantos.bridge.v2.WantosBridgeV2` | `0x0387244fc401591078165e394a48ae68f7f99ff8e3e2c39eec4873b00e673300` |

### 5.9 BridgeTimelock

| 函数 | 调用者 |
|---|---|
| `schedule(address,uint256,bytes,bytes32 predecessor,bytes32 salt,uint256 delay)` / `scheduleBatch(...)` | 管理钱包（唯一提议人）；`delay ≥ 48h` |
| `execute(address,uint256,bytes,bytes32,bytes32)` / `executeBatch(...)` | 任何人；就绪、未过期、同 epoch、无恢复 |
| `cancel(bytes32 id)` | 管理钱包或 `bridge.whitelistManager()` |
| `transferAdmin(address newAdmin)` | 仅时间锁自身（经提议）；桥未暂停 |
| `acceptAdmin()` | `pendingAdmin`（7 天内）或恢复候选人（满 14 天） |
| `startAdminRecovery(address candidate)` | `bridge.whitelistManager()` |
| `cancelAdminRecovery()` | 管理钱包或 `bridge.whitelistManager()` |
| `updateDelay(uint256)` | 仅时间锁自身；48h ≤ 新延迟 ≤ 7d（`DelayBelowMinimum` / `DelayAboveMaximum`） |

视图：`adminWallet()`、`bridge()`、`pendingAdmin()`、`pendingAdminExpiresAt()`、`epoch()`、`proposalEpoch(bytes32)`、`isOperationExpired(bytes32)`、`adminRecoveryActive()`、`adminRecoveryCandidate()`、`adminRecoveryReadyAt()`、`adminRecoveryCooldownUntil()`、`MIN_DELAY()`、`getMinDelay()`，以及 OZ 的 `hashOperation`、`hashOperationBatch`、`getTimestamp`、`getOperationState`、`isOperation*`。

事件（自定义）：`AdminTransferStarted(address indexed currentAdmin, address indexed newAdmin, uint256 expiresAt)`、`AdminTransferred(address indexed previousAdmin, address indexed newAdmin, uint256 epoch, bool viaRecovery)`、`AdminRecoveryStarted(address indexed initiator, address indexed candidate, uint256 readyAt)`、`AdminRecoveryCancelled(address indexed by, address indexed candidate, uint256 cooldownUntil)`、`ProposalRecorded(bytes32 indexed id, uint256 epoch)`；以及 OZ 的 `CallScheduled`、`CallSalt`、`CallExecuted`、`Cancelled`、`MinDelayChange`、`RoleGranted`、`RoleRevoked`。

错误：`ZeroAddress()`、`RoleChangeForbidden()`、`DelayBelowMinimum(uint256 requested, uint256 minimum)`、`DelayAboveMaximum(uint256 requested, uint256 maximum)`、`NotCanceller(address caller)`、`OperationExpired(bytes32 id)`、`OperationStaleEpoch(bytes32 id)`、`RecoveryInProgress()`、`BridgePaused()`、`InvalidNewAdmin(address)`、`KeyConflict(address)`、`NotPendingAdmin(address caller)`、`PendingAdminExpired()`、`NotWhitelistManager(address caller)`、`RecoveryCooldown(uint256 until)`、`NoRecovery()`、`RecoveryNotReady(uint256 readyAt)`，以及 OZ `Timelock*`。

### 5.10 事件（桥，监控 PR-7 / 付款程序 PR-3 用）

共有（BridgeBase）：
```
WhitelistBatchApplied(bytes32 indexed listHash, bool allowed, uint256 nonce, uint256 count)
WhitelistUpdated(address indexed addr, bool allowed, bytes32 indexed listHash)
WhitelistNonceInvalidated(uint256 indexed invalidatedNonce)
WhitelistFrozen(address indexed by)
WhitelistUnfrozen()
WhitelistEmergencyRemoval(address indexed by, bytes32 indexed listHash, uint256 count)
WhitelistManagerTransferStarted(address indexed current, address indexed candidate, uint256 availableAt, uint256 expiresAt)
WhitelistManagerTransferCancelled(address indexed by, address indexed candidate)
WhitelistManagerChanged(address indexed previous, address indexed current, bool viaRecovery)   // initialize 时 previous = 0
WhitelistRecoveryStarted(address indexed initiator, address indexed candidate, uint256 readyAt)
WhitelistRecoveryCancelled(address indexed by, address indexed candidate, uint256 cooldownUntil)
ReleaseQueued(bytes32 indexed eventKey, uint256 indexed srcEventNonce, address indexed to, uint256 amount, uint256 executableAt)
Released(bytes32 indexed eventKey, uint256 indexed srcEventNonce, address indexed to, uint256 amount)
SourceVoided(bytes32 indexed eventKey, uint256 indexed srcEventNonce, address indexed by)
Funded(address indexed from, uint256 amount)
Withdrawn(address indexed to, uint256 amount)
Paused(address account) / Unpaused(address account)                      // OZ
RoleGranted / RoleRevoked / Upgraded(address indexed implementation)     // OZ
```
BSC：
```
ParamsUpdated((uint256,uint256,uint256,uint256,uint256,uint256) params, address indexed by)
Deposited(uint256 indexed nonce, address indexed from, address indexed wantosRecipient, uint256 amount)
DepositRefundRequested(uint256 indexed nonce, bytes32 indexed eventKey, address indexed from, uint256 amount, uint256 executableAt)
DepositRefundCancelled(uint256 indexed nonce, address indexed by)
DepositRefunded(uint256 indexed nonce, address indexed from, uint256 amount)
LegacyPaid(bytes32 indexed oldKey, address indexed to, uint256 amount)
```
WANTOS：
```
ParamsUpdated((uint256,uint256,uint256,uint256) params, address indexed by)
SupplyCeilingUpdated(uint256 previous, uint256 current, address indexed by)
BridgeOut(uint256 indexed orderId, address indexed user, uint256 amount)
RefundRequested(uint256 indexed orderId, bytes32 indexed eventKey, address indexed user, uint256 amount, uint256 executableAt)
RefundCancelled(uint256 indexed orderId, address indexed by)
Refunded(uint256 indexed orderId, address indexed user, uint256 amount)
```
注意：`release()` 只发 `Released`（不发 `ReleaseQueued`）；`executeRelease()` 也发 `Released`。§9.1 的"BSC 每笔 `Released`/`ReleaseQueued` 对应 WANTOS `BridgeOut`"按 `srcEventNonce == orderId` 对应。

### 5.11 自定义错误（桥，PR-3 回滚分类 §6.3 用）

| 错误 | 含义 → 建议分类 |
|---|---|
| `BadPayoutStatus(bytes32 eventKey, uint8 status)` | 读 status：2→RELEASED，1→QUEUED，3→REJECTED |
| `DailyCapExceeded(uint256 used, uint256 cap)` / `AddrDailyCapExceeded(address, uint256 used, uint256 cap)` | WAITING(额度) |
| `SafeERC20FailedOperation(address token)` / ERC20 余额不足 | WAITING(储备) |
| `EnforcedPause()` | WAITING(暂停) |
| `NotWhitelisted(address)` | WAITING(白名单) |
| `AmountAboveLimit(uint256 amount, uint256 limit)` | REVIEW(金额超限) |
| `NotReady(uint256 readyAt)` | 未到期，稍后重试 |
| `AccessControlUnauthorizedAccount(address, bytes32)` | 付款钥匙被吊销 → 告警 |
| 其他 | FAILED |

其余：`ZeroAddress()`、`ZeroAmount()`、`InvalidInit()`、`NotAdmin(address)`、`NotWhitelistManager(address)`、`NotAdminOrWhitelistManager(address)`、`NotTimelock(address)`、`NotAuthorized(address)`、`RecoveryInProgress()`、`KeyConflict(address)`、`InvalidRole(bytes32)`、`BadBatchSize(uint256)`、`AddressesNotSorted(uint256)`、`BadNonce(uint256 expected, uint256 provided)`、`SignatureExpired(uint256)`、`DeadlineTooFar(uint256)`、`InvalidSigner(address)`、`WhitelistWritesBlocked()`、`Expired()`、`NotCandidate(address)`、`NothingPending()`、`NoRecovery()`、`RecoveryCooldown(uint256 until)`、`AmountBelowMinimum(uint256, uint256)`、`LengthMismatch()`、`NotTightening(uint256 index)`、`ParamOutOfRange(uint256 index)`、`ParamConstraint()`；BSC：`UnknownDeposit(uint256)`、`BadDepositStatus(uint256 nonce, uint8 status)`、`LegacyAlreadyPaid(bytes32)`；WANTOS：`ContractCaller(address)`、`SupplyCeilingExceeded(uint256 totalSupply, uint256 ceiling)`、`CeilingBelowSupply(uint256 ceiling, uint256 totalSupply)`、`BadOrderStatus(uint256 orderId, uint8 status)`。

### 5.11a 运维与监控注意事项（PR-3 / PR-6 / PR-7 必读）

1. **紧急移除前先冻结**（PR-6 紧急页）：`emergencyRemove` 不推进 `whitelistNonce`，已签未提交的添加批次仍能把地址加回来。管理后台的"紧急移除"按钮必须先发 `freezeWhitelist()`（或确认已冻结）再发 `emergencyRemove`。测试：`test_runbook_emergencyRemoveWithoutFreezeCanBeUndoneByPresignedAdd`。
2. **未来 orderId 可被作废**（PR-3 / PR-7）：`voidSource(n)` 对尚未出现的 `n` 也成立（None→Voided）。付款程序遇到 `BadPayoutStatus(key, 3)` 直接把订单转 REJECTED → 退款；监控对"作废了尚不存在的 orderId"的 `SourceVoided` 应告警（可能是白名单钱包被盗）。测试：`test_runbook_wlCanVoidFutureOrderIds`。
3. **重复暂停**（PR-7）：桥已暂停时再 `pause()` 回滚 `EnforcedPause()`；监控应先读 `paused()`，或把这个回滚当作成功。测试：`test_runbook_doublePauseRevertsEnforcedPause`。
4. **时间锁自检**（PR-6 时间锁面板）：任何执行（含升级）后若桥的视图异常，整笔回滚 `BridgeCheckFailed()`；面板应把它显示为"新实现不合格"，而不是"执行失败重试"。

### 5.12 部署

- 顺序（同一全新部署者，nonce 0/1/2）：`new BridgeTimelock(adminWallet, predictedProxy)` → `new BscVaultV2()` / `new WantosBridgeV2()` → `new ERC1967Proxy(impl, abi.encodeCall(initialize, (InitArgs)))`，其中 `InitArgs.timelock = nonce0 地址`、`peerBridge = nonce2 地址`。
- 地址预测：`PredictAddresses.predict(deployer, n)`；部署：`Deploy.deployBsc / deployWantos`（要求部署者 nonce 为 0、预测地址无代码，部署后断言地址一致）；验收：`Verify.verify(Expect)`。

## 6. 验证结果（本地）

- `forge build --sizes`（optimizer_runs = 1）：

| 合约 | 运行时 | 余量 | initcode keccak256（与地址无关） |
|---|---|---|---|
| BridgeTimelock | 11,581 B | 12,995 B | `0x498a425cf63b31a127c7fd6676bfb57d89193cc6d6ae445eaa85c4b616fd677e` |
| BscVaultV2 | 22,483 B | 2,093 B | `0x5a452ec9e84081f509586c655f5bac7b615d2647bf4a144d0b5b669603fc19ed` |
| WantosBridgeV2 | 21,661 B | 2,915 B | `0x69d0b764fcc310e0972b9293a00e6bc15405ffd72f5e30b0a15327355fb62adc` |

- **CI 门槛**：任何核心合约运行时余量必须 ≥ 1,500 B；由 `SizeGateTest.test_runtimeSizeMargins` 强制（`forge test` 不过即红）。
- **codehash 说明**：实现合约含 UUPS 的 `__self` immutable（= 实现自身地址），时间锁含 `bridge`/`MIN_DELAY` immutable，所以**运行时 codehash 取决于部署地址与构造参数**，不能离线写死。验收脚本 `Verify.s.sol` 的 `IMPLEMENTATION_CODEHASH` 取法：用同一提交、同一 `foundry.toml`（runs = 1）在本地以 `PredictAddresses` 预测出的实现地址重放部署（或 fork 演练），读取 `extcodehash`；构建可复现性用上表 initcode 哈希核对。任何编译设置变化（含 optimizer_runs）都会改变这些哈希。
- `forge test`：203 通过 / 0 失败（9 个测试套件；fuzz 512 轮）。
- `forge coverage --report summary --no-match-coverage "(test|script)/"`：四个核心合约行、语句、分支、函数**均 100%**。
- `forge fmt --check`：通过。
- `forge lint`：13 × block-timestamp、10 × unsafe-typecast（见 §4，均为预期）。

## 7. §5.6 十四条不变量 ↔ 测试

| # | 不变量 | 正例 | 反例 |
|---|---|---|---|
| 1 | 白名单为空时无法跨出、无法放款 | `test_inv01_pos_whitelistedGetsPaid`、`WantosInvariantsTest.test_inv01_pos_whitelistedCanBridgeOut` | `test_inv01_neg_emptyWhitelistNoPayout`、`WantosInvariantsTest.test_inv01_neg_emptyWhitelistNoBridgeOut` |
| 2 | 同一 eventKey 只放款一次或作废一次 | `test_inv02_pos_payOnce` | `test_inv02_neg_noSecondPayNoVoidAfterPay_noPayAfterVoid`、`test_inv02_neg_queuedThenVoidedCannotExecute` |
| 3 | UTC 日额度（含排队、入账退款、退款执行） | `test_inv03_pos_upToCapsAllowed`、`WantosInvariantsTest.test_inv03_pos_b2wUpToCap`、`testFuzz_inv03_quotaAccounting`、`testFuzz_inv03_b2wCap` | `test_inv03_neg_globalPerAddrAndDepositRefundCounted`、`WantosInvariantsTest.test_inv03_neg_b2wIncludingRefundExecutionCapped`、`test_cap_resetsAtUtcMidnight`（跨零点 2 倍照实） |
| 4 | A 类只经时间锁；48h；14 天过期；暂停期间不能提取/放宽；恢复期间不执行；交接后旧地址 cancel 被拒 | `test_inv04_pos_executesAfter48h`、`test_inv04_mixed_pausedUpgradeOkButWithdrawAndLoosenNot`（升级、换钥匙在暂停期间可执行） | `test_inv04_neg_directCallsRejected`、`test_inv04_neg_before48hAndAfterExpiry`、`test_inv04_neg_nothingExecutesDuringRecovery`、`test_inv04_neg_oldHolderCancelRejected` |
| 5 | 钥匙两两不同；提议人恰好一个；WL 只经交接/恢复；DEFAULT_ADMIN 只是时间锁 | `test_inv05_pos_distinctKeysAccepted` | `test_inv05_neg_duplicateKeysAndExtraProposerAndDefaultAdmin`、`test_init_keysMustBePairwiseDistinct`、`test_keys_defaultAdminLockedToTimelock` |
| 6 | 升级后数据不变；存储布局 | `test_inv06_pos_upgradePreservesState`、`WantosInvariantsTest.test_inv06_pos_ordersSurviveUpgrade`、`BscLayoutTest.test_upgradeWithAppendedFieldKeepsDataAndZeroesNewField`、`BscLayoutTest.test_*NamespaceFieldsMatchSnapshot`、`WantosLayoutTest.test_wantosNamespaceFieldsMatchSnapshot` | `test_inv06_neg_nonUupsImplementationRejected` |
| 7 | 暂停矩阵 | `test_inv07_pos_pausedStillAllowsDefensiveOps` | `test_inv07_neg_pausedBlocksMoneyPaths`、`test_pause_blocksMoneyPaths` |
| 8 | 批次：当前 WL 签名、nonce 不重放、不跨链、24h、冻结/恢复不能加、严格递增 | `test_inv08_pos_validBatch` | `test_inv08_neg_replayExpiredFrozenUnsorted`、`test_wl_crossChainRejected`、`test_wl_crossContractRejected`、`test_wl_outOfOrderNonceRejected`、`test_wl_unsortedAndDuplicateRejected` |
| 9 | 交接/恢复：等待期、指定地址、过期、零地址、钥匙重复、否决、对称取消、一次一个、完成/取消后自动可写 | `test_inv09_pos_recoveryCompletesWhenNobodyCancels`、`test_recovery_happyPathAndAutoUnblock` | `test_inv09_neg_symmetricCancelOneAtATime`、`test_handover_expires`、`test_handover_cancelAndVeto`、`test_handover_rejectsBadCandidates` |
| 10 | 超 `supplyCeiling` 拒绝跨出；不得降到 totalSupply 以下 | `test_inv10_pos_atCeilingAllowedAndRaiseViaTimelockRestores` | `test_inv10_neg_overCeilingRejectedAndCannotLowerBelowSupply` |
| 11 | 退款只退原地址原金额；eventKey 由 orderId 推导 | `test_inv11_pos_refundToOriginalUserAndAmount` | `test_inv11_neg_noRefundForUnknownOrLockedOrTwice` |
| 12 | 收紧不破下限；夹带放宽整笔回滚；约束成立 | `test_inv12_pos_tightenAndConstraintsHold` | `test_inv12_neg_smuggledLoosenAndFloor`、`test_params_adminSmuggledLoosenRevertsWhole` |
| 13 | 重放 queueRelease 不重复扣额度 | `test_inv13_pos_replayReturnsQueuedWithoutDoubleCharge` | `test_inv13_neg_replayWithDifferentPayloadReverts` |
| 14 | 同一 oldKey 只付一次 | `test_inv14_pos_legacyPaidOnce` | `test_inv14_neg_legacySecondPaymentReverts` |

未加前缀的测试名在 `BscVaultV2Test`；`test_invNN_*` 未注明的在 `BscInvariantsTest`（`contracts/test/Invariants.t.sol`）。
