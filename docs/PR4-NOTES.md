# PR-4 风控引擎与自建交易索引：实现说明、对齐点、参数、偏差与待定

> 依据：`docs/DESIGN.md` v0.9.4（§6.2 自建交易索引、§7 风控、§9.3 告警、§13 PR-4 验收、附录 A）、`docs/PR3-NOTES.md`（§4.1 风控接口、Q3、Q10、D3）。分支 `pr-4-risk`（叠在 `pr-3-relayer` 之上）。
> 范围：只写代码与本地测试。**未连接任何生产节点或 Blockscout 库，未发任何真实交易，未读写任何私钥。** 测试只用 PGlite、内存假链和本机 anvil（127.0.0.1）。17 条已拍板决定未改动。
> 原则：简洁、安全、壮硕；不过度封控——三条规则都只把单子送进 REVIEW，不自动拒绝、不加新的冻结路径；所有阈值可配置，默认值即 §7 目标值，以 10 月回放校准（§6）。

## 1. 文件（全部在新包 `packages/risk`）

| 文件 | 内容 |
|---|---|
| `src/config.ts` | `RiskConfig` / `RiskParams`、§7 默认值 `defaultParams(decimals)`、`parseRiskConfig` 校验 |
| `src/migrations.ts` | 索引表迁移（版本 401，写入 relayer 的 `schema_migrations`，4xx 段不与 relayer 冲突）；可重复执行 |
| `src/store.ts` | 索引行写入、游标读写、`controlled_set` 读取与增删（每次增删写 `audit_log`） |
| `src/indexer.ts` | `IndexReader` 接口 + viem 实现；`TxIndexer` 增量索引（游标 + hash、检查点、重组回退、`broken` 状态、`rewindTo` 人工恢复） |
| `src/pairs.ts` | 从工厂读取全部交易对及 USDT 所在侧（`expectCount` 防止工厂新增交易对未经审查就被追溯） |
| `src/engine.ts` | `SourceRiskEngine implements RiskEngine`：包住 PR-3 `DefaultRiskEngine`，叠加资金来源占比、10 分钟规则、同源资助规则、降级 |
| `src/alerts.ts` | 风控包自己的告警接口（`INDEX_ERROR / INDEX_REORG / INDEX_BROKEN / COMMON_FUNDER`） |
| `scripts/mutate.mjs` | 变异测试脚本：在临时副本里逐个打变异，跑单元/夹具测试，输出存活表 |
| `test/*` | 夹具单元测试（engine / indexer / config）、anvil 集成测试（e2e，跑在 PR-3 relayer 里） |

**范围外改动**：只有 `pnpm-lock.yaml`（新增工作区包必然改动）。**未改 `packages/relayer` 任何文件**（含 `src/risk.ts`）。另：本 worktree 执行了 `git submodule update --init`（lib/ 下三个子模块检出，子模块指针未变，无提交），否则 relayer 的 anvil 测试无合约产物。

## 2. 实现说明

### 2.1 自建交易索引（§6.2，PR3-NOTES Q3 的表结构）

```sql
risk_flows (tx_hash, log_index  -- -1 = 顶层原生币转账
  , block_number, block_hash, block_time, asset  -- 'USDT' | 'MG' | 'TIDE' | 'NATIVE'
  , from_addr, to_addr, tx_from, src, amount, value_usdt, primary key (tx_hash, log_index))
  -- 索引: (to_addr, block_time), (src, block_time), (block_number)
risk_swaps (tx_hash, log_index, block_number, block_hash, block_time, pair, sender, to_addr, tx_from,
  amount0_in, amount1_in, amount0_out, amount1_out)
risk_index_state (id=1, last_block, last_block_hash, last_block_time, head_block, checked_at, broken)
risk_index_checkpoints (block_number, block_hash)          -- 最近 500 个游标，用于找分叉点
alter table controlled_set add column effective_from timestamptz   -- NULL = 一直受控
```

- `src`（有效来源）：代币从 8 个交易对之一转出时（换币输出、撤流动性）= **该交易的发起人 `tx_from`**（§7「同一笔交易的发起人属于受控集合时，该笔转出视为受控」）；否则 = `from_addr`。摄取时算好，查询只按 `src` 分组。
- `value_usdt`（计入占比的价值）：只有 USDT 行有值，**不做价格折算**；交易对转出的 USDT 取同一交易里该交易对、收款人相同、紧随其后的 `Swap` 事件的 USDT 输出额（§7「按 Swap 事件里实际收到的 USDT 数额计」）；找不到 Swap（例如撤流动性）用转账额。MG/TIDE/原生币 `value_usdt = 0`。
- 原生币：只索引**成功的顶层交易**的 value（逐笔读 receipt 状态，只针对 value>0 的交易）；合约内部转原生币不索引（见待定 P3）。
- 增量：只索引到 `head − confirmations`（≥ 6，与 relayer WANTOS 扫描器一致）；每轮最多 `maxBlockRange` 个块；同一区间先删后插，**重跑幂等**；游标、行、检查点同一事务提交。
- 重组：每轮先比对游标块 hash，以及新区间首块的 `parentHash`、每条日志的 `blockHash` 与块 hash。游标 hash 变了 → 从新到旧找第一个仍在主链上的检查点，删除其后的全部行，游标回退（`INDEX_REORG` 告警）。检查点全部失效 → `broken`（`INDEX_BROKEN` 告警，每轮重复），**引擎随即对所有 W2B 返回 WAIT(index)**，直到运维 `rewindTo(block)`。日志/块 hash 不一致 → 本轮放弃、不写入、下轮重试。
- `runTick()` 永不抛出：失败发 `INDEX_ERROR`，下轮重试。
- 交易对：`loadPairsFromFactory(client, 0x31580F9B…, usdt, 8)` 从工厂读取，不手抄。

### 2.2 追溯与占比（§7）

只对 W2B（WANTOS → BSC）做；B2W 原样交给 PR-3 引擎。

- 锚点时间 t = 该订单 bridgeOut 交易里那笔 USDT 转账（用户 → 桥）的块时间（`bridgeOut` 必然 `transferFrom`，合约已核对）。窗口 `(t − 30 天, t]`。用订单时间而不是"现在"，保证同一订单反复评估结果稳定。
- **第 1 跳**：转入 X 的 USDT，`src` 在受控集合中（且 `effective_from` 为空或 ≤ 该笔时间）→ 全额受控。
- **第 2 跳**：来自非受控来源 S 的转入 v_S → 按 S 自己在同一窗口内 USDT 入账的受控占比折算：`v_S × 受控_S ÷ 全部_S`（S 的占比只看第 1 跳规则，所以总共 2 跳，第 3 跳不追）。
- 不穿透：X 自己、零地址（增发）、桥合约（B2W 放款）、配置的 `exempt`（交易所等）。它们的转入照样计入分母，但不追溯。
- 占比 = (第 1 跳 + 第 2 跳受控价值) ÷ 窗口内全部 USDT 入账；用整数基点比较：`≥ 20%` → REVIEW(freeze, `controlled_source`)；`5%～20%` → REVIEW(audit, `controlled_source`)；`< 5%` 放行。恰好 5% 为 audit，恰好 20% 为 freeze。窗口内无 USDT 入账 → 不触发。
- 受控集合在评估时读取：负责人新增地址对历史转账立即生效；`effective_from` 用于旧金库 `0x8dFd`「切换时刻 T 之后的转出」。

### 2.3 行为规则（§7）

- **10 分钟规则**（`fresh_funds`，audit）：本单金额 ≥ 500 USDT，且 X 首次收到任意资产（USDT/MG/TIDE/原生币，含 B2W 放款）的时间距 t ≤ 10 分钟。
- **同源资助**（`common_funder`，audit + `COMMON_FUNDER` 告警）：X 在 `(t−24h, t]` 内的任一来源 S（不含 X 自己、零地址、桥、`exempt`），在同一 24h 内资助过（任意资产、任意金额）的不同地址中，有 ≥ 3 个在 `(t−24h, t+24h]` 内有 W2B 订单（`orders` 表 + 其 bridgeOut 的块时间）→ REVIEW。向后多看 24h，使第 3 个出现后，前两个**尚未放款**的单子在下次评估时也进 REVIEW（"全部 REVIEW"）；已排队/已放款的兄弟单只能靠告警里的地址清单由负责人 `cancelRelease`（待定 P5）。

### 2.4 与 PR-3 引擎的组合、降级、幂等

顺序与合并（`engine.ts` 类注释）：
1. 先调 `DefaultRiskEngine`（暂停 → 两链白名单 → 金额上限 → 额度 → 储备 → 大额）。它返回 WAIT → 原样返回（链上闸门优先，且不读索引）。
2. W2B 再读索引：索引不可用/落后 → **WAIT("index")**（覆盖 AUTO、DELAY 和内层 REVIEW，绝不放松）。条件：无游标；`broken`；最近一次成功 tick 距今 > `indexStaleMs`（2 分钟）；`head − last > indexMaxLagBlocks`（600）；游标 < 订单块；订单自己的 bridgeOut 转账不在索引里；数据库异常（另发 `INDEX_ERROR`）。
3. 发现项与内层 REVIEW **合并成一个 REVIEW**：level 取最高，reason = 全部原因去重排序后用 `+` 连接（例如 `amount_limit+controlled_source+fresh_funds`）。
4. 无发现 → 内层 AUTO / DELAY。

- 幂等无副作用：引擎对数据库只读（测试比对评估前后各表行数）；唯一副作用是同源资助告警（带去重 key `common_funder:<S>`），这是 §7「并告警」的要求。
- REVIEW.reason 只进 `orders.reason`，不对外（PR-3 API 已不返回 reason）。

## 3. 与 PR-3 接口的对齐点

| PR3-NOTES §4.1 约定 | 本 PR 做法 | 测试 |
|---|---|---|
| 包住 `DefaultRiskEngine` 的链上检查 | `SourceRiskEngine({ inner: new DefaultRiskEngine(...) })`，内层 WAIT 原样返回，内层 REVIEW 合并 | `combination with the PR-3 engine` 4 条；e2e 用真实 `DefaultRiskEngine` |
| 索引不可用或落后 → WAIT("index")，不放松规则 | §2.4 第 2 点，7 种情形 | `degradation` 7 条；e2e「索引未追上 → WAITING(index)」 |
| 幂等、无副作用 | 只读；时间锚在订单块时间 | `idempotency` |
| 审核通过后同 level+reason → DELAY | 原因用固定字符串，合并后整串比对 | e2e「approved … proceeds as DELAY (queueRelease)」 |
| 不同 level/reason 使旧批准作废 | 新发现项改变 level 或 reason 串 | e2e「audit → freeze voids the approval; nothing is sent」 |
| `controlled_set` / `audit_log` 已建 | 直接使用；加 `effective_from` 列（本包迁移 401） | `controlled set store`、`effective_from` 测试 |
| Q3 自建索引由 PR-4 实现并定表结构 | §2.1 | `indexer.test.ts` 14 条 |
| Q10 `WAIT(index)` 由风控返回 | 是 | 同上 |
| `Order.srcBlockNumber` | 用于"索引是否已覆盖订单块"；为 NULL → WAIT(index) | `index has not reached the order's block` |

## 4. 接线（未做，范围外，列为上线门槛）

- `packages/relayer` 依赖不能反向依赖 `@bridge/risk`（`@bridge/risk` 依赖 relayer 的类型与 `DefaultRiskEngine`，会成环），所以**生产 `main.ts` 仍用 `DefaultRiskEngine`**。挂接点已存在：`RelayerDeps.risk`。建议 PR-9 前由一个组合入口（例如 `packages/risk/src/main.ts` 或 `apps/relayer`）构造 `TxIndexer` + `SourceRiskEngine` 并传给 `new Relayer({ ..., risk })`，同时周期调用 `indexer.runTick()`。
- 告警：`RiskAlertSink` 的 4 种告警需映射到 relayer `AlertSink`（§9.3 二级：索引落后、受控地址动作）。relayer `ALERT_LEVEL` 是封闭联合类型，加种类要改 `packages/relayer/src/alerts.ts`——本 PR 未改，留给接线时一并加（建议 `RISK_INDEX_ERROR/REORG/BROKEN` 二级、`RISK_COMMON_FUNDER` 二级）。

## 5. 参数（`defaultParams`）

| 参数 | 默认 | 来源 |
|---|---|---|
| `lookbackMs` | 30 天 | §7 |
| `freezeBps` / `auditBps` | 2000 / 500 | §7（≥20% 冻结级、5%～20% 审核级） |
| `freshWindowMs` / `freshMinAmount` | 10 分钟 / 500 × 10^decimals | §7 |
| `funderWindowMs` / `funderMinAddrs` | 24h / 3 | §7 |
| `indexStaleMs` | 2 分钟 | 本 PR（索引 tick 间隔应远小于此） |
| `indexMaxLagBlocks` | 600 | 本 PR（约几分钟出块量；PR-3 对 WAITING(index) 10 分钟告警） |
| indexer `confirmations` / `maxBlockRange` / `keepCheckpoints` | ≥6 / 配置 / 500 | §6.2 |
| `exempt` | 空 | 运维配置（交易所热钱包、空投分发等） |

**所有阈值以 10 月数据回放结果校准（§6），列为 PR-9 前验收项。**

## 6. 10 月数据回放校准计划（PR-9 前验收项）

1. 数据：从 rpc3 Blockscout 库**只读导出**（由有权限的人在服务器上执行，本 PR 不连生产）10-01～11-01 加前 30 天的 USDT/MG/TIDE Transfer、顶层原生币转账（含 tx_from、receipt 状态）、8 个交易对 Swap，转成 `FlowRow` / `SwapRow` 用 `insertFlows/insertSwaps` 灌入离线库（`src`、`value_usdt` 按 §2.1 规则计算，与索引器同一份代码）。旧桥 10 月的跨出记录转成 W2B 订单行。
2. 受控集合：附录 A 由负责人逐条确认后导入；`0x8dFd` 的 `effective_from` = 切换时刻 T（回放时用 10 月实际事件时间做假设 T）。
3. 回放：对每笔 10 月跨出按其块时间评估（内层引擎替换为常 AUTO），记录 decision。
4. 验收（§13 PR-4）：`0x2835`、`0x0b74`、`0xbdc4` 被拦；"受控地址发起的池子换币再转给白名单用户"被拦；**误报数不高于现行人工审核量**。
5. 调参：只在 `freezeBps/auditBps/freshMinAmount/funderMinAddrs/exempt` 上调；若有绕过者是"受控方转 MG/TIDE → 用户自己换成 USDT 跨出"，启用待定 P1 的按资产占比扩展。结论与最终参数写回本文件与 DESIGN §7。
6. 同时量出：慢查询（枢纽地址的第 2 跳）、索引追平耗时；必要时给第 2 跳来源数加上限。

## 7. 偏差与待定项（均取最保守且最简单的做法，均不改 17 条决定）

| # | 事项 | 当前做法 | 理由 / 后续 |
|---|---|---|---|
| P1 | MG/TIDE/原生币不计价 | 不计入占比（§7 不做价格折算）；只参与 10 分钟规则和同源资助 | 受控方转 MG 给用户、用户自己换成 USDT 跨出，不会被占比捕获（行为规则仍可能命中）。回放若见此类，扩展为"按资产占比折算 Swap 输入"（不需价格） |
| P2 | 第 2 跳窗口 | 中间地址 S 的占比也用 `(t−30d, t]`，不截止到 S→X 那笔的时间 | 更简单；会把 S 之后收到的受控资金也算进来，偏保守（多拦不少拦） |
| P3 | 合约内部原生币转账 | 不索引（无 trace 假设） | WANTOS 是否支持 `debug_trace*` 未验证；USDT 是主资产，影响有限 |
| P4 | "首次收到资金"受索引起点限制 | 起点之前的入账看不到 | 生产 `startBlock` 须早于上线 ≥ 30 天（回填），写进上线门槛 |
| P5 | 同源资助"全部 REVIEW" | 未放款的兄弟单在下次评估时进 REVIEW；已 QUEUED/RELEASED 的只在告警数据里列出 | 引擎只评估 DETECTED/WAITING/已批准 REVIEW 的单；撤销排队由负责人操作。资助判定不设金额下限，`exempt` 排除合法分发方，回放校准 |
| P6 | 合并 reason 的格式 | `a+b+c`（排序去重） | 让审批范围精确覆盖全部原因；PR-6 后台展示时按 `+` 拆分 |
| P7 | 已批准 REVIEW 遇到索引不可用 | 返回 WAIT(index) → 订单回 WAITING(index)，批准保留；索引恢复后仍同 level+reason 才按 DELAY 继续 | 降级不放松 |
| P8 | 数据库异常 | WAIT(index) + `INDEX_ERROR` | 代码缺陷也会表现为等待；PR-3 的 WAITING(index) 10 分钟超时告警兜底 |
| P9 | 10 分钟规则把 B2W 放款也算"收到资金" | 是 | 跨入后 10 分钟内 ≥500 跨出 → 审核；回放看误报 |
| P10 | 生产数据源 | 索引器走 RPC（自建节点）；Blockscout 只用于回填与交叉核对 | §6.2；回填工具随 PR-9 |
| P11 | `controlled_set.effective_from` | 由本包迁移加列 | 不改 relayer 文件；PR-6 后台需支持编辑此字段 |
| P12 | 告警种类与接线 | 见 §4 | 范围外 |
| P13 | 受控地址有资金动作（§9.3 二级）、增发接收地址告警 | 不在本 PR | 属 PR-7 监控；索引表可直接复用 |

## 8. PR-9 / PR-10 上线门槛

- PR-9 前：§6 回放完成并定稿阈值；接线（§4）完成，relayer 实际用 `SourceRiskEngine`；告警映射完成；附录 A 负责人确认并录入（含 `0x8dFd` 的 `effective_from = T`）；`loadPairsFromFactory(..., 8)` 通过；索引从上线前 ≥ 30 天回填完毕并与 Blockscout 抽样核对一致。
- PR-9 联调：WANTON 1345 上演练受控直转、经池换币、2 跳、10 分钟、同源资助、索引停摆（WAIT(index) 与 10 分钟告警）、WANTOS 回滚（INDEX_REORG / INDEX_BROKEN + `rewindTo`）。
- PR-10：灰度期每日核对 REVIEW 数量与人工审核量；索引 lag 纳入监控面板。

## 9. 测试、覆盖率与变异

- 运行：`cd packages/risk && pnpm test`（需本机 anvil/forge；e2e 只连 127.0.0.1）。`pnpm typecheck` 全仓通过。
- 测试数与覆盖率、变异结果见文末「Gate2 结果」。
- 过程说明：实现与测试在同一提交序列中完成，先写实现、后补测试（非严格 RED→GREEN）；用变异测试代替 RED 证据——每条规则的关键比较/条件被改坏后必须有测试变红。

### 9.1 规则 ↔ 测试

| 规则 | 测试（`test/engine.test.ts` 除注明外） |
|---|---|
| 受控直接转入 | `controlled source transfers directly → REVIEW(freeze)` |
| 经 Swap 转入 | `pool swap sent by a controlled address …`；`the user's own pool swap is not controlled`；indexer `pair output is valued at the Swap event's USDT out` |
| 2 跳 / 不追第 3 跳 | `2 hops: C → S → X …`；`2 hops through a pool …`；`3 hops are not traced` |
| 不穿透桥/增发/豁免 | `bridge payouts, mints and exempt sources are not traced through` |
| 占比边界 5%/20% | `boundary: controlled 499/500/1999/2000 bps` |
| 30 天窗口 / effective_from / 新增受控 | `30-day window …`；`controlled_set.effective_from …`；`adding an address to the set applies to past movements` |
| 10 分钟内跨出 ≥500 | `fresh funds: …`（9 分钟/恰好 10 分钟/10 分 1 秒/499.99…）；任意资产首笔 |
| 同源资助 3 个地址 | `one source funds 3 addresses … all REVIEW + alert`；只有 2 个；超窗口；桥/豁免/增发不算 |
| 索引落后 → WAIT | `degradation` 7 条；e2e `index not caught up → WAITING(index)` |
| 幂等 | `repeated evaluation returns the same decision and writes nothing` |
| 审核通过同 level+reason → DELAY | e2e `approved REVIEW for the same level+reason proceeds as DELAY` |
| 不同 level/reason 作废旧批准 | e2e `a new finding after approval … voids the approval` |
| 索引：重组 / broken / 幂等重跑 / 确认数 / 分段 | `test/indexer.test.ts` |

## Gate2 结果

- 测试：`packages/risk` 81 条全绿（含参数化展开：engine 42、indexer 16、config/pairs/store 19、e2e 4 条在 anvil 上跑 PR-3 relayer）。全仓 `typecheck` 通过。
- 覆盖率（v8）：语句 96.11%、分支 93.56%、函数 94.52%、行 98.6%。未覆盖：`ViemIndexReader` 的 `BlockNotFoundError` 分支（indexer.ts 54-55）、`maxBlockRange` 截断分支的一侧、`store.ts` 删受控地址时的空值分支、engine 一处告警 `.catch`。
- 变异测试（`node scripts/mutate.mjs <dir>`，在临时副本里做，跑 engine/indexer/config 测试，不含 e2e）：40 个变异，第 1 轮杀死 31 个；对 6 个真实缺口补测试后第 2 轮**杀死 37/40**。

| # | 规则 | 变异 | 结果 |
|---|---|---|---|
| 1–2 | 占比 | 冻结级/审核级 `>=` 改 `>` | 杀死 |
| 3 | 占比 | 无入账也比较（`total >= 0`） | 杀死 |
| 4 | 占比 | 忽略 `effective_from` | 杀死 |
| 5 | 占比 | 窗口起点改为闭区间 | 杀死 |
| 6 | 占比 | 窗口终点改为开区间 | 第 1 轮存活 → 补「订单同块入账计入」后杀死 |
| 7 | 占比 | 关闭第 2 跳 | 杀死 |
| 8 | 占比 | 第 2 跳不排除桥/增发/豁免 | 杀死 |
| 9 | 占比 | 第 2 跳不按比例（全额） | 杀死 |
| 10 | 占比 | 不排除自转账 | 第 1 轮存活 → 补「自转账不稀释」后杀死 |
| 11 | 占比 | 去掉 `asset = 'USDT'` 过滤 | **存活（等价）**：非 USDT 行 `value_usdt` 恒为 0 |
| 12 | 占比 | `v > cv` 改 `v >= cv` | **存活（等价）**：全受控来源进第 2 跳时贡献 `v − cv = 0` |
| 13–16 | 10 分钟 | `<=`→`<`、金额 `>=`→`>`、`min`→`max`、不截止到 t | 杀死 |
| 17–20, 22 | 同源资助 | `>=`→`>`、去掉向后 24h、不排除豁免源、不限资助时间、关闭规则 | 杀死 |
| 21 | 同源资助 | 不限 W2B 订单 | 第 1 轮存活 → 补「只算 W2B」后杀死 |
| 23–27 | 降级 | 陈旧/落后 `>`→`>=`、游标 `<`→`<=`、WAIT 时返回内层结果、忽略 `broken` | 杀死 |
| 28 | 降级 | 订单交易不在索引时继续算 | 第 1 轮存活（异常路径仍 WAIT）→ 断言「无错误告警」后杀死 |
| 29–32 | 合并 | 内层 WAIT 不短路、level 取最低、丢内层 REVIEW、reason 不排序 | 杀死 |
| 33–35, 37, 39 | 索引 | 池子输出不用 tx_from、不用 Swap 值、不扣确认数、不跳过失败交易、不查 parentHash | 杀死 |
| 36 | 索引 | 不查游标 hash | 第 1 轮存活 → 补「追平后同高度重组」后杀死 |
| 38 | 索引 | Swap 不要求在 Transfer 之后 | 第 1 轮存活 → 补「匹配紧随其后的 Swap」后杀死 |
| 40 | 索引 | 区间重跑前不删旧行 | **存活（等价）**：主键 `on conflict do nothing` + 回退时 `deleteAbove` 已保证幂等；保留为纵深防御 |
