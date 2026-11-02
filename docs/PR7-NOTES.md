# PR-7 独立监控 Watcher（服务器 B）：实现说明、配置、偏差与待决、运维手册草稿

> 依据：`docs/DESIGN.md` v0.9.4 §9（9.1 / 9.2 / 9.3）、§4.3 C、§5.3、§6.2、§11；`docs/PR1-NOTES.md` §5（以实际 ABI `@bridge/abi` 为准）。分支 `pr-7-watcher`。
> 范围：只写代码与本地测试。**未连接任何真实网络 / 节点，未接入 Telegram / 短信 / 电话 / 心跳服务，未发送真实链上交易，未读写真实私钥。** 测试只用本机两个 `anvil`（随机端口，127.0.0.1）与 anvil 公开默认账户。17 条决定未改。

## 0. GATE2 第 1 轮修复（v2）摘要

| 项 | 修复 | 回归测试 |
|---|---|---|
| A1 | 每段日志在**全部** RPC 上各取一次，取并集（按 txHash:logIndex 去重，同位置不同内容取多数版本），≥ `minRpcAgreement` 个 RPC 成功且区段末块 hash 共识一致才推进游标；有 RPC 漏报 / 内容不一 → 二级 `RPC_DISAGREE`；安全高度 = 各 RPC 安全头的**最小值**（BSC finalized / WANTOS latest−6），回答的 RPC 不足 → 等待并告警 | `rpc-hardening > A1 …`（POC2 转化）×3 |
| A2 | `paused()` 用多 RPC 共识读（未达成共识 = 未知，不当作已暂停）；「已暂停 / 交易已上链 / EnforcedPause 回滚」三条成功路径**都必须再经 ≥2 RPC 确认 `paused()==true`**，否则重试，最终 `PAUSE_FAILED`（一级） | `rpc-hardening > A2 …`（POC3 转化）×2；`pauser` 单元 ×3 |
| A3 | `Unpaused` 只确认满足「事件区块 ≤ 解除区块」**且**「解除区块时间 ≥ 事件 `decideAt`」的事件；向前补查改为共识读、只到本轮安全头 | `pause-reorg-replay > POC1 …`（原 :70 测试反转）、`… an unpause not yet under the safe head …`；原「解除后旧事件不循环暂停」测试保留（链上解除时间已过宽限期） |
| A4 | 退款核对的「已撤回」只认 `Locked`（订单）/ `None`（存款退款）；`Refunded`（已执行）继续做源链核对，不符暂停并一级告警 | `refund-hardening > A4 …` ×2 |
| A5 | 补「源链为 Released / Queued」的退款与存款退款反例 | `refund-hardening > A5 …` ×4（杀死 M28 / M29） |
| B1 | `PAUSE_FAILED` 按核对项每小时至多一条（从首次失败起算） | `pause-reorg-replay > a revoked PAUSER key …` |
| B2 | 告警发送失败进入持久化 `outbox`、每轮重试，一级重复登记只在送达后；每段日志原子应用（出错整段回滚，不重复累加） | `state-alerts > B2 …`、`pause-reorg-replay > B2 …` |
| B3 | `src/redact.ts`：错误文本统一脱敏（URL 的 userinfo / 路径 / query、Authorization / Bearer、64 位 hex），用于告警详情、`PAUSE_FAILED`、RPC 答复、`main.ts` 调用栈 | `redact` 单元 ×4 |
| B4 | 待核对项到目标可执行时间（排队 eta / 退款可执行时间）仍暂缓或分歧 → 一级 `CHECK_OVERDUE`（不暂停）；每轮比对系统时钟与 BSC 最新块时间，偏差 > `maxClockSkewSeconds`（60）→ 二级 `CLOCK_SKEW` | `check-b2w-refund > deposit not yet finalized …`、`alerts > B4 …` |
| B5 | 回滚恢复快照后，重新打开恢复点之后才判定的 W2B / 存款退款项（源在 WANTOS，可能已成孤块）；其他已判定项不重开 | `pause-reorg-replay > B5 …`、`… B5/M36 …` |
| B6 | 启动断言：每个回答的 RPC `eth_chainId` 必须等于配置（且每链 ≥ `minRpcAgreement` 个已验证），两链 USDT `decimals` 必须相等，否则拒绝启动 | `startup` ×4 |
| B7 | 测试：落在 `latest − 5` 内的 WANTOS 事件不摄取 | `check-w2b > B7 …`（杀死 M35） |
| B8 | 删除 Telegram / 心跳草稿适配器；`main.ts` 未接签名器时拒绝启动（`--dry-run` 除外，`startupGuard`）；状态文件 fsync 后 rename，并保留 `.bak`、主文件损坏时回退 | `misc > B8 …`、`state-alerts > B8 …` |

## 0b. GATE2 第 2 轮修复（v3）摘要

| 项 | 修复 | 回归测试 |
|---|---|---|
| A-1 | 并集里每条日志算 `confirmed`：同一位置只有一个版本、且 ≥ `minRpcAgreement` 个 RPC 报告（1 对 1 平局 = 未确认，不再让主 RPC 版本获胜）。**未确认日志只允许建核对项和告警**，不改累计值、增发累计、存款区块索引（且首次确认写入后不覆盖）、最大编号、解除暂停标记、时间锁操作删除；`RefundCancelled` / `DepositRefundCancelled` 不再删核对项（由 Verifier 共识读判断是否撤回）；区块 hash 与共识不一致的日志（滞后在旧分叉的 RPC）直接丢弃；各块 hash/时间戳并发共识读；分歧按区块段汇总成一条告警 | `rpc-hardening-r2 > POC-A/B/C`（各含对照组）、`… stale fork …` |
| A-2 | 核对项在宽限期结束后第一次暂缓 / 无法判定时写 `blindAt`；有 `blindAt` 的项**任何解除暂停都不能确认它**，不符必暂停；BSC `Released` 的核对项 `executableAt = 事件时间`，宽限期一过仍判不了即一级 `CHECK_OVERDUE` | `rpc-hardening-r2 > POC-D`；`pause-reorg-replay > A3 boundary (R25/R26)` |
| A-3 | 告警按通道分别投递、分别排队：只重发失败的通道；一级告警在**所有通道**都送达后才登记 24h 重复；重复告警发送失败同样入队 | `state-alerts > A-3 …`（含 R32 / R33）、`alerts > A-3 / R12 …` |
| B1 | 游标既没前进也没追平超过 `cursorStallSeconds`（默认 600 s）→ 一级 `CURSOR_STUCK`；示例配置每链 3 个 RPC | `rpc-hardening > B1 …` |
| B2 | 自己的暂停交易已上链但第二个 RPC 未确认时，60 s 冷却期内只重读不重发；`PAUSE_FAILED` 写明「自己的交易已上链」；回执超时时 txHash 仍保留在结果里 | `pauser > B2 …` ×2 |
| B3 | 每通道积压 > 3 条时恢复后合并为一条 `ALERT_BACKLOG`（级别取最严重的），每通道上限 500 条并记录丢弃数 | `state-alerts > B3 …` |
| B4 | 脱敏：任意 ≥64 位 hex 串（不再依赖单词边界）、URL 之外的 `x-api-key` / `api_key` / `apikey` / `token` / `secret` / `password`；结构化告警字段不脱敏 | `redact > B4 …` ×3 |
| B5 | 启动与运行期：服务错误 chainId 或 decimals 与多数不符的 RPC **剔除**并发一级 `RPC_MISCONFIGURED`；只有剩余验证通过的 RPC 少于 `minRpcAgreement` 才拒绝启动 | `startup > B5 …` ×2、`R21 …` |
| B6 | 从 `.bak` 恢复状态时发二级 `STATE_RESTORED_FROM_BACKUP` | `startup > B6 …` |
| B8 | 区块时间戳 / hash 共识读并发；漏报分歧按区块段汇总（随 A-1 提交） | — |
| 变异补测 | R02/R34（块 hash / 时间戳共识）、R31（向前补查共识）、R05/R06（安全头取最小、WANTOS 头法定数）、R13（区段整体回滚）、R09（上链 ≠ 已确认）、R16（裸 Bearer）、R19（时钟落后） | `rpc-hardening-r2 > single-RPC protections …`、`pauser > R09 …`、`redact > R16 …`、`alerts > R19 …` |

**运维要求（新增）**：每条链至少配 **3 个**独立 RPC（`minRpcAgreement = 2`）。共识读要求「≥2 一致且无任何不同答案」，所以只配 2 个时坏 1 个就会失明（`CURSOR_STUCK` 一级），配 3 个时坏 1 个仍会因「有不同答案」而暂缓——见 R11。

## 0c. GATE2 第 3 轮修复（最终）摘要 —— 负责人拍板「共识规则折中」

**共识规则（折中）**：
- **暂停决定严格**：Verifier 三步读、块 hash / 时间戳读仍要求「≥ `minRpcAgreement` 一致且无任何不同答案」。
- **活性读**（安全头、停滞检测）取「第 `minRpcAgreement` 大」：至少 minAgree 个 RPC 担保；单个落后 RPC 钉不住、单个超前 RPC 拉不动，2 个合谋才行（与共识读的信任假设一致）。
- **不自动剔除 RPC**（启动时的错链 / decimals 不符除外，见 B5）：每个 RPC 有连续异议计数，连续 ≥ `rpcDissentThreshold`（默认 5）次与多数不同 → 一级 `RPC_DISSENTING`，点名该 RPC 标签与最近一次分歧（已脱敏），条件消除后自动结案。

| 项 | 修复 | 回归测试（`test/integration/rpc-hardening-r3.test.ts`） |
|---|---|---|
| A-1 | 日志确认按**不同 RPC 数**（每个版本记 RPC 标签集合），单个 RPC 响应内的重复条目不计数并告警 | POC-M1、POC-M2 |
| A-2 | 安全头取第 minAgree 大；安全头本身超过 `cursorStallSeconds` 不前进也算 `CURSOR_STUCK`；各 RPC 高度差 > `maxLagBlocks` → 二级 `RPC_LAGGING` | POC-E（断言调整见 §7 偏差 P13）、`a head that does not move…`、MA19 |
| B-1 | 先剔除块 hash 与共识不符的版本，再计算确认 | POC-J（两种 RPC 顺序，含 MA03）、MA02/MA04 |
| 折中规则 | 连续异议计数 + `RPC_DISSENTING`（一级，自动结案）；`RPC_DISAGREE` 详情列出未确认日志（R12，便于手工对账） | `consensus compromise …` |
| S-2 | 向前补查 Unpaused：≥ minAgree 个 RPC 报告同一条即采用（看不到不算异议，仍受 blindAt 约束）；否则发 `RPC_DISAGREE` | POC-L |
| S-3 | 处理未确认日志时产生的告警一律并入该区段的二级 `RPC_DISAGREE`（`foldedAlerts`），不再一级轰炸；状态类一级告警（`CURSOR_STUCK`、`CHECK_OVERDUE`、`RPC_MISCONFIGURED` 法定数、`RELAYER_UNREACHABLE`、`RPC_DISSENTING`）条件消除时自动结案 | POC-G、`CURSOR_STUCK closes…`、`CHECK_OVERDUE closes…` |
| S-4 | 未确认的 `CallScheduled` 不建时间锁操作、不发一级 | POC-F、MA07/MA08 |
| S-5 | `rewind()` 用共识判断快照是否仍在主链，判不了当非主链（向全量重放收敛）；二级 `STATE_REWOUND` 报告恢复点 | `S-5 / MA23` |
| S-6 | 删掉无读者的 `maxOrderId` / `maxDepositNonce` | — |
| 补测试 | MA06/MA20（无法判定路径写 blindAt、发 CHECK_OVERDUE）、MA30、MA33、MA09 | `mutation gaps …` |

**运维规程（新增 / 强调）**
1. 每条链**至少 3 个**独立 RPC，`minRpcAgreement = 2`。
2. 收到一级 `RPC_DISSENTING`：人工确认该 RPC 是否故障 / 被篡改，确认后从配置中剔除并重启监控；监控不会自动剔除。
3. 一级告警的确认入口（ack）**必须由 PR-10 提供**（例如管理后台按钮或命令）；PR-7 中只有状态类一级告警会在条件消除时自动结案，事件类一级告警（自动暂停、时间锁提议、角色变化、回滚…）在 ack 前每 24h 重复。
4. **「删除状态文件全量重放」会清空已判定集合（decided）**：重放时旧的不符事件会被重新核对；若补扫期间某项先被判为暂缓 / 无法判定（写入 blindAt），之前的解除暂停就不再能确认它，监控会**再次暂停**。恢复时须按「先吊销可疑付款钥匙 → 取消可疑排队项 → 再解除暂停」处理，必要时等补扫追平后再解除。

**Backlog（本 PR 不做）**：Verifier 存在性检查对落后节点改为「弃权」而非「不存在」（建议 6，见 POC-E2：一个只在回执上落后的 RPC 会让核对暂缓，由 `CHECK_OVERDUE` / `RPC_DISSENTING` 一级兜底）；`checkFutureVoid` / `checkLegacyNonces` / `checkGas` / `checkParams` / `checkClockSkew` 仍走单 RPC（只影响二级，噪声级，建议 8）。

## 0d. GATE2 第 4 轮（有限复审）修复

| 项 | 修复 | 回归测试（`test/integration/rpc-hardening-r4.test.ts`） |
|---|---|---|
| A-α | 区分两种未确认日志：(a) 上报的 RPC 少于 minAgree（单个说谎者可伪造）→ 保持折叠进二级 `RPC_DISAGREE`、不建 op；(b) ≥ minAgree 个 RPC 上报但内容有分歧（单个说谎者伪造不出来，"attested"）→ 不改状态、不建时间锁 op，但其一级含义以**一级 `EVENT_CONTESTED`** 发出（列出各版本与上报者） | ① RoleRevoked 被改 topics → 一级；② CallScheduled 被改 data → 一级且无 op；③ POC-F/G 仍无一级 |
| 1 | 回滚重开已判定项时同时重新武装其 `autopause:` 键，再次自动暂停会再发 `AUTO_PAUSE` | `item 1 …` |
| 2 | 异议改为最近 20 次记录的滑动窗口（窗口内 ≥ `rpcDissentThreshold` 次异议即点名）；报错 / null / 空 getLogs 结果为中性，不算同意，停滞节点不会靠「一起看不到东西」清零 | `item 2 …`（停滞节点 10 tick 内被点名，诚实节点不被点名） |
| M5 | 测试：区段失败后从同一游标重试，区段内的 Released 最终建核对 | `M5 …` |

**Backlog（本 PR 不做）**：B-2 全部 RPC 都说谎时 pending 无上限；B-4 越界区块号的日志；B-5 配置里重复 URL（同一节点被当成两个 RPC）。

下文各节已按 v2 更新。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `packages/watcher/src/watcher.ts` | 主循环 `tick()`：WANTOS 回滚检查 → 两链推进游标并处理事件 → §9.1 到期核对 → 时间锁提醒 → 周期任务（§9.2 对账、心跳、gas、旧地址 nonce、受控集合）→ 快照 + 落盘 |
| `src/verifier.ts` | §9.1 四类核对的独立复核：目标事件存在、未被取消、源链事实成立，**每一步都在全部 RPC 上分别计算、要求 ≥2 一致且无矛盾** |
| `src/pauser.ts` | PAUSER：`PauseOnlySigner`（类型 + 运行时双重限制只能发 `pause()`）、`PauseExecutor`（幂等、`EnforcedPause` = 成功、重试） |
| `src/rpc.ts` | `MultiRpc`：`all`（全部 RPC，用于并集摄取与最小安全头）、`consensus`（条件 ②）、`primary`（只用于无安全含义的读：gas、nonce、参数、时钟比对） |
| `src/redact.ts` | 错误文本脱敏（B3） |
| `src/alerts.ts` | 三级告警码表、`AlertManager`（去重、一级 24h 重复直到 ack、三级日报）、`MemoryAlertSink` / `LogAlertSink` / `MultiAlertSink`（真实通道 PR-10 实现） |
| `src/heartbeat.ts` | `Heartbeat` 接口、`MemoryHeartbeat`、`RelayerProbe` 接口 |
| `src/state.ts` / `src/types.ts` | 持久化状态（单 JSON 文件，临时文件 + rename 原子替换）与类型 |
| `src/config.ts` | 配置解析与校验；受控集合 JSON 解析 |
| `src/events.ts` | 事件解码、`computeEventKey`（与 PR1-NOTES §5.2 逐字一致，有测试对照合约）、时间锁调用解码 |
| `src/wiring.ts` | 生产装配：每个 URL 一个独立 viem client、`multiRpcPauseReader`、`viemRawTxSender`（适配器，只能被 `PauseOnlySigner` 包裹） |
| `src/main.ts` | 服务器 B 入口（测试不覆盖、本 PR 未运行）。**签名器 / 告警通道 / 心跳通道故意未接**：没有签名器时拒绝启动，`--dry-run` 才能运行（暂停会以 `PAUSE_FAILED` 一级失败），告警输出到 stdout + `alerts.jsonl`；PR-10 接 KMS 签名器与真实通道 |
| `config/watcher.example.json` | 配置示例：RPC 全是 `*.example.invalid` 占位；桥 / 时间锁 / 钱包地址为占位；只出现 DESIGN 中的主网地址（USDT、旧金库、旧付款程序） |
| `config/controlled-set.example.json` | 附录 A 受控集合（22 条），可加载 |
| `test/helpers/harness.ts` | 两条本地 anvil（BSC 本地 chainId 5600、`--slots-in-an-epoch 1` 使 `finalized = latest − 2`；WANTOS 本地 13500）+ 用 `out/*.json` 字节码按 §5.1 nonce 0/1/2 部署两链（地址相同）+ EIP-712 白名单批次 |
| `test/unit/*`、`test/integration/*` | 166 个测试，见 §0、§0b、§8 |

依赖：只依赖 `@bridge/abi` 与 `viem`；**不依赖 `@bridge/relayer`，不读付款程序数据库**。

另：（总控统一并入基线时会丢弃本条）cherry-pick 了 lane-3 的 `fix(abi): emit 'as const' on the same line`（382b76f，与 lane-3 的 8ad1069 内容相同）——原生成文件 `]` 与 `as const;` 分两行，vitest/oxc 无法导入 `@bridge/abi`。

## 2. 运行模型

每个 `tick()`（`main.ts` 每 5 秒一次）：

1. **flushDaily**：跨 UTC 日时发出前一日的三级日报。
2. **WANTOS 回滚检查（§9.1-5 / §6.2）**：在全部 RPC 上取游标区块的 hash；≥2 一致且与游标不同 → 一级 `WANTOS_REORG` + **暂停两条链** + 回退到最近一个仍在主链上的状态快照（找不到则从 `startBlock` 全量重放）。RPC 意见不一 → 二级 `RPC_DISAGREE`，本轮不推进 WANTOS、不暂停。
3. **推进游标**：安全头 = 各 RPC 的最小值——BSC 取 `finalized`（回答的 RPC 少于 `minRpcAgreement` → 二级 `BSC_NO_FINALIZED`，等待）；WANTOS 取 `latest − confirmations`（默认 6）。按 `maxBlockRange` 分段，**在每个 RPC 上**各做一次 `eth_getLogs` 并取并集（桥 + 时间锁全部事件；USDT `Transfer` 中 from=0x0 / 旧地址 / 受控地址；旧合约地址发出的任何日志），按 (区块, logIndex) 顺序处理，段尾写入游标 `{number, hash, timestamp}`。失败的段下轮按游标重试（断线补扫）。
4. **§9.1 到期核对**（见 §3）。
5. **时间锁提醒**：每个未执行未取消的提议在可执行前 24h、6h 各一次。
6. **周期任务**：对账（默认每小时）、心跳（每 5 分钟）、gas / 旧地址 nonce / 受控集合（每 5 分钟）。
7. 一级告警 24h 重复；保存快照（最多 16 个）；原子落盘。

## 3. §9.1 实时核对

### 3.1 四类核对（`targetChain` = 被核对事件所在链 = 不符时唯一暂停的链）

| # | 被核对事件 | 源链事实（在**监控自己的源链游标区块**读取） | 宽限期结束（`decideAt`） | 不符时 |
|---|---|---|---|---|
| 1 | BSC `Released`、`ReleaseQueued` | WANTOS `orders(srcEventNonce)`：存在且 `user == to`、`amount == amount` | 事件时间 + 5 分钟 | 暂停 BSC |
| 2 | WANTOS `ReleaseQueued`（B2W） | BSC `deposits(nonce)` 存在且金额一致；该区块 `Deposited(nonce)` 的 `wantosRecipient == to`（**编号、收款人、金额三项**） | `executableAt − 3 分钟` | 暂停 WANTOS；告警附「先吊销被怀疑的付款钥匙 → 取消可疑排队项 → 再解除暂停」 |
| 3 | WANTOS `RefundRequested` | BSC `payouts(computeEventKey(WANTOS链ID, WANTOS桥, orderId)).status == Voided`（key 由 orderId 推导，不用事件里的 key） | `executableAt − 2 小时` | 暂停 WANTOS |
| 4 | BSC `DepositRefundRequested` | WANTOS `payouts(computeEventKey(BSC链ID, BSC桥, nonce)).status == Voided` | `executableAt − 2 小时`（规格未写，取与退款相同，见 §6 P2） | 暂停 BSC |

良性结论（直接结案、不告警）：源事实成立；或目标已被取消——排队项已 `Voided`、退款已撤回（订单不再是 Refunding）、存款退款已撤回。`RefundCancelled` / `DepositRefundCancelled` 在摄取时即移除对应待核对项。

### 3.2 防误暂停三条件（缺一不暂停）

1. **监控自己的源链进度已越过目标交易**：源链游标区块的时间戳 ≥ 目标事件区块时间戳（合法的源事件必然早于目标事件）；否则二级 `CHECK_DEFERRED`（每项一次），继续等待。
2. **至少两个 RPC 结果一致**：`Verifier` 对「目标事件存在」「目标未被取消」「源链事实」三步分别在**全部** RPC 上计算，要求 ≥ `minRpcAgreement`（≥2，配置强制）个相同且**没有任何不同答案**；否则二级 `RPC_DISAGREE`，不暂停，下轮再试。≥2 个 RPC 一致认为目标事件不存在（主 RPC 数据错误或已回滚）→ 丢弃该项并二级告警。
3. **已过宽限期**：见上表 `decideAt`；时间由注入的 `clock`（生产为系统时钟）判断。

### 3.3 解除暂停与循环暂停

- 摄取到 `Unpaused` → 记录 `lastUnpaused[chain] = {区块, 区块时间}`。判定不符时先用**共识读**向前补查（从游标到本轮安全头，不读未 finalized / 未确认区块）。
- 只有「事件区块 ≤ 解除区块」**且**「解除区块时间 ≥ 该事件 `decideAt`」（负责人解除时该事件已过宽限期、监控本可报警）→ 只发二级 `MISMATCH_ACKNOWLEDGED`，结案，不暂停；宽限期内发生的无关暂停 / 解除不再「确认」可疑事件（A3）；之后的新事件照常暂停。
- 已判定的核对项记入 `meta.decided`（不随回滚快照回退），重放 / 回退不会重复判定。
- 测试覆盖：同一状态文件的重放、停机前的旧状态文件重放、解除早于判定。

### 3.4 自动暂停

- `PauseExecutor.pause(chain)`：`paused()` 为多 RPC 共识读（不一致 = 未知）。共识为已暂停 → 成功不发交易；否则发送 `pause()`；之后无论交易上链、回执失败，还是 `EnforcedPause()`（`0xd93c0665`，PR1-NOTES §5.11a-3）回滚，**都要再经 ≥2 RPC 确认 `paused()==true` 才算成功**（A2）；其他失败按 `pauseRetry` 重试，仍失败 → 一级 `PAUSE_FAILED`，核对项保留待下轮重试。
- 成功 → 一级 `AUTO_PAUSE`（含原因、观测值、处置建议）。
- `PauseOnlySigner`：只接受 `pauseCall(bridge)` 产生的品牌类型；运行时再校验 calldata **严格等于** `0x8456cb59`、无额外字段（如 value）、目标是配置的桥地址。任何不符抛 `PauseGuardError`，交易不会到达底层发送器（测试验证 nonce 未变）。

### 3.5 增发（§9.1-6，决定 14）

WANTOS-USDT `Transfer(from = 0x0)`：按**毛额**累加到 `mintTotal`（持久化，跨重启、暂停不清零；只因链回滚回退孤块）。累计 ≤ `mintAlertThreshold` → 二级 `MINT`；超过 → 一级 `MINT_EXCESS`（「增发过量」）。**任何情况下都不暂停**。BSC 侧代币的增发不计。

## 4. §9.2 余额对账（默认每小时）

在两链游标区块用全部 RPC 一致读取 `balanceOf(桥)`、`params()`、`dailyUsed(currentDay())`：

```
WANTOS 应有 = ΣFunded + ΣBridgeOut − ΣReleased(B2W) − ΣRefunded − ΣWithdrawn
BSC   应有 = ΣFunded + ΣDeposited − ΣReleased − ΣDepositRefunded − ΣWithdrawn − ΣLegacyPaid
```

- 余额 + 容差 < 应有 → 二级 `RECONCILE_SHORTFALL`（不暂停）。余额 > 应有 → 差额作为「未登记入账」进三级日报（`RECONCILE_SURPLUS`），不告警（例如负责人直接转入的启动资金，决定 9）。RPC 不一致 → 二级 `RECONCILE_FAILED`。
- 累计值由监控自己从 `startBlock` 起累加并持久化（**`startBlock` 必须是桥代理的部署区块**，否则应有值偏小，只会表现为「多出」）。
- 储备：BSC 余额 < `dailyCap`/2 → 一级 `RESERVE_CRITICAL`；< `dailyCap` → 二级 `RESERVE_LOW`（"1 天用量" = `dailyCap`，§5.5）。WANTOS 余额 < `wantosLowBalanceWei`（未配置时取 `b2wDailyCap`）→ 二级 `WANTOS_BALANCE_LOW`。
- 当日用量 ≥ 70%（`dailyCapReportRatioBps`）→ 三级日报 `DAILY_CAP_70`（BSC 用 `dailyCap`，WANTOS 用 `b2wDailyCap`）。
- 跨链参数一致性（§5.5）：BSC `perAddrDailyCap ≥ WANTOS w2bPerAddrDailyCap`、BSC `maxDepositPerTx ≤ WANTOS b2wDailyCap`（按两链代币 `decimals` 归一）→ 不符二级 `PARAMS_INCONSISTENT`；在每次对账和每次 `ParamsUpdated` 后检查。

## 5. §9.3 告警码表

| 级别 | 码 | 触发 |
|---|---|---|
| 一 | `AUTO_PAUSE` | 自动暂停（含链上已暂停的情况） |
| 一 | `PAUSE_FAILED` | 暂停重试后仍失败 |
| 一 | `TIMELOCK_PROPOSED` | 新的时间锁提议（`CallScheduled`，同一 id 的批量合并为一条，逐条解码函数名与参数） |
| 一 | `KEY_CHANGE` | `RoleGranted` / `RoleRevoked`（暂停钥匙吊销除外）/ `RoleAdminChanged`、白名单钱包交接开始 / 取消 / 完成、白名单钱包恢复开始 / 取消、管理钱包交接开始 / 完成、管理钱包恢复开始 / 取消（**含启动恢复**），两条链的桥和时间锁 |
| 一 | `RESERVE_CRITICAL` | BSC 储备不足 0.5 天 |
| 一 | `RELAYER_UNREACHABLE` | `RelayerProbe` 报失联（接口；付款程序自身的心跳与告警由 PR-3 负责） |
| 一 | `WANTOS_REORG` | WANTOS 游标区块 hash 变化 |
| 一 | `MINT_EXCESS` | 增发累计超过阈值（不暂停） |
| 二 | `PAUSED` / `UNPAUSED` | 链上暂停 / 解除暂停 |
| 二 | `PAUSER_REVOKED` | 暂停钥匙被吊销 |
| 二 | `UPGRADE_EXECUTED` | `Upgraded` |
| 二 | `MINT` | 增发（累计未超阈值） |
| 二 | `CONTROLLED_SET_CHANGED` | 受控集合文件变更（列出增删） |
| 二 | `PARAMS_INCONSISTENT` / `PARAMS_UPDATED` / `SUPPLY_CEILING_UPDATED` | 跨链参数不一致 / 参数或时间锁延迟变更 / supplyCeiling 变更 |
| 二 | `RESERVE_LOW` / `WANTOS_BALANCE_LOW` | 储备不足 1 天 / WANTOS 桥余额偏低 |
| 二 | `INDEX_LAG` / `WANTOS_STALLED` / `BSC_NO_FINALIZED` / `RPC_UNREACHABLE` | 监控落后 / 出块停滞 / 取不到 finalized / RPC 不可达 |
| 二 | `RPC_DISAGREE` / `CHECK_DEFERRED` / `MISMATCH_ACKNOWLEDGED` | 条件 ② 不满足或各 RPC 返回的事件不一致 / 条件 ① 不满足 / 已被负责人解除暂停确认的旧事件不符 |
| 一 | `CHECK_OVERDUE` | 待核对项到目标可执行时间仍暂缓或 RPC 分歧（B4，不暂停） |
| 二 | `CLOCK_SKEW` | 系统时钟与 BSC 最新块时间偏差 > 60 s（B4） |
| 二 | `RECONCILE_SHORTFALL` / `RECONCILE_FAILED` | 对账短缺 / 对账失败 |
| 二 | `GAS_LOW` | 两个钱包或暂停钥匙 gas 不足（`gasWatch`，两链分别配置） |
| 二 | `LEGACY_ACTIVITY` | 旧金库 `0x8dFd` / 旧付款程序 `0x9dab`（及其他配置的旧地址）：USDT 转入 / 转出、合约发出日志、EOA nonce 增加 |
| 二 | `CONTROLLED_FUNDS_MOVED` | 受控地址的 WANTOS-USDT 转入 / 转出 |
| 二 | `WHITELIST_FROZEN` / `VOID_FUTURE_SOURCE` / `WITHDRAWN` / `TIMELOCK_REMINDER` / `TIMELOCK_CANCELLED` / `HEARTBEAT_FAILED` | 冻结 / 解冻；作废了尚不存在的来源编号（PR1-NOTES §5.11a-2）；储备提取已执行；时间锁 24h / 6h 提醒；提议被取消；心跳报到失败 |
| 三 | `DAILY_REPORT` | 每 UTC 日一份：`WHITELIST_BATCH`（地址数、`listHash`、nonce、本链交易哈希——两链各一条）、`EMERGENCY_REMOVAL`、`DAILY_CAP_70`、`RELEASE_QUEUED`、`REFUND_REQUESTED`、`DEPOSIT_REFUND_REQUESTED`、`SOURCE_VOIDED`、`LEGACY_PAID`、`RECONCILE_SURPLUS` |

所有基于事件的告警以 `链:txHash:logIndex` 去重（回滚重放不会重复推送）；状态类告警（落后、停滞、gas、失联）在条件恢复后重新武装。

## 6. 配置项（`config/watcher.example.json`）

| 键 | 说明 |
|---|---|
| `minRpcAgreement` | 条件 ② 的阈值，**必须 ≥ 2**；每条链的 `rpcUrls` 数量必须 ≥ 它 |
| `chains.<bsc|wantos>.chainId / rpcUrls / bridge / timelock / token / startBlock` | 链参数；`startBlock` = 桥代理部署区块 |
| `chains.*.head` | BSC `{kind:"finalized"}`；WANTOS `{kind:"confirmations", confirmations: 6}`（§6.2） |
| `chains.*.maxBlockRange` / `maxLagBlocks`、`maxRangesPerTick` | 每段 getLogs 区块数 / 落后告警阈值 / 每轮最多处理段数 |
| `grace` | `w2bSeconds`=300、`b2wBeforeEtaSeconds`=180、`refundBeforeExecSeconds`=7200、`depositRefundBeforeExecSeconds`=7200 |
| `mintAlertThreshold` | 增发一级阈值（wei；1 万 × 10^18） |
| `reconcile` | `intervalSeconds`（3600）、`toleranceWei`（每链）、`wantosLowBalanceWei`（null = 用 `b2wDailyCap`） |
| `heartbeatIntervalSeconds` / `gasCheckIntervalSeconds` / `wantosStallSeconds` / `maxClockSkewSeconds` | 300 / 300 / 60 / 60 |
| `pauseRetry` | `attempts` / `backoffMs` |
| `timelockRemindersSeconds` | `[86400, 21600]` |
| `dailyCapReportRatioBps` | 7000 |
| `gasWatch[]` | `{chain, address, label, minWei}`：管理钱包、白名单钱包、暂停钥匙（两链） |
| `legacyAddresses[]` | `{chain, address, label}`：`0x8dFd`（WANTOS）、`0x9dab`（两链）、`0xec6e`（BSC） |
| `controlledSetFile` | 受控集合 JSON（`{entries:[{address,label}]}`，附录 A 示例） |

秘密不进配置：暂停钥匙在 `RawTxSender` 适配器后（KMS），告警 / 心跳令牌按名字引用。

## 7. 偏差、待决与事件名对照

### 7.1 偏差（保守实现，未改 17 条决定）

| # | 偏差 / 解释 | 依据 | 理由 |
|---|---|---|---|
| P1 | 条件 ① 用「源链游标区块时间戳 ≥ 目标事件区块时间戳」实现 | §9.1 | 源事件不存在时无法用"源交易高度"比较；合法源事件必然早于目标事件 |
| P2 | 存款退款（核对 4）的宽限期取「可执行前 2 小时」 | §9.1 只列了三个宽限期 | 与订单退款对称 |
| P3 | 条件 ② 要求 ≥2 一致**且无任何不同答案**（出错的 RPC 不计） | §9.1 | 最保守：任何分歧都不暂停 |
| P4 | 核对 1 中「旧单补付批次」：合约的 `payLegacyBatch` 只发 `LegacyPaid`，不发 `Released`，所以 `Released`/`ReleaseQueued` 不会属于旧单批次；`LegacyPaid` 只计入对账与日报，不做 §9.1 核对（它只能经时间锁执行，已有一级提议推送） | §9.1、§10、PR1-NOTES §5.10 | 以实际 ABI 为准 |
| P5 | `RoleRevoked(PAUSER_ROLE)` 归二级 `PAUSER_REVOKED`（§9.3 二级明列"吊销暂停钥匙"），其他角色变化一级 | §9.3 一级"任何角色变化"与二级"吊销暂停钥匙"重叠 | 明列条目优先；其余角色变化取一级 |
| P6 | 核对 1 也覆盖 `executeRelease` 发出的 `Released`（同一 eventKey 会核对两次，结论相同）；如果负责人未取消可疑排队项就解除暂停，之后执行时的 `Released` 是新事件，会再次暂停 | §9.1 处置顺序 | 强化"先取消可疑项再解除暂停" |
| P7 | 已排队项在判定时已被作废（`Voided`）、退款 / 存款退款已撤回 → 视为良性结案 | §9.1 | 被取消的可疑项不再有风险 |
| P8 | 金额比较为原始 wei 相等（两链 USDT 都按 18 位小数假设）；跨链参数比较按 `decimals` 归一 | §5.5 | 若两链小数位不同，付款程序与监控需同时引入换算，见待决 Q3 |
| P9 | `RoleAdminChanged`、时间锁 `MinDelayChange` 也推送（一级 / 二级） | §9.3 | 角色与治理参数变化宁可多报 |
| P10 | WANTOS 侧 `Released`（B2W 执行）不单独核对（排队时已核对） | §9.1 只列 `ReleaseQueued` | 按规格；见风险 R3 |
| P11 | 回滚处理：暂停两链后，自动回退到最近一个游标仍在主链上的状态快照并重新摄取（快照 16 个；都不在主链则从 `startBlock` 重放）；告警去重不回退；`meta.decided` 不回退，**但恢复点之后判定的 W2B / 存款退款项会重新打开**（其源在 WANTOS，可能已成孤块，B5） | §6.2 | 孤块事件不计入；源事件被回滚掉的付款会被重新核对 |
| P13 | POC-E 回归测试的断言由「暂停 或 CURSOR_STUCK / INDEX_LAG」改为「游标越过冻结高度 + `RPC_LAGGING` + 暂停或一级（CURSOR_STUCK / CHECK_OVERDUE / RPC_DISSENTING）」：冻结节点对回执返回 null，按严格规则 Verifier 暂缓，不会自动暂停（建议 6 在 backlog） | §9.1 条件 ② | 暂停决定保持严格 |
| P12 | 受控地址资金动作只监控 WANTOS-USDT 的 `Transfer`；旧地址额外监控 nonce（EOA 发交易）和合约日志；原生币转账未监控 | §9.3 | 避免全块扫描；见风险 R5 |

### 7.2 待决

| # | 问题 | 当前实现 |
|---|---|---|
| ~~Q1~~ | 已按总控决定收紧（A3）：解除暂停只确认解除时已过宽限期的事件 | — |
| Q2 | 告警通道（Telegram / 短信 / 电话）与心跳服务选型（§14-3） | 只有接口（`AlertSink` / `Heartbeat`）+ 内存 / 日志实现；草稿适配器已删（B8），真实实现在 PR-10 |
| Q3 | 两链 USDT 小数位是否都为 18 | 原始值相等比较 |
| Q4 | 付款程序存活探测的方式（HTTP 健康端点？） | `RelayerProbe` 接口，未接 |
| Q5 | WANTOS `confirmations` 是否沿用付款程序的 6 | 默认 6，可配 |
| ~~Q6~~ | 已拍板折中（§0c）：暂停决定严格，活性读取第 minAgree 大，连续异议点名不自动剔除 | — |

### 7.3 与 PR1-NOTES 事件名的对照

实际 ABI 与 PR1-NOTES §5.10 / §5.9 一致：监控处理的全部事件名都在 ABI 中（用脚本逐一核对过）。

| 规格用语（DESIGN / 任务书） | 合约实际事件 |
|---|---|
| `Released` / `ReleaseQueued` | `Released(eventKey, srcEventNonce, to, amount)`、`ReleaseQueued(eventKey, srcEventNonce, to, amount, executableAt)`；`release()` 只发 `Released` |
| `BridgeOut` | `BridgeOut(orderId, user, amount)` |
| `Deposited` | `Deposited(nonce, from, wantosRecipient, amount)` |
| `RefundRequested` | `RefundRequested(orderId, eventKey, user, amount, executableAt)`（取消：`RefundCancelled`，执行：`Refunded`） |
| `DepositRefundRequested` | `DepositRefundRequested(nonce, eventKey, from, amount, executableAt)`（`DepositRefundCancelled` / `DepositRefunded`） |
| 旧单补付 `LegacyPaid` / `payLegacyBatch` | `LegacyPaid(oldKey, to, amount)` |
| `executeRefund` / `executeDepositRefund`（§9.2） | `Refunded` / `DepositRefunded` |
| `withdraw`（§9.2） | `Withdrawn(to, amount)` |
| `Funded` | `Funded(from, amount)` |
| 时间锁提议 | OZ `CallScheduled(id, index, target, value, data, predecessor, delay)`；执行 `CallExecuted`；取消 `Cancelled`；`CallSalt` / `ProposalRecorded` 忽略 |
| 交接 / 恢复 | 桥：`WhitelistManagerTransferStarted/Cancelled`、`WhitelistManagerChanged`、`WhitelistRecoveryStarted/Cancelled`；时间锁：`AdminTransferStarted`、`AdminTransferred`、`AdminRecoveryStarted/Cancelled` |
| 受控集合 / 白名单日报 | `WhitelistBatchApplied`、`WhitelistEmergencyRemoval`（`WhitelistUpdated`、`WhitelistNonceInvalidated` 未单独推送） |

**发现的不一致**：
1. 规格"BSC `Released`/`ReleaseQueued` … 或属于旧单补付批次"——合约里旧单补付不发 `Released`，该豁免条件在实现上不存在（P4）。
2. `@bridge/abi` 生成文件的 `as const` 换行问题（见 §1，已 cherry-pick lane-3 的修复）。
3. 根 `package.json` 的 `"packageManager": "pnpm@10"` 不是合法 semver，corepack 的 `pnpm` 垫片拒绝运行；本 lane 用缓存的 pnpm 10.34.5 直接执行。未改根配置（ts-workspace 的范围），建议改为 `pnpm@10.34.5` 之类的完整版本号。

## 8. 测试（DH L2）

`pnpm -r typecheck` 通过；`pnpm -r test`：**17 个文件 / 166 个测试全部通过**（约 4 秒，两条本地 anvil）。变异重跑结果见 GATE2 第 2、3 次与最终报告。

覆盖率（`vitest run --coverage`，`src/main.ts`、`src/index.ts` 除外）：语句 94.98%、分支 85.6%、函数 99.41%、行 96.55%。核心逻辑：`watcher.ts` 行 95.1% / 语句 94.3%，`verifier.ts` 行 98.6% / 语句 92.4%，`pauser.ts` 行 100% / 语句 93.9%，`rpc.ts` 100%，`alerts.ts` 100%。

红灯验证：每个模块先写测试并确认因模块缺失而红；关键防线另做了变异验证（去掉后测试变红）：宽限期判断、条件 ① 时间戳比较（原测试未能抓住，已改测试后变红）、条件 ② 分歧判断（单元测试抓住）、解除暂停确认、回滚检测、B2W 收款人比较、退款 Voided 比较、增发分级、PAUSER 运行时守卫、"目标事件不存在"判定。

| 验收项 | 测试（文件 > 名称） |
|---|---|
| §9.1-1 正例 | `check-w2b > positive: matching Released (small) and ReleaseQueued (large) raise nothing and pause nothing` |
| §9.1-1 反例（伪造 `Released`，付款钥匙直接调合约；宽限期内不停、过后停 BSC、不停 WANTOS） | `check-w2b > negative: a forged Released with no source event pauses BSC only after the grace period` |
| §9.1-1 地址 / 金额不符 | `check-w2b > negative: wrong amount, and wrong address, each pause BSC` |
| §9.1-1 `ReleaseQueued` 反例 + 已作废良性 | `check-w2b > negative via ReleaseQueued: …` |
| 条件 ① 监控落后不暂停 | `check-w2b > does not pause while the watcher's WANTOS view is behind the payout`、`check-b2w-refund > deposit not yet finalized on BSC → deferred, not paused` |
| 条件 ② 两 RPC 不一致不暂停 | `check-w2b > does not pause when two RPCs disagree`、`check-w2b > drops a check when ≥2 RPCs agree the target event does not exist`、`config-rpc > MultiRpc consensus …` |
| §9.1-2 正例 | `check-b2w-refund > check 2: B2W > positive: matching deposit → no pause, even after eta − 3 min` |
| §9.1-2 编号 / 收款人 / 金额各错一项（宽限期内不停、过后停 WANTOS、提示先取消） | `check-b2w-refund > check 2: B2W > negative: wrong number / wrong recipient / wrong amount …`（3 个） |
| §9.1-3 正例 / 反例（exec−2h 前不停、之后停） / 撤回 | `check-b2w-refund > check 3 > positive / negative / a refund cancelled before the decision is dropped` |
| §9.1-4 正例 / 反例 / 撤回 | `check-b2w-refund > check 4 > positive / negative / a deposit refund cancelled …` |
| eventKey 推导与合约一致 | `check-b2w-refund > local eventKey derivation equals the contracts'` |
| §9.1-5 回滚 → 暂停两链（一级） | `pause-reorg-replay > WANTOS block-hash change → level-1 alert and both chains paused; state rewound and re-ingested` |
| §9.1-6 增发小额二级 / 超阈值一级 / 不暂停 / 持久化 | `mint-reconcile > mint: small → level-2 …`、`mint over the threshold with bridges running → still no pause`、`state-alerts > levels follow DESIGN §9.3` |
| 解除暂停后不循环暂停（旧事件 = 解除时已过宽限期）；宽限期内的无关解除不确认可疑事件；新事件才暂停 | `pause-reorg-replay > after the owner unpauses, the old event never re-pauses …`、`… POC1: an unrelated pause + unpause INSIDE the grace window …`、`… an unpause not yet under the safe head …` |
| 已暂停再 `pause()` 回滚 `EnforcedPause` = 成功 | `pause-reorg-replay > PAUSER key on a local chain > pause() on an already-paused bridge reverts EnforcedPause on chain …`、`pauser > treats an EnforcedPause revert … / is idempotent …` |
| PAUSER 只能发 `pause()` | `pauser > rejects any other function, extra calldata, value-bearing shapes, or another target`、`pause-reorg-replay > can send pause() and nothing else; a rejected call never reaches the chain` |
| 暂停失败重试 + 升级告警 | `pauser > retries transient failures …`、`pause-reorg-replay > a revoked PAUSER key fails to pause → PAUSE_FAILED level 1 …` |
| 游标补扫（停机 → 产生事件 → 重启补上） | `pause-reorg-replay > cursor catch-up …` |
| BSC 取不到 finalized → 等待 + 二级 | `pause-reorg-replay > BSC finalized unavailable …` |
| §9.2 正常 / 多出不报警 / 短缺告警 | `mint-reconcile > reconciliation: exact balance → nothing; unregistered surplus …`、`… a shortfall beyond tolerance → level-2 alert (no pause)` |
| §9.2 储备 0.5 天一级 / 1 天二级 / WANTOS 偏低 | `mint-reconcile > reserves: …` |
| 一级：时间锁提议（含批量）、角色 / 交接 / 恢复、失联、重复 24h | `alerts > timelock: new proposal …`、`alerts > timelock batch proposal …`、`alerts > key / handover / recovery changes …`、`alerts > heartbeat every 5 minutes …`、`alerts > level-1 alerts repeat after 24h until acknowledged` |
| 二级：暂停 / 解除、吊销暂停钥匙、升级、提取、参数不一致、作废未来编号、冻结、gas、旧地址、受控地址、受控集合变更、落后 / 停滞、心跳失败 | `alerts > pause / unpause / freeze / params …`、`alerts > key / handover …`（PAUSER_REVOKED）、`alerts > timelock batch …`（UPGRADE_EXECUTED / WITHDRAWN）、`alerts > gas below threshold …`、`alerts > legacy vault / relayer activity …`、`alerts > WANTOS block production stall and index lag …` |
| 三级日报（白名单批次两链哈希、紧急移除、70%、排队 / 退款 / 作废、旧单补付） | `alerts > whitelist batches, emergency removals and queue/void summaries go to the level-3 daily report`、`mint-reconcile > daily report: BSC used ≥ 70% …`、`alerts > timelock batch …`（LEGACY_PAID）、`state-alerts > collects level-3 entries …` |
| 入口无签名器拒绝启动；状态文件 .bak 回退；告警失败入 outbox；错误脱敏 | `misc > B8 …`、`state-alerts > B8 … / B2 …`、`redact > …` |

## 9. 运维手册草稿（服务器 B）

**部署前**
1. 服务器 B 与服务器 A 不同机器、不同云账户；不放付款程序的任何凭据与数据库连接。
2. **至少 3 个**独立 RPC / 链（WANTOS 建议：自建节点 + 两个其他节点；BSC：三个不同服务商），`minRpcAgreement = 2`；配错链的 RPC 会被自动剔除并一级告警。
3. 暂停钥匙：两条链各一把，经 KMS 适配器实现 `RawTxSender`，只交给 `PauseOnlySigner`；每条链 gas 备足并加入 `gasWatch`。
4. 填 `startBlock` = 两链桥代理的部署区块；`legacyAddresses`、`controlledSetFile` 按负责人确认的清单。
5. 外部心跳服务：超时（建议 10 分钟）直接电话 / 短信负责人。告警通道接一级电话 + 短信、二级即时消息、三级日报。

**启动**：`tsx src/main.ts --config <path>`（建议 systemd，`Restart=always`）；本 PR 中只能 `--dry-run`。启动时校验每个 RPC 的 chainId 与两链代币 decimals，不符拒绝启动。状态文件：`<dataDir>/state.json`（上一版本 `state.json.bak`，主文件损坏时自动回退）；告警流水：`<dataDir>/alerts.jsonl`（错误信息已脱敏）。

**重放 / 重建**：状态中的累计值、待核对项、时间锁提议都可从链上重建。停服务 → 备份并删除 `state.json` → 启动，会从 `startBlock` 全量重放（已判定集合也会清空：重放到的旧不符事件若早于最近一次 `Unpaused` 只告警；若晚于则会再次暂停，属预期——说明确有未处理的可疑事件）。不要手改 `state.json`。

**误暂停 / 自动暂停后的处置顺序（§9.1、§11）**
1. 看一级告警详情：`reason`、`observed`、`check`（交易哈希、编号、金额）。
2. 确认可疑 → **先吊销被怀疑的付款钥匙**（管理钱包 `revokeKey(RELAYER_ROLE, 地址)`，两链各自判断）。
3. **取消可疑排队项**：`cancelRelease` / `voidSource`（管理钱包或白名单钱包），B2W 可疑项在 WANTOS 上取消；可疑退款用 `cancelRefund` / `cancelDepositRefund`。
4. **再解除暂停**（管理钱包或白名单钱包 `unpause`，每条链 1 次）。监控把 `Unpaused` 视为此前事件已确认，不会再为它们暂停。
5. 若确认为误报（例如 RPC 数据错误）：直接解除暂停，并检查 RPC 配置。
6. 经时间锁补发新付款钥匙（48h）。

**WANTOS 链维护**：任何升级、rollback、换二进制之前**先暂停桥**（§6.2）；维护后监控会因 hash 变化再次暂停两链并推一级，确认后解除即可。

**暂停钥匙被吊销 / 丢失**：监控的暂停会以 `PAUSE_FAILED` 一级告警失败；由管理钱包或白名单钱包手动暂停；经时间锁补发新暂停钥匙后更新 `RawTxSender` 适配器与 `gasWatch`。

## 10. 自查发现但未修的风险

| # | 风险 | 说明 / 建议 |
|---|---|---|
| ~~R1~~ | 已修（A3） | — |
| R2 | 源链进度落后（条件 ①）或 RPC 分歧（条件 ②）持续到 B2W `eta` 时，可疑入账可能被执行 | 三条件缺一不暂停是规格要求；此时有二级 `CHECK_DEFERRED` / `RPC_DISAGREE` + `INDEX_LAG`，到 eta 时升级为一级 `CHECK_OVERDUE`（B4），负责人需人工判断；B2W 损失受 `b2wDailyCap` 约束 |
| R3 | 被确认后放过的 WANTOS 可疑排队项被执行时（`Released`），WANTOS 侧不再核对（P10） | 按规格；若要加，WANTOS `Released` 也可建核对项 |
| R4 | `meta.decided`、`meta.alertKeys` 只增不减；快照每份含完整累计状态 | 桥的业务量下增长很慢；后续可按时间修剪 |
| R5 | 受控 / 旧地址的原生币转账、BSC 侧受控地址未监控（P12） | 需要逐块扫交易或第三方索引；与 PR-3/PR-4 的自建索引共享会违背"完全独立"，建议另行决定 |
| R6 | 宽限期判断依赖服务器 B 系统时钟 | 部署时启用 NTP；时钟大幅偏快只会提前判定（仍需条件 ①②），偏慢会推迟 |
| R7 | `main.ts` 未接签名器与通道：没有 `--dry-run` 时拒绝启动；dry-run 下暂停一定失败（一级 `PAUSE_FAILED`） | 有意为之（本 PR 禁止接真实服务）；PR-10 接入前不得作为生产监控 |
| R9 | 并集摄取：单个 RPC 伪造的事件会进入累计值（对账表现为短缺告警）并建核对项（由逐笔存在性共识过滤，不会误暂停）；单个 RPC 漏报会触发 `RPC_DISAGREE` | 宁可多报；累计值偏差会在对账中暴露 |
| R10 | 时钟偏差只告警（`CLOCK_SKEW`），不自动校正 | 部署启用 NTP |
| R11 | 暂停相关的共识读仍要求全体回答者一致：一个持续异议的 RPC 会让对应区段或核对项暂缓，由 `CURSOR_STUCK` / `CHECK_OVERDUE` / `RPC_DISSENTING` 一级告警兜底，人工剔除 | 折中规则已定（§0c） |
| R12 | 未确认的日志不进累计值：某个 RPC 长期漏报时，真实事件只被核对、不被计入，对账会出现「多出」或「短缺」告警（同时有 `RPC_DISAGREE`） | 按 A-1 要求；修复 RPC 后可删状态文件全量重放 |
| R13 | 变异 R14（区段回滚不恢复 newOps）、R29（B5 不看恢复时间点）为等价变异：前者的残留 id 在下一次处理时因对应提议已回滚而被跳过，重试时会重新登记；后者被多删的已判定项，其日志都在恢复点游标之前，不会再被摄取 | 不加测试 |
| R8 | 对账在游标区块读状态，要求 RPC 保留近期状态（非归档节点一般 128 块以内够用）；BSC 公共节点对 `eth_getLogs` 区间有限制 | `maxBlockRange` 可调小；`startBlock` 远早于当前高度的首次同步需要支持历史日志的节点 |
