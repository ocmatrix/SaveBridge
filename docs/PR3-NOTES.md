# PR-3 付款程序 Relayer v2：实现说明、偏差与待决、下游接口约定

> 依据：`docs/DESIGN.md` v0.9.4（§5、§6、§7 钩子、§9.3、§13 PR-3 验收）、`docs/PR1-NOTES.md` §5（合约契约）、`@bridge/abi`。分支 `pr-3-relayer`。
> 范围：只写代码与本地测试。**未连接任何真实网络/节点，未发送任何真实链上交易，未读写任何真实私钥。** 测试只用本机 anvil（127.0.0.1，chainId 31337 当 WANTOS、31338 当 BSC，另有 31339 做 reader 单测），私钥只用 anvil 公开开发账户或 `generatePrivateKey()` 临时生成。配置示例里只有 `*.example.invalid` 占位 URL 和 `0x…dEaD` 占位地址。
> 17 条已拍板决定未改动。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `packages/relayer/src/config.ts` | 配置类型、示例（占位）、校验：BSC ≥ 2 个 RPC、WANTOS 交叉核对 RPC 必须存在且与主节点不同、确认数 ≥ 6、回扫 ≥ 100 块、**拒绝任何密钥材料**（键名含 priv/secret/mnemonic/seed/password 或 64 位十六进制值） |
| `src/eventKey.ts` | PR1-NOTES §5.2 eventKey（W2B / B2W 两个包装） |
| `src/db/{types,pg,pglite,migrations}.ts` | 小 DB 接口；生产 `pg` 适配器、测试 PGlite 适配器；DESIGN §6.5 五张表 + 内部列/索引，迁移可重复执行（`if not exists` + `schema_migrations`） |
| `src/chain/reader.ts` | `ChainReader` 只读接口 + viem 实现 |
| `src/chain/wantosScanner.ts` | WANTOS 数据源：主节点 + 交叉核对；6 确认；receipt 两源一致；游标 hash 校验；摄取 `BridgeOut` |
| `src/chain/bscScanner.ts` | BSC 数据源：≥ 2 RPC、只处理 `finalized`、两源 finalized 块 hash 一致、日志集合一致；摄取 `Deposited` |
| `src/chain/cursor.ts` | `chain_cursor`（块号 + hash），`rewind` 供人工恢复 |
| `src/chain/ingest.ts` | 事件解码 → 订单（eventKey 幂等） |
| `src/chain/sender.ts` | 串行发送器（每把钥匙同一时刻只有一个在途 nonce）：签名后广播前落库、重启对齐 nonce 与原样重播、同 nonce 加价替换、卡住/nonce/KMS/gas 告警 |
| `src/chain/revert.ts` | 回滚数据解码（桥两链错误 + OZ ERC20 错误 + `Error(string)`） |
| `src/chain/bridges.ts` | 桥合约只读视图（payouts / orders / deposits / params / 额度 / 余额） |
| `src/stateMachine.ts` | §6.3 状态、转移表、WAITING 原因（B2W 无白名单）、每个状态的超时阈值 |
| `src/classify.ts` | §6.3 回滚原因分类表 |
| `src/orders.ts` | 订单仓库：幂等插入、按 §6.3 转移表做 compare-and-set、`reasons` jsonb 记录全部转移历史 |
| `src/risk.ts` | 风控钩子 `RiskEngine` + 仅用链上信息的默认实现（PR-4 替换） |
| `src/review.ts` | 订单审核：管理钱包 personal_sign 验签（EOA / ERC-1271 都走 viem `verifyMessage`），写 `audit_log` |
| `src/processor.ts` | 订单处理主体（§6.3 两个方向、最终块结算、回滚分类、queueRelease 重放、到期执行、退款跟踪、FAILED 人工处理入口） |
| `src/timeouts.ts` | 每状态超时告警（每个 订单×状态×原因 只告一次，状态/原因变化后重新计时） |
| `src/timelockExecutor.ts` | 提交服务：到期时间锁提议自动执行（单条/批量），24h / 6h 提醒（持久化，不重复） |
| `src/alerts.ts` / `src/heartbeat.ts` / `src/safety.ts` | 告警出口（接口 + 内存/日志/扇出/去重实现）、心跳、重组停机开关与回调 |
| `src/api.ts` | 只读 API：`GET /v1/orders?address=`、`GET /v1/quota?address=`；`/admin/*` 只做 SIWE 会话校验接口占位 |
| `src/signer.ts` | `TxSigner` 接口；`LocalTestSigner`（仅测试）；`KmsSigner` 占位（拒绝签名，生产实现步骤写在注释） |
| `src/relayer.ts` / `src/main.ts` | 组装与主循环；生产入口骨架（未在测试中运行，也不会连接任何真实网络） |
| `packages/relayer/test/*` | 18 个测试文件，196 个测试（见 §5） |
| `scripts/gen-abi.sh`、`packages/abi/src/*.ts` | 修正生成器：`] as const;` 原来被拆成两行，ASI 让 `as const` 悬空，vitest/esbuild 无法导入 `@bridge/abi`。ABI 内容未变 |

## 2. 实现说明（按 DESIGN 条目）

### 2.1 数据来源（§6.2）
- **WANTOS**：`safe = head − 6`；只取 `log.address == 桥` 且 topic0 = `BridgeOut` 的日志（即使 RPC 返回了别的地址的日志也丢弃）。每条日志：主节点 receipt 与**每一个可达**的交叉核对节点 receipt 都必须 `status=success`、`blockHash` 相同、包含同一条日志（地址/topics/data/logIndex/块 hash 全等）；至少一个交叉核对节点可达。不一致 → `RPC_MISMATCH`，游标停在该日志所在块之前；交叉核对全不可达 → `RPC_UNAVAILABLE`，等待。区间末块的 hash 也要交叉核对一致才推进游标。
- **BSC**：每个配置的 RPC 都必须返回 `finalized`（任一取不到 → `BSC_FINALIZED_UNAVAILABLE` 并等待，**不降级到 latest**）；取最低的 finalized 高度，并要求所有 RPC 在该高度的块 hash 相同；各 RPC 的 `Deposited` 日志集合必须一致。BSC 放款也只在 finalized 块上读到 `payouts.status` 后才记 RELEASED/QUEUED/REJECTED。
- **游标与回滚**：每轮先用主节点（BSC 用全部 RPC）重读游标块；hash 变了 → `SafetyState.reportReorg`：发一级告警（`WANTOS_REORG` / `BSC_REORG`）、回调 `onReorg(side, info)`（给 PR-7/运维接入暂停）、**该链停止摄取，且两条链的所有发送全部停止**，直到人工 `CursorRepo.rewind` + `SafetyState.clear`。进程重启后游标 hash 仍不一致，会再次停机（停机状态无需持久化）。
- **启动回扫**：每个扫描器的第一次扫描从 `游标 − 100 + 1` 开始；摄取靠 `event_key` 唯一主键幂等。

### 2.2 事件摄取与 eventKey
- W2B：`computeEventKey(WANTOS chainId, WANTOS 桥, orderId)`；`user_addr = to_addr = BridgeOut.user`（§5.3 收款地址固定）。
- B2W：`computeEventKey(BSC chainId, BSC 金库, Deposited.nonce)`（= WANTOS 侧 `eventKeyOf(nonce)`，`srcChainId = peerChainId`）；`user_addr = from`，`to_addr = wantosRecipient`。
- 独立向量（`cast abi-encode` + `cast keccak` 算出）与 anvil 上合约 `eventKeyOf/orderEventKey` 的结果一致（E2E 中用合约结果对账）。

### 2.3 订单状态机（§6.3）
- 状态与转移表见 `stateMachine.ts`；两个方向共用转移表，方向差异在原因上：**B2W 不允许 `whitelist` 原因**（也不出现 `amount_limit`）。
- WAITING 原因：`index / whitelist / quota / reserve / paused / amount_limit`；`amount_limit` 不会停在 WAITING，按 §6.3 直接转 REVIEW(audit)。
- 终态 RELEASED / REFUNDED；FAILED 只能人工 `retryFailed`（→ DETECTED 重新评估）或 `rejectFailed`（→ REJECTED）。
- **所有"已成事实"的状态（RELEASED / QUEUED / REJECTED / REFUNDING / REFUNDED）只依据付款链在最终块（BSC finalized / WANTOS head−6）上读到的合约状态**；非最终块上读到的 Released/Voided 只会让订单等待。
- 每个状态都有出口和超时告警（阈值见 §3.1 D6）。

### 2.4 回滚原因分类（§6.3、PR1-NOTES §5.11）
`classify.ts`：先读 `payouts[eventKey].status`：Released→RELEASED、Queued→QUEUED、Voided→REJECTED；否则按错误：`DailyCapExceeded`/`AddrDailyCapExceeded`→WAITING(quota)、`SafeERC20FailedOperation`/`ERC20InsufficientBalance`/`Error("…exceeds balance…")`→WAITING(reserve)、`EnforcedPause`→WAITING(paused)、`NotWhitelisted`→WAITING(whitelist)（B2W → FAILED）、`AmountAboveLimit`→REVIEW、其他→FAILED（`AccessControlUnauthorizedAccount` 另发 `RELAYER_KEY_REVOKED`）。`executeRelease` 失败时状态仍为 Queued：`NotReady` 保持 QUEUED；暂停/白名单 → QUEUED 并带原因。
- 模拟（eth_call）失败与链上已上块的回滚都走同一张表；链上回滚的原因通过在该交易所在块之后的状态上重放调用取得。

### 2.5 放款流程
- 每轮：两把付款钥匙的发送器先 `tick`（确认上块/重播/加价），然后逐单处理（单个订单出错只告警 `ORDER_PROCESSING_ERROR`，不阻塞其他订单），最后超时检查。
- DETECTED/WAITING：①最终块上 payout 已非 None → 直接按分类结算（例如崩溃后 DB 丢了更新）；②该订单有在途交易 → 跳过（绝不重复发）；③最新块上已是 Queued（崩溃后丢状态）→ **直接重放 `queueRelease`**，合约返回成功且不重复扣额度（PR1 D3 / §5.6 #13）；④否则调用风控钩子：AUTO→`release`（B2W 一律 `queueRelease`）、DELAY→`queueRelease`、WAIT→WAITING、REVIEW→REVIEW。
- **源订单硬前置条件（Gate2 A1/A2，处理器执行，风控与审核批准都不能覆盖）**：每次发任何付款交易之前（`release`、`queueRelease`、崩溃后重放的 `queueRelease`、**到期的 `executeRelease`**），以及每次调用风控之前：W2B 重读 WANTOS `orders[id]`，必须 Locked 且用户/金额与事件一致；B2W 重读 BSC `deposits(nonce)`，存款人/金额一致且**未申请入账退款**。不满足 → 不发交易，发 `ORDER_ONCHAIN_MISMATCH`；未排队的订单进 REVIEW(freeze, `onchain_mismatch`)，已 QUEUED 的保持 QUEUED(reason=`onchain_mismatch`) 等负责人 `cancelRelease`。B2W 也做的理由：入账退款与 WANTOS 入账是同一类「两边都付」风险，对称检查成本只有一次读。
- **审核批准的范围**：批准时记录当时的 `review_level` 与 `reason`（`approved_level/approved_reason`）；只有风控再次返回**同一** level+reason 的 REVIEW 才按 DELAY 放行；以别的 level 或 reason 重新进入 REVIEW 时批准自动作废（`approved_at` 清空），需重新签。
- **审核签名一次性（Gate2 r2 A-2）**：每个决定按「签名消息的哈希」登记在 `review_signatures`（迁移 v8，主键唯一），同一消息再提交一律拒绝（`review signature already used`），因为按消息而非签名字节去重，同一消息的另一种签名编码（如 high-s）也被拒绝。approve 的 UPDATE 必须恰好命中一行（订单仍为 REVIEW 且 level/reason 与读到的一致），否则整笔回滚，不写 `audit_log`、也不消耗该签名。
- **已签名交易的广播前复核（Gate2 r2 A-1）**：`TxSender` 在三个时点调用 `Processor.broadcastGuard`（即上面的源订单硬前置条件）：广播 `signed` 行之前、启动时原样重播之前、同 nonce 加价之前。§6.4「原样重播」不变，只是先过前置条件。结果：ok → 照常；读不到（RPC 错）→ 本轮什么都不发，下轮重试；不一致 → 一级告警 `SIGNED_TX_SOURCE_MISMATCH`，订单进 REVIEW(freeze, onchain_mismatch)，该 nonce 的付款 attempt 标 `abandoned`，并用同 nonce、gas 价高于所有 attempt 的 0 值自转账（`action=cancel`）占掉这个 nonce。被 abandoned 的行仍参与 receipt 判定：若原交易已进过某个内存池并抢先上链，结果不会丢，由下一条兜底告警。若节点不支持同 nonce 替换（Q1），已进内存池的原交易可能仍上链，此时只能靠兜底告警由负责人处理。
- **放款后兜底（Gate2 r2 A-1 #2）**：`release` / `executeRelease` 已上链（未最终）或订单进入 RELEASED 时，再读一次源订单；W2B 不再 Locked 或 B2W 存款出现入账退款申请 → 一级 `PAYOUT_ALREADY_RELEASED`（文案：立即 `cancelRefund` / `cancelDepositRefund`），每个订单每个进程只发一次。`queueRelease` 上链不触发（资金未动，`executeRelease` 前仍有硬前置条件）。
- 默认风控（`DefaultRiskEngine`，W2B 顺序）：BSC `paused()` → 两链白名单 → `amount > perAddrDailyCap` → 剩余全局/地址日额度 → 储备（金库余额 ≥ 本单 + 已排队/在途） → `amount > largeThreshold` ? DELAY : AUTO。B2W：WANTOS `paused()` → `b2wDailyCap` 剩余 → 储备 → DELAY。
- 合约没有 `remainingDailyCap()/remainingAddrCap()` 视图（见 §3.1 D1），剩余额度 = `params` 上限 − `dailyUsed(currentDay())` / `addrDailyUsed(currentDay(), addr)`。
- 发交易时 `onSigned` 回调与 `tx_attempts` 插入在**同一个 DB 事务**里把订单置为 SUBMITTED（带交易哈希），然后才广播。
- SUBMITTED：最终块 payout 非 None → 结算（`executeRelease` 的单在最终块仍是 Queued 时继续等）；交易已上块回滚 → 取原因分类；`dropped` 或订单无任何交易记录 → FAILED。
- QUEUED：按**链上时间**判断是否到期（`queuedAt + 当前 releaseDelay/b2wDelay`，与合约一致）→ `executeRelease`；被撤销（Voided，最终块）→ REJECTED。
- REJECTED → REFUNDING：付款链上该 eventKey 在最终块为 Voided。REFUNDING → REFUNDED：W2B 看 WANTOS `orders[id].status == Refunded`（6 确认），B2W 看 BSC `deposits(nonce).refundStatus == Refunded`（finalized）。**退款发起/作废/执行都由负责人钱包或任何人在链上完成，relayer 只跟踪状态。**
- 启动检查：两条链 `chainId` 与配置一致；两边代币 `decimals` 相同（放款金额与源金额按原始单位相等），否则拒绝启动。

### 2.6 可靠性（§6.4）
- `tx_attempts`：签名后、广播前落库（含原始交易字节、gas 价格、动作、发送地址）；加价替换的每个哈希一行；状态 `signed → broadcast → mined | reverted | replaced | dropped`。
- 启动恢复：链上 `latest/pending` nonce 与库内记录对齐（库外有人用过这把钥匙 → `NONCE_MISMATCH`）；已签名未广播的交易**原样重播**（同一哈希）；已被消耗的 nonce 按 receipt 结算。
- 单进程串行：每把钥匙同时只有一个在途 nonce（`busy`），两把付款钥匙与提交服务钥匙互不干扰（`tx_attempts.from_addr`）。
- 卡住：超过 `stuckAfterMs` → 同 nonce 加价（≥ 原价 ×(1+bump%) +1，且不低于当前市价），最多 `maxFeeBumps` 次；关闭替换或次数用尽 → `TX_STUCK` 告警，人工处理。
- 交易类型：legacy（EIP-155，带 chainId），两条链都支持。

### 2.7 提交服务（§4.1 / §6.4）
`TimelockExecutor`：扫描时间锁 `CallScheduled`/`CallSalt`，对每个提议读 `getOperationState`、`isOperationExpired`、`getTimestamp`、`proposalEpoch == epoch`；Waiting 期间在 readyAt 前 24h、6h 各提醒一次（`TIMELOCK_REMINDER`，持久化在 `timelock_notices`，重启不重复；错过 24h 窗口不补发）；Ready 且未过期、同 epoch → 用**无任何合约角色**的热钥匙发 `execute`/`executeBatch`；被取消（Unset）/已执行/过期/陈旧 epoch 一律跳过；模拟回滚（如暂停中）→ `TIMELOCK_EXEC_BLOCKED` 告警一次，之后每轮重试。

### 2.8 只读 API（给 PR-5 / PR-6）
- `GET /v1/orders?address=0x…`（**按 PR-5 约定，Gate2 E1**）：`{"orders":[{"direction":"W2B"|"B2W","srcEventNonce":"<十进制字符串>","dstTxHash":"0x…"|null}]}`，字段集合固定为这三个；匹配 W2B 的发起用户与 B2W 的存款人（`user_addr`，不按收款人匹配），最新 50 单；`dstTxHash` 只有订单 RELEASED 且放款交易由本 relayer 发出并上链时才有值，其余为 `null`。**不返回任何状态字段**（决定 16：少披露；状态由用户页自己读链），也不返回原因、审核级别、错误。
- `GET /v1/quota?address=0x…`：`whitelisted{wantos,bsc}`、`w2b{minAmount, perAddrDailyCap, usedToday, remainingToday}`（WANTOS 当日按地址）、`b2w{minDeposit, maxDepositPerTx}`；按地址缓存 15s、未命中缓存的链上查询全局限 20 次/秒，超出 → 429（Gate2 B5）；后端异常 → 503（不泄露细节）。
- CORS：只对配置 `api.corsOrigins` 中**完全相同**的 Origin 回 `access-control-allow-origin`（`vary: Origin`）；`OPTIONS` 预检只允许 GET，未列入的 Origin → 403。默认空（不放开），示例配置为 `["https://bridge.wanto.pro"]`。
- 400 地址非法、405 非 GET、404 其他路径；响应 `cache-control: no-store`；默认只监听 `127.0.0.1`。
- `/admin/*`：先过 `AdminSessionVerifier.verify(headers)`（默认 `DenyAllAdminSessions` → 401）；通过后一律 501（PR-6 实现）。

## 3. 偏差与待决

### 3.1 偏差（已实现的保守选择，均未改变 17 条决定）

| # | 偏差 | 章节 | 理由 |
|---|---|---|---|
| D1 | 任务描述里的 `remainingDailyCap()/remainingAddrCap(addr)` 合约里**不存在**（以实际 ABI 为准）；改为 `params()` − `dailyUsed(currentDay())` / `addrDailyUsed(currentDay(), addr)` 计算 | §6.4、PR1-NOTES §5.5 | 实际 ABI 为准 |
| D2 | "订单创建后地址被移出白名单且当前仍不在 → REJECTED"（§4.4）实现为 **REVIEW(audit, `whitelist_removed`)**，由负责人签名拒绝后才 REJECTED；判断依据是 WANTOS 当前不在白名单（`bridgeOut` 创建时必然在、移除按 §4.4 先 WANTOS 后 BSC）。只是 BSC 还没写入 → WAITING(whitelist)，30 分钟告警 | §4.4、§6.3 | 风控接口按任务定义只有 AUTO/DELAY/REVIEW/WAIT；REJECTED 会走退款且不可逆，交给负责人更保守 |
| D3 | 审核通过的订单若风控仍返回 REVIEW，按 **DELAY（走排队）** 处理，不走即时 `release` | §6.3 REVIEW | 给通过的单再留一个 `releaseDelay` 可撤销窗口 |
| D4 | QUEUED 期间地址被移出白名单：`executeRelease` 回滚 `NotWhitelisted`，订单保持 QUEUED(reason=whitelist) 并触发 QUEUED 超时告警；负责人 `cancelRelease` 后（最终块 Voided）才 REJECTED | §6.3 QUEUED 出口 vs 分类表 | 分类表"先读 status：Queued→QUEUED"优先；作废只能由负责人钱包执行 |
| D5 | 储备检查：金库余额 ≥ 本单 + 同方向 QUEUED/SUBMITTED 订单金额之和（已付款但未最终确认的 SUBMITTED 也计入） | §6.3 储备 | 宁可多等，不超付 |
| D6 | 规格未给出的超时阈值：DETECTED 10 分钟、WAITING(quota) 6h、WAITING(paused) 1h、SUBMITTED 30 分钟、QUEUED 到期 + 30 分钟（无到期时间 24h）、REJECTED 72h、REFUNDING 72h、FAILED 立即。规格给出的照用：索引 10 分钟、白名单 30 分钟、储备立即、审核 72h、冻结 7 天 | §6.3 | 均可配置（`Timeouts`） |
| D7 | 同 nonce 加价替换**默认开启且可配置**（`tx.replaceByFee`） | §6.4、PR-0 ⑥ | PR-0 ⑥ 未实测，见 Q1 |
| D8 | 每把钥匙同一时刻只允许一个在途 nonce（严格串行） | §6.4 "单进程串行发送" | 恢复与加价逻辑最简单；吞吐约每块一笔，远高于日额度所需 |
| D9 | 重组后两条链的**所有发送**都停止（不只受影响的链），直到人工清除 | §6.2、§9.1 | §9.1 WANTOS 回滚要求暂停两条链；relayer 无 PAUSER 钥匙，只暴露 `onReorg` 回调 |
| D10 | 订单审核签名格式自定（EIP-191 personal_sign 文本，见 §4.2），签名者 = 付款链桥合约的 `adminWallet()`，`expires` 不得超过 24h | §6.1 | 规格只写"管理钱包签名、付款程序验签"；需与 PR-6 对齐（Q4） |
| D11 | 对外状态把 DETECTED/WAITING/FAILED 也并入 `processing` | §7"对外不公开" | 只把 REVIEW 显示为 processing，用户仍能从差异推断出 REVIEW |
| D12 | B2W 超过当日 `b2wDailyCap` → WAITING(quota)（6h 超时告警），不自动发起入账退款 | §5.3"超过当日额度直接走入账退款" | 入账退款由管理钱包发起，relayer 不持有该权限 |
| D13 | 默认风控对 W2B 重读 WANTOS 订单时，状态非 Locked 或用户/金额不一致 → REVIEW(freeze) + 告警，不直接 REJECTED | §5.3 第三道防线 | 不付款是硬约束；如何处置交负责人 |
| D15 | 负责人「拒绝」前先读付款链 `payouts[eventKey]`，已 Released → 拒绝该签名并发一级 `PAYOUT_ALREADY_RELEASED`；REJECTED 阶段读到最终 Released → 告警且永不推进到 REFUNDING（Gate2 B1） | §6.3 REJECTED | 防止「已放款又退款」 |
| D16 | 模拟失败但**没有 revert 数据**（传输/节点错误或空 revert）不做分类：订单保持原状态并告警 `RPC_UNAVAILABLE`；读 receipt 出错（不是「确认不存在」）中止本轮，不会判为 dropped（Gate2 B2） | §6.3 | 网络抖动不应把订单送进只能人工处理的 FAILED |
| D17 | RPC URL 只从环境变量读取（配置里只写变量名，配置中出现 `://` 直接拒绝，`api.corsOrigins` 除外）；所有拼进告警的异常文本先脱敏（URL 的 userinfo/路径/查询、Authorization/Bearer、64 位十六进制），结构化字段（`data` 里的 eventKey 等）不经过脱敏（Gate2 B3） | §6.1 | RPC URL 常带 API key |
| D19 | 已签名付款交易在源订单失效时用 0 值自转账作废其 nonce（`action=cancel`，记入 `tx_attempts`），而不是留空 nonce（Gate2 r2 A-1） | §6.4 | 保证不再发出，同时 nonce 不断档 |
| D18 | 启动自检：两侧合约 `eventKeyOf(1)` 必须等于 relayer 自算的 W2B/B2W key，`peerChainId/peerBridge` 必须与配置的另一侧一致，两把付款钥匙与提交服务钥匙两两不同，否则拒绝启动（Gate2 B6） | §5.1、§6.1 | 配置错配时不发任何交易 |
| D14 | 链上回滚原因在"该交易所在块之后"的状态上重放调用获取（不依赖 `debug_traceTransaction`） | §6.3 | 同块先上链的暂停/作废能被正确识别；节点不必开 debug API |

### 3.2 待决（需要总控 / 负责人确认）

| # | 问题 | 章节 | 当前实现 / 建议 |
|---|---|---|---|
| Q1 | **WANTOS 是否支持同 nonce 替换（PR-0 ⑥）** 未实测；不通过不能上线 | §6.4、§13 PR-0 | 可配置、默认开；不支持时置 `replaceByFee=false`，卡住只告警 + 人工流程 |
| Q2 | **KMS 签名器未实现**（只有接口与实现步骤注释）；`main.ts` 用它时任何发送都会以 `KMS_FAILURE` 失败 | §6.1 | 选定云 KMS 后补实现；地址在配置中固定并于启动时核对 |
| Q3 | **自建交易索引**（WANTOS 上 USDT/MG/TIDE `Transfer`、原生币转账、工厂下 8 个交易对 `Swap`）未在 PR-3 实现；`WAITING(index)` 原因已保留，默认风控不会产生它 | §6.2、§7 | 建议随 PR-4 一起做（PR-4 是唯一消费者），表结构由 PR-4 定 |
| Q4 | 订单审核签名消息格式（§4.2）需 PR-6 确认；多签管理钱包走 ERC-1271（`verifyMessage` 已支持），但多签的离线签名流程需 PR-6 设计 | §6.1、§8.2 | 现格式见 §4.2 |
| Q5 | 管理后台 SIWE 会话校验只有接口占位 | §8.2 | PR-6 实现 `AdminSessionVerifier` |
| Q6 | 白名单批次的代提交（"提交服务按顺序提交两条链"）未实现，只做了时间锁自动执行 | §4.1、§8.2 | 建议 PR-6 定接口后在提交服务里加 `submitWhitelistBatch`（添加先 BSC 后 WANTOS；移除反之），复用 `TxSender` |
| Q7 | 外部心跳服务、短信/电话第二通道：只有 `HeartbeatSink` / `AlertSink` 接口与内存/日志实现 | §6.5、§9.3 | 选型见 DESIGN §14 待决 3 |
| Q8 | 仓库根 `package.json` 的 `"packageManager": "pnpm@10"` 不是完整版本号，corepack 直接报错，`pnpm` 命令在仓库内无法运行。本 PR 未改根文件，验证时直接调用 pnpm 10.34.5（`node ~/.cache/node/corepack/v1/pnpm/10.34.5/bin/pnpm.cjs -r test`） | — | 总控在 ts-workspace 上改成 `pnpm@10.34.5` 之类完整版本 |
| Q9 | QUEUED 订单在 SUBMITTED 后若交易所在块被 WANTOS 回滚（>6 块重组），只靠游标 hash 检测与 SUBMITTED 30 分钟超时告警，不自动重发 | §6.2 | 发生重组时 relayer 已停机，需人工处理 |
| Q12 | Gate2 r2 backlog（按总控指示本轮不做，留待后续）：①WANTOS 主节点落后于交叉核对节点时的告警/处理（aligner B1）；②时间锁执行器只扫 finalized 区块并做重叠回扫，防重组丢提议（aligner B4）；③限流按来源区分、脱敏覆盖更多异常字段等补漏（aligner B6） | §6.2、§4.1 | — |
| Q11 | 审核签名改 EIP-712：按总控指示**不在 PR-3 做**，交 PR-6 定稿后再改（避免来回改） | §6.1 | 现为 personal_sign 文本 |
| Q10 | `index` 等待原因之外，数据源整体不可用不会产生订单，因此"索引 > 10 分钟"告警目前由 `RPC_UNAVAILABLE/RPC_MISMATCH`（去重后）承担 | §6.3 | PR-4 接入索引后由风控返回 WAIT(index) |

## 4. 给下游的接口约定

### 4.1 PR-4 风控（`src/risk.ts`）
```ts
type RiskDecision = { kind: "AUTO" } | { kind: "DELAY" } | { kind: "REVIEW"; level: "audit" | "freeze"; reason?: string } | { kind: "WAIT"; reason: WaitReason };
interface RiskEngine { evaluate(order: Order, ctx: { outstandingWei: bigint }): Promise<RiskDecision>; }
```
- `Order`（`src/orders.ts`）提供：`eventKey, direction, srcChain, srcEventNonce, srcTxHash, srcBlockNumber, userAddr, toAddr, amountWei, status, reason, reviewLevel, stateSince, createdAt, approvedAt, approvedLevel, approvedReason`。
- 源订单 Locked/存款一致检查**不在引擎里**，由处理器在调用引擎前和每次发交易前强制执行，引擎无法关闭它（Gate2 A1）。
- 约定：PR-4 引擎应**包住**（而不是丢掉）`DefaultRiskEngine` 的链上检查（暂停、两链白名单、额度、储备），再叠加资金来源与行为规则；索引不可用或落后时返回 `WAIT("index")`（§7 降级，不放松规则）；REVIEW 的 `reason` 会存进 `orders.reason`，但**永不对外**。
- 引擎每轮会被反复调用（WAITING 订单每轮重评），需幂等、无副作用；审核通过后引擎若仍返回**同一 level+reason** 的 REVIEW，会按 DELAY 处理（D3）；返回不同 level/reason（例如 PR-4 新发现的 freeze 级风险）会使旧批准作废。
- 受控集合表 `controlled_set`、审计表 `audit_log` 已建（§6.5），PR-4/PR-6 直接使用。

### 4.2 PR-6 管理后台
- 只读：`GET /v1/orders`、`GET /v1/quota`（§2.8）；`/admin/*` 需实现 `AdminSessionVerifier`（`src/api.ts`）。
- 订单审核：`ReviewService.decide({ eventKey, decision: "approve" | "reject", expires, signature })`；签名为管理钱包对以下文本的 personal_sign（`chainId` 为付款链：W2B 用 BSC，B2W 用 WANTOS；`eventKey` 小写；`expires` 为 unix 秒，必须在未来 24h 内）：
  ```
  WANTOS-BSC-BRIDGE-V2 review decision
  chainId: <payout chain id>
  eventKey: 0x<64 hex lowercase>
  decision: approve|reject
  expires: <unix seconds>
  ```
  每次决定写 `audit_log(actor=管理钱包, action=review.approve|review.reject, payload)`。
- FAILED 人工处理：`Processor.retryFailed(eventKey)`（→ DETECTED 重新评估）、`Processor.rejectFailed(eventKey)`（→ REJECTED）；后台接这两个动作时同样应要求管理钱包签名（建议复用上面的消息格式，`decision: retry|reject-failed`，待 PR-6 定）。
- 退款/作废/撤销都在链上由负责人钱包执行；relayer 只把订单从 REJECTED 推进到 REFUNDING/REFUNDED。

### 4.3 PR-7 监控（共享定义）
- eventKey：`src/eventKey.ts`（与 PR1-NOTES §5.2 一致，含独立测试向量）。
- 最终性：BSC = 所有配置 RPC 都给出 finalized 后取最低高度且 hash 一致；WANTOS = head − 6。
- 回滚事件：`SafetyState.onReorg((side, { block, storedHash, observedHash }) => …)`；relayer 侧同时一级告警并停止所有发送。
- 对账口径：relayer 认定"已放款"= 付款链最终块上 `payouts[eventKey].status == Released`；B2W 排队 = `ReleaseQueued` 的 `srcEventNonce` 即 BSC `Deposited.nonce`。
- 告警种类与级别：`src/alerts.ts` 的 `ALERT_LEVEL`（一级：`WANTOS_REORG`、`BSC_REORG`、`HEARTBEAT_MISSED`；`RESERVE_CRITICAL` 已预留给 §9.3「储备不足 0.5 天」，relayer 目前不发；其余二级/三级）。
- 对外接口不返回订单状态（E1）；`publicStatus()`（`src/api.ts`）只留作 PR-6 内部视图的映射参考。
- 一级告警 `PAYOUT_ALREADY_RELEASED`：REJECTED/待拒绝订单的放款在链上已 Released，**不得退款**（Gate2 B1）。

## 5. 测试与覆盖率

- 运行：`cd packages/relayer && npx vitest run`（或在仓库根用 pnpm 10：`pnpm -r typecheck`、`pnpm -r test`，见 Q8）。测试会在本机起 anvil 并在缺少 `out/` 时执行一次 `forge build`；不访问外部网络。
- 结果（Gate2 第 2 轮后）：**21 个文件 / 254 个测试全部通过**；`pnpm -r typecheck` 通过。
- 覆盖率（v8，`src/**`，不含 `main.ts`）：总计 语句 95.18% / 分支 88.05% / 函数 96.72% / 行 98.24%。

### 5.1 DESIGN §13 PR-3 验收故障注入 ↔ 测试

| 验收项 | 测试（文件 › 名称） |
|---|---|
| 断网：RPC 全断 / 部分断 | `faults.test.ts › network down (all RPCs, then partial) → no crash, alerts, resumes`；`scanners.test.ts › network: cross-check down … all down -> no crash; recovers after`；`scanners.test.ts › finalized unavailable on one RPC -> waits` |
| 进程重启 | `faults.test.ts › process restart mid-flight continues from the DB; duplicate events never duplicate orders`；`scanners.test.ts › restart rescans 100 blocks back from the cursor` |
| 签名后广播前崩溃 | `faults.test.ts › crash after sign, before broadcast → restart re-broadcasts the same raw tx; paid exactly once`；`sender.test.ts › crash after sign, before broadcast: restart rebroadcasts the identical raw tx and aligns nonce`；`sender.test.ts › onSigned runs in the same DB transaction …` |
| BSC 重组 / finalized 取不到 | `scanners.test.ts › BSC reorg below the stored cursor -> BSC_REORG alert and halt`；`faults.test.ts › BSC finalized unavailable → SUBMITTED never becomes RELEASED; no fallback to latest`；`scanners.test.ts › finalized block hash disagreement between RPCs …`、`log sets disagreeing between RPCs …`、`uses the lower of the two finalized heights` |
| WANTOS 区块 hash 变化 | `faults.test.ts › WANTOS block hash change (real reorg on anvil) → WANTOS_REORG level 1, halt, no further sends`；`scanners.test.ts › block hash change at the cursor -> WANTOS_REORG …`；`faults2.test.ts › halted (reorg) relayer submits nothing for existing orders …`；`scanners.test.ts › operator recovery after a reorg halt …` |
| 重复事件 | `scanners.test.ts › duplicate events (rescan / restart) never create duplicate orders`；`migrations.test.ts › event_key is a unique primary key`；`orders.test.ts › round-trips …（重复插入返回 false）` |
| 交易卡住（加价替换） | `faults.test.ts › stuck BSC tx is fee-bumped at the same nonce and the order still settles`；`sender.test.ts › stuck tx is replaced at the same nonce …`、`replacement disabled -> TX_STUCK`、`bumps exhausted -> TX_STUCK` |
| 额度不足 → WAITING | `faults.test.ts › quota insufficient → WAITING(quota); next UTC day → released`；`… DailyCapExceeded → WAITING(quota)`；`faults.test.ts › B2W over b2wDailyCap → WAITING(quota)` |
| 余额不足 → WAITING | `faults.test.ts › reserve insufficient → WAITING(reserve) with an immediate RESERVE_LOW alert`；`… ERC20 insufficient balance → WAITING(reserve)` |
| 两链白名单不一致 → WAITING | `faults.test.ts › whitelist on WANTOS but not yet on BSC → WAITING(whitelist), 30-min alert, proceeds once BSC is written`；`… NotWhitelisted → WAITING(whitelist)` |
| 合约暂停中提交 → WAITING | `faults.test.ts › bridge paused → WAITING(paused); after unpause it is submitted`；`… EnforcedPause → WAITING(paused)`；`faults2.test.ts › simulation passes but the tx reverts on-chain (pause lands first in the same block) → classified WAITING(paused)`；`faults2.test.ts › QUEUED and due while paused → stays QUEUED(paused) …` |
| 崩溃后重放 queueRelease，合约返回已 Queued | `faults.test.ts › crash after queueRelease (state lost) → replay returns already-Queued, quota not charged twice` |
| 回滚原因分类每一类 | Released：`… payout already Released (DB lost the update) → RELEASED without a new tx`；Queued：上一行 + `classify.test.ts › Queued -> QUEUED`；Voided：`… payout Voided by the owner → REJECTED → REFUNDING → REFUNDED`、`faults2.test.ts › QUEUED payout cancelled by the owner → REJECTED`；额度/余额/暂停/白名单：上面四行；金额超限：`… AmountAboveLimit → REVIEW`；其他：`… anything else (relayer key revoked) → FAILED + RELAYER_KEY_REVOKED`；纯函数全表：`classify.test.ts` |
| B2W 无白名单原因 | `stateMachine.test.ts › B2W has no whitelist wait reason`；`classify.test.ts › B2W has no whitelist reason`；`e2e.test.ts › B2W …`（收款人不在白名单仍放款） |
| 金额超限 → REVIEW | `faults.test.ts › amount above the current per-address cap → REVIEW(amount_limit)`；`… AmountAboveLimit → REVIEW` |
| 状态机每个状态的出口与超时 | `stateMachine.test.ts › every non-terminal state has at least one exit …`（及允许/禁止转移逐条用例）；`timeouts.test.ts`（13 个状态/原因各一例 + QUEUED eta + 重新计时）；`faults2.test.ts › FAILED is manual only …`、`SUBMITTED with no attempt or with a dropped attempt → FAILED` |
| E2E：W2B 小额直接放款 | `e2e.test.ts › W2B small amount: BridgeOut → 6 confirmations → release → BSC finalized → RELEASED` |
| E2E：W2B 大额排队到期执行 | `e2e.test.ts › W2B large amount: queueRelease → QUEUED → executeRelease after 12h → RELEASED` |
| E2E：B2W 排队 15 分钟 | `e2e.test.ts › B2W: Deposited → finalized → queueRelease → QUEUED 15 min → executeRelease → RELEASED` |
| 其他（规格要求、非 §13 列举） | 只处理本链桥地址：`scanners.test.ts › ignores logs whose address is not this chain's bridge …`、`ignores foreign-address Deposited logs`；receipt 两源一致：`scanners.test.ts › requires the cross-check receipt to agree …` 等 3 例；放款前重读 WANTOS 订单：`faults.test.ts › WANTOS order no longer Locked …`；审核验签：`faults.test.ts › REVIEW: owner approval …`；提交服务：`timelockExecutor.test.ts`（6 例）；API：`api.test.ts`（8 例）；告警出口：`alerts.test.ts`；心跳：`timeouts.test.ts › heartbeat`；KMS/gas/nonce 告警：`sender.test.ts`；配置拒绝密钥：`config.test.ts` |

### 5.2 Gate2 第 1 轮回归（`test/gate2r1.test.ts` 等）

| 项 | 回归测试 | 修复前（红证据） |
|---|---|---|
| A1 / 探针 P1 | `gate2r1 › A1/P1: approved REVIEW, then WANTOS refund requested → nothing is sent`；`A1: the source-order check is a hard precondition even with a permissive risk engine`；`A1: an approval only covers the level+reason it was given for`；`A1: approval for the same level+reason still proceeds` | 发出 `[queueRelease]` / `[release]` / `[queueRelease]` |
| A2 / 探针 P2 | `gate2r1 › A2/P2: QUEUED, then WANTOS refund requested → executeRelease is never sent`；`A2 (B2W): deposit refund requested on BSC → …not sent` | 发出 `[queueRelease, executeRelease]`，BSC payouts.status=2；B2W 存款 1 被排队 |
| A3 / 探针 P3 | `gate2r1 › A3/P3: bump race — the ORIGINAL tx is mined after a bump` | 订单变 FAILED |
| E1 | `api › E1: GET /v1/orders matches PR-5's contract`、`E1: at most 50 orders`、`E1: CORS only for configured origins` | 字段为旧集合（含 status）、100 条、无 CORS 头 |
| B1 | `gate2r1 › B1: owner reject is refused when the payout is already Released…` | `decide(reject)` 成功 |
| B2 | `gate2r1 › B2: an RPC hiccup during simulation…`；`sender › B2: simulation failing without revert data…`、`B2: a receipt read error is not 'not found'…` | DETECTED → FAILED；tick 走 dropped 路径 |
| B3 | `redact.test.ts`（含反例）；`config › B3: refuses RPC URLs written into the config file` | 告警原样带 `…/v2/<key>?key=…` |
| B4 | `timelockExecutor › B4: scans with a persisted cursor in bounded ranges…`、`B4: executor failures are alerted` | 5 块 getLogs 限制下整段扫描报错、无提醒；错误被吞 |
| B5 | `api › B5: /v1/quota is cached per address and globally rate-limited` | 每次请求都读链 |
| B6 | `gate2r1 › B6/B7: startup self-checks`（eventKey / peer / 钥匙互异） | `start()` 照常通过 |
| B7 | `gate2r1 › B7: …`（暂停、额度、在途、outstanding、重放 payload）；`timelockExecutor › expired … without even simulating`、`B7: proposals from a previous admin epoch…`；`gate2r1 › B7: token decimals must match` | 原存活变异 M13 M14 M20 M25 M26 M27 M29 M30 |

变异重跑（独立副本 `scratchpad/mut-r2`，脚本 `scratchpad/mutr2/run2.py`）：aligner 原 30 个变异（M05 随代码移到 processor，模式已更新）+ 本轮 28 个新变异，共 58 个，**全部被杀死**；aligner 探针 P1/P2/P3 在新代码上 3/3 通过。

## 6. 上线门槛（Gate2 B9）

- **PR-10 上线前必须**：接入真实告警通道（负责人电话/短信 + 即时消息，§9.3）替换 `main.ts` 中的 `LogAlertSink`，并接入外部心跳服务（`HeartbeatSink`）；否则一级告警（重组、`PAYOUT_ALREADY_RELEASED`、心跳中断）不会到达负责人，**不得上线**。
- 同时必须完成 Q1（PR-0 ⑥ 同 nonce 替换实测）与 Q2（KMS 签名器实现）。

### 5.3 Gate2 第 2 轮回归（`test/gate2r2.test.ts`）

| 项 | 回归测试 | 修复前（红证据，`scratchpad/r2red.txt`） |
|---|---|---|
| A-1 / 探针 P4 | `A-1/P4: signed-not-broadcast release + WANTOS refund requested before restart → never broadcast, nonce cancelled, next order still pays` | BSC payouts=Released，订单 RELEASED，0 条告警 |
| A-1 B2W 对称 | `A-1 (B2W): signed-not-broadcast WANTOS queueRelease + BSC deposit refund requested` | 照常入队 |
| A-1 加价 | `A-1: a stuck release is NOT fee-bumped once the WANTOS refund was requested` | 发出第二笔 release（加价） |
| A-1 读不到 | `A-1: guard read failure (RPC error) → nothing broadcast this tick` | 照常广播 |
| A-1 兜底 | `A-1 safety net: …mined but not final`、`…reaching RELEASED…`、`(B2W) …executeRelease is mined…`；反例 `safety net is silent on a normal release` | 无告警 |
| A-2 / 探针 P5 | `P5: replaying an approval after the REVIEW scope changed is refused`（含 high-s 变形签名）、`same-scope approval replay and reject replay are refused too`、`approve that updates no row … throws and writes no audit` | 重放成功并把批准改成 freeze/r2；并发改状态后仍写 audit_log |
| N03/N04/N06/N07 | `source check: each field matters on its own`（W2B/B2W × user/amount） | （变异存活项，代码本身正确） |
| N08–N11 | `approval scope: level and reason each void it on their own` | （同上） |
| B3/N13 lastAttempt | `lastAttempt picks the latest (signer, nonce) group, resolved row first` | `lastAttemptFor` 不存在 / 跨钥匙按 nonce 选错行 |
| B5 revert 原因读失败 | `B5: an RPC error while reading a mined revert's reason keeps SUBMITTED` | 被分类成 FAILED |
| 存活变异 R8 / R11 | `A-1: if the abandoned ORIGINAL still gets mined (cancel lost)…`；`approve whose REVIEW scope changed between read and write…` | — |

变异重跑（`scratchpad/mutr2/run3.py`，独立副本）：第 1 轮 58 个（A3 的模式随新查询更新）+ 第 2 轮 24 个，共 82 个。首轮 80 个被杀，R8、R11 存活；补上面两条测试后重跑，R8、R11 也被杀，**82/82**。aligner 探针在新代码上：P4 → BSC payouts=0、订单 REVIEW、告警 `SIGNED_TX_SOURCE_MISMATCH`；P5 → 重放被拒（`review signature already used`）。

## 7. 自查发现但未修的风险

1. **KMS 未实现**（Q2）：生产入口目前无法发送交易，这是刻意的（不碰真实密钥），上线前必须补。
2. **同 nonce 替换依赖 PR-0 ⑥**（Q1）：WANTOS app mempool 若拒绝替换，卡住的交易只能告警 + 人工处理；严格串行意味着一笔卡住会阻塞该链所有放款。
3. **储备检查偏保守**（D5）：已付款但未最终确认的 SUBMITTED 订单仍计入"在途"，储备临界时可能短暂多等一轮。
4. **WAITING 订单每轮重评**会对链上视图做多次读取（每单约 6–8 次 eth_call）；订单积压很多时 RPC 压力上升。目前没有批量/缓存。
5. `/v1/quota` 已加缓存与全局限流（B5），但限流是进程内的单窗口计数，没有按来源 IP 区分；Worker 侧仍建议再限流。
6. **`run()` 的看门狗在同一进程内**：事件循环卡死时它也不会触发，真正的兜底依赖外部心跳服务（Q7）。
7. 风险 `outstandingWei` 只按本地订单表计算，不含链上由他人（例如被盗付款钥匙）排进队列的放款；那种情况由监控（PR-7）核对。
8. 测试用 anvil 的 `finalized = latest − 64` 模拟 BSC 最终性；BSC 真实 finalized 语义（快速最终性）在 PR-9 测试网联调中再验证。
