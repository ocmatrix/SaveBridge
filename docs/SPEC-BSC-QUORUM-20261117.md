# 付款程序 BSC 侧"任一发现、两家确认"改造

状态：定稿
版本：第二版（已按独立审查修订），2026-11-17 用户定稿
仓库/工作树：/Volumes/Projects/SaveBridge-bscconf　基线：origin/main 03495bc（分支 spec-bsc-confirm-20261117）

## 目标

- 用户原话："入金跨链，只要有一个节点，扫到交易，可以再拿哈希值去其他节点单笔确认即可。所有确认都要两个节点扫链确认"；"你这个设计就有点脆弱了……公共节点都能查到的事情，结果被你拦住了"。
- 可观察的结果：
  1. 付款程序配 3 个不同服务商的 BSC 节点时，任意 1 个节点完全不可用（报错、Key 停用、403），入金在最终确认后照常检测并放款，出金照常确认完成。
  2. 任意 1 个节点漏掉某段区块的日志，只要另一个节点扫到，这笔存入照常入库，并由至少 2 个节点按交易哈希核对回执后才算确认。
  3. 任何节点给出矛盾数据，或一个已同步到该高度的节点查不到别家报告的交易，程序停下并告警，不放款，不前移游标。
  4. 存入不会被悄悄漏掉：金库合约记录的存入总数与已入库的存入编号对不上时，不前移游标并发一级告警。
  5. BSC 扫描连续 30 分钟没有推进时发一级告警；任意一家节点掉线时发带节点名的二级告警。
  6. 监控和付款程序共用 BSC 服务商时，只允许共用明确列出的服务商，不再靠占位值骗过检查。

## 侦查证据

- E1 [已核实] BSC 最终确认块要求"每个节点都答"：`ok.length < this.o.readers.length` 即告警并等待 — `packages/relayer/src/chain/bscScanner.ts:46`
- E2 [已核实] 取区块哈希时任一节点返回空就整体失败 — `packages/relayer/src/chain/bscScanner.ts:62`
- E3 [已核实] 存入日志要求所有节点的日志集合逐条完全一致，否则 RPC_MISMATCH 并等待；随后只取第一个节点的结果入库 — `packages/relayer/src/chain/bscScanner.ts:106`、`packages/relayer/src/chain/bscScanner.ts:110`
- E4 [已核实] 游标与入库在同一个数据库事务里写 — `packages/relayer/src/chain/bscScanner.ts:118`
- E5 [已核实] 入库对同一事件幂等（`insertDetected` 用 `on conflict (event_key) do nothing`）— `packages/relayer/src/orders.ts:87`
- E6 [已核实] WANTOS 一侧：主节点扫日志，再按交易哈希到其他节点核对回执；回执需 status 成功、区块哈希相同、含同一条日志。**回执为空即判 mismatch，只有抛错才跳过不计票** — `packages/relayer/src/chain/wantosScanner.ts:55`、`packages/relayer/src/chain/wantosScanner.ts:65`、`packages/relayer/src/chain/wantosScanner.ts:71`、`packages/relayer/src/chain/wantosScanner.ts:74`、`packages/relayer/src/chain/wantosScanner.ts:77`
- E7 [已核实] 节点接口有按哈希取回执 `getTransactionReceipt`；日志唯一标识 `logId` 含交易哈希、序号、地址、topics、data、区块哈希，**不含区块号** — `packages/relayer/src/chain/reader.ts:34`、`packages/relayer/src/chain/reader.ts:41`
- E8 [已核实] 出金是否完成按"最终确认块上的 payouts 状态"判断，只用一个客户端读；BSC 这个客户端是单一写节点 — `packages/relayer/src/processor.ts:124`、`packages/relayer/src/processor.ts:128`、`packages/relayer/src/relayer.ts:77`、`packages/relayer/src/bootstrap.ts:223`
- E9 [已核实] `finalPayout` 有 4 个调用方：`settleFromFinal`、`evaluateAndSubmit`、`settleSubmitted`、`handleRejected`。其中 `evaluateAndSubmit` 拿到 null 后不是等待，而是接着用写节点读 latest 并可能发交易 — `packages/relayer/src/processor.ts:156`、`packages/relayer/src/processor.ts:326`、`packages/relayer/src/processor.ts:332`、`packages/relayer/src/processor.ts:364`、`packages/relayer/src/processor.ts:445`
- E10 [已核实] 处理器取 BSC 最终确认块用的就是 E1 的函数 — `packages/relayer/src/relayer.ts:120`、`packages/relayer/src/processor.ts:75`
- E11 [已核实] `payout(eventKey, { blockNumber })` 支持按指定区块读 — `packages/relayer/src/chain/bridges.ts:66`
- E12 [已核实] 心跳每轮都打，与扫描是否推进无关 — `packages/relayer/src/relayer.ts:198`、`packages/relayer/src/heartbeat.ts:29`
- E13 [已核实] 告警级别表 `ALERT_LEVEL`：`BSC_FINALIZED_UNAVAILABLE` 2 级、`BSC_REORG` 1 级；告警种类由它的键决定；告警按 key 去重 15 分钟 — `packages/relayer/src/alerts.ts:21`、`packages/relayer/src/alerts.ts:9`、`packages/relayer/src/alerts.ts:38`、`packages/relayer/src/bootstrap.ts:176`
- E14 [已核实] 现有测试要求旧行为：一个节点无最终确认块 → 等待；两家日志不一致 → 等待；少于 2 个节点 → 拒绝构造；"取两家中较低的最终确认高度" — `packages/relayer/test/scanners.test.ts:251`、`packages/relayer/test/scanners.test.ts:283`、`packages/relayer/test/scanners.test.ts:231`、`packages/relayer/test/scanners.test.ts:268`
- E15 [已核实] 假节点支持 `down`（所有方法都抛错）、`noFinalized`、`logsOverride`、`receiptOverride`；最终确认高度由整条假链共享的 `finalizedLag` 算出，不能按节点区分；现有测试用直接替换实例方法的办法模拟单方法失败（`getBlock`、`getLogs`）— `packages/relayer/test/helpers/fakeChain.ts:60`、`packages/relayer/test/helpers/fakeChain.ts:65`、`packages/relayer/test/helpers/fakeChain.ts:89`、`packages/relayer/test/scanners.test.ts:309`、`packages/relayer/test/scanners.test.ts:314`
- E16 [已核实] 独立性检查：未设 `PEER_BSC_RPC_HOSTS` 或有重叠即拒绝启动；按 `providerOf`（域名后两段）判断同一服务商；付款程序和监控都调用；独立来源计数函数 `checkIndependence` — `packages/ops/src/rpcPolicy.ts:256`、`packages/ops/src/rpcPolicy.ts:258`、`packages/ops/src/rpcPolicy.ts:262`、`packages/ops/src/rpcPolicy.ts:243`、`packages/ops/src/rpcPolicy.ts:120`、`packages/relayer/src/bootstrap.ts:74`、`packages/watcher/src/deploy.ts:164`、`packages/ops/test/rpcPolicy.test.ts:199`
- E17 [已核实] 配置只要求 BSC 节点 ≥2 个；"建议 3 个"只是警告 — `packages/relayer/src/config.ts:200`、`packages/relayer/src/bootstrap.ts:73`
- E18 [已核实] 金库合约有 `depositNonce()`（最后一个存入编号，首个为 1），`Deposited` 事件第一个索引字段就是编号；订单表有 `src_event_nonce` 并建了 `(direction, src_event_nonce)` 索引 — `contracts/src/BscVaultV2.sol:101`、`contracts/src/BscVaultV2.sol:69`、`packages/relayer/src/db/migrations.ts:15`、`packages/relayer/src/db/migrations.ts:45`
- E19 [已核实] 入库时订单直接记录日志自带的区块号 — `packages/relayer/src/chain/ingest.ts:41`
- E20 [已核实] 设计文档要求 BSC "只处理 finalized 区块"；监控要与付款程序不同服务器、独立核对每个事件 — `docs/DESIGN.md:371`、`docs/DESIGN.md:473`
- E21 [已核实] 测试里 BSC deps 由测试辅助直接构造（不经 `buildRelayerDeps`），pr9 演练工具也直接构造 — `packages/relayer/test/helpers/system.ts:123`、`packages/pr9/src/rehearse/services.ts:90`；已有接线测试替换读节点的写法 — `packages/relayer/test/faults.test.ts:358`、`packages/relayer/test/faults.test.ts:362`
- E22 [已核实] 线上付款程序（ss02 release cf87711a8e68）的 `packages/relayer/src`、`packages/ops/src` 与基线 03495bc 相同 — 命令 `git diff --stat cf87711 03495bc -- packages/relayer packages/ops` 输出只有两个测试文件
- E23 [已核实] 11 月 16 日 15:50 UTC 起付款程序停 12 小时：Ankr 返回 `API key disabled`（-32051/403），E1 因此一直等待 — 命令（ss02 只读）对 Ankr `eth_blockNumber` 输出 `message: API key disabled, json-rpc code: -32051, rest code: 403`；日志每 15 分钟 `BSC_FINALIZED_UNAVAILABLE ... unavailable on 1/2 RPCs`
- E24 [已核实] publicnode 漏掉稍早区块日志，另几家能查到 — 命令（ss02 只读）对入金 93/94 号所在 100 块区间各查 3 次：nodereal 3/3、48club 3/3、nownodes 3/3、publicnode 0/3；付款程序因此卡在 `RPC_MISMATCH ... disagree on Deposited logs in 133957158..133957257`
- E25 [已核实] 回执与 payouts 读取能力 — 命令（ss02 只读）：`nodereal payouts@fin ok, @fin-20 ok, @fin-200 ok, receipt ok`；`48club payouts@fin ok, @fin-20 ok, @fin-200 ERR, receipt ok`；`publicnode ... receipt ok`
- E26 [已核实] nownodes 公共节点会瞬时 403，几分钟后恢复 — 命令（ss02）一次 `HTTP Error 403: Forbidden`，之后 rpc3、ss02 各 `200 200 200`
- E27 [已核实] ss02 当前（2026-11-17 改后）付款程序 BSC 读节点为 NodeReal + 48.club，`PEER_BSC_RPC_HOSTS=bsc-rpc.publicnode.com` — 命令（ss02 只读）`grep -E "^(BSC_RPC|PEER)" /etc/savebridge/rpc.env`（Key 已打码）输出 `BSC_RPC_1=https://bsc-mainnet.nodereal.io/v1/<key>`、`BSC_RPC_2=https://rpc-bsc.48.club`
- E28 [已核实] 现有 BSC 扫描测试在本工作树可直接运行 — 命令 `pnpm -C packages/relayer exec vitest run test/scanners.test.ts` 输出 `Tests 23 passed (23)`

## 推理

- 根因/改动点：BSC 侧把"所有节点都必须答、且逐条相同"当成安全条件（E1、E2、E3），于是任何一家宕机或漏日志都让整条链路停下（E23、E24）。出金确认只读一家（E8、E9）。停滞没人知道，因为心跳不看扫描进度（E12）。
- 规则（统一一句话）：**发现可以靠任一节点；确认必须两家一致；有人反对就停。**
  - "确认"包括：最终确认块的高度与哈希、游标块哈希、每笔存入的回执、存入总数、出金的链上 payouts 状态。
  - **弃权**只在两种情况：该节点调用报错（网络、403、超时），或该节点自己的最终确认高度还没到被问的那个块。弃权不计票。
  - **反对**：回执区块哈希/区块号不同、回执里没有这条日志、交易失败、同一区块哈希不同、payouts 状态不同、**以及一个已同步到该高度的节点返回"没有这笔交易/这个块"**（与 WANTOS 侧 E6 一致：空即反对）。
- 安全对比（改前 vs 改后，N=3）：
  - 单家出错或作恶：改前只能让程序停；改后同样只能让程序停（它的反对票会挡住，它的伪造得不到第二票），不能放错款。
  - 两家串通伪造一笔存入：改前诚实的第三家日志不同即一票否决；改后诚实的第三家已同步到该高度却查不到这笔交易 → 记为反对 → 同样否决。两家串通的风险与改前相同。
  - 两家串通且诚实的第三家恰好不可用（报错）：改前程序停；改后两票通过。这是为"任一家挂了照样跑"付出的代价，由监控独立核对（E20）兜底；若监控与付款程序共用了这两家服务商，兜底同时失效，所以 D5 只允许共用明确列出的服务商，并把这层影响写给用户（见未决问题 3）。
  - 同一服务商的两个地址不能凑成两票：启动时要求 BSC 读节点两两属于不同服务商（D6）。
- 情况枚举：
  - 正常：三家都答且一致 → 处理。
  - 一家宕机/Key 停用：另两家确认 → 处理；发该节点的二级掉线告警。只剩一家时等待，30 分钟后一级停滞告警。
  - 一家漏日志：取并集；另一家扫到，回执由 ≥2 家确认，漏日志的节点若已同步到该高度却连回执都给不出 → 反对 → 停（这说明它不只是漏日志，而是数据有问题）；若它能给出回执只是 getLogs 漏了 → 它投赞成，入库。
  - 一家伪造日志（别家查不到）：别家已同步却查不到 → 反对 → 停并告警，告警里写明是哪家报告的、哪家反对。不放款。
  - 日志不在扫描区间内、或回执区块号与日志不符：反对 → 停（防止未最终确认的存入被提前入库，E20）。
  - 同一 `交易哈希:序号` 被两家报成不同内容：反对 → 停。
  - 只有一家答了 getLogs（另两家报错）：它扫到且被 ≥2 家回执确认的存入照样入库（满足"一个节点扫到即可"）；但游标不前移，因为"区间内没有别的存入"只有一家说了算。下一轮重扫，入库幂等（E5）。
  - 两家都漏同一条日志、第三家不可用：游标可能越过它。由 D4 的存入编号连续性检查发现：已入库编号出现缺口或少于金库 `depositNonce` 时不写游标并发一级告警（E18）。
  - 取最终确认高度用"第二高"：三家都在时，落后的那家不再拖住进度；一家虚报很高的高度不会被采用。代价：落后那家在该高度若仍在分叉上会给出不同哈希 → 短暂 RPC_MISMATCH，下一轮自愈。
  - 并发/时序：程序单线程串行；入库与游标同事务（E4）。不新增并发。
  - 重复执行：同一存入被多家扫到 → 按完整 `logId` 去重；重扫 → 入库幂等（E5）。
  - 出金：payouts 读不到两家一致时，所有调用方都不发交易、不改状态（E9 中 `evaluateAndSubmit` 必须显式处理"分歧"）。
  - 回退：切回旧版本目录并重启。
- 方案比较：
  - A（选）：抽一个小模块统一做"弃权/赞成/反对"计票，扫描、存入编号检查、出金确认都调用它，规则与 WANTOS 侧（E6）一致。
  - B：只放宽"每家都答"为"≥2 家答"，日志仍逐条一致。publicnode 式漏日志仍会卡住（E24），不满足用户要求。
  - C：多数票覆盖反对者。可用性更高，但一家作恶就能制造"2 对 1"，安全上不如 A。
- 裁剪：
  - 不加总开关：回退靠切回旧版本（几秒）。
  - 不新建数据表：停滞计时放内存，重启后重新计时。
  - 不改 WANTOS 侧（见未决问题 1）。

## 设计

### D1 新增计票小模块
- 位置：`packages/relayer/src/chain/quorum.ts`（新）
- 改成：
  - 类型 `Vote = { label: string; kind: "yes" | "no" | "abstain"; detail?: string }`；每个函数返回 `{ status: "ok" | "unavailable" | "mismatch"; votes: Vote[]; ... }`。判定：有任一 `no` → `mismatch`；否则 `yes` ≥ 2 → `ok`；否则 `unavailable`。
  - `quorumFinalized(readers)`：并行取各家 `finalized`；报错/空 → `abstain`；可用 ≥2 时高度取"第二高"`h`；再调用 `quorumBlock(readers, h, heights)`；结果附带 `heights: Map<label, bigint>`（各家自己的最终确认高度，供后续判断弃权/反对）。
  - `quorumBlock(readers, n, heights)`：并行取第 n 块；报错 → `abstain`；返回空且该家 `heights` ≥ n → `no`，否则 `abstain`；哈希不同 → `no`。
  - `confirmLog(readers, log, heights)`：并行按哈希取回执；报错 → `abstain`；为空且该家 `heights` ≥ `log.blockNumber` → `no`，为空且未同步 → `abstain`；回执 `status !== "success"`、`blockHash` 或 `blockNumber` 与日志不同、或不含 `logId` 相同的日志 → `no`；否则 `yes`。
  - `quorumPayout(views, eventKey, blockNumber)`：并行读 `payout(eventKey, { blockNumber })`；报错 → `abstain`；结果按 (status, to, amount, queuedAt) 比较，与多数不同或互相不同 → `no`；`ok` 时返回该值。
  - `quorumCall<T>(fns, eq)`：通用版本（存入总数检查用），报错弃权，值不同反对。
- 出错时：单家异常只影响它自己那一票；函数本身不发告警，由调用方根据 `votes` 发（带节点名）。
- 回退：随版本回退。
- 依据：E1, E2, E6, E7, E11, E25

### D2 BSC 扫描改为"并集发现 + 两家确认"
- 位置：`packages/relayer/src/chain/bscScanner.ts:43` `agreedFinalized`、`:60` `blockAgreed`、`:74` `scanOnce`；文件头注释 `:25` 起同步更新
- 改成：
  - `agreedFinalized()` 用 `quorumFinalized`；`unavailable` → `BSC_FINALIZED_UNAVAILABLE`（文案写明哪几家弃权）；`mismatch` → `RPC_MISMATCH`；返回 null。签名不变（E10）。同时把 `heights` 存为本轮字段，供本轮后续步骤用。
  - `blockAgreed(n)` 用 `quorumBlock`，告警沿用 `RPC_UNAVAILABLE` / `RPC_MISMATCH`。
  - 构造仍要求 `readers.length >= 2`。
  - `scanOnce()`：
    1. 最终确认块、游标块哈希校验（重组检测）、区间 `[from, to]` 计算与现在相同（`maxBlockRange`、`firstScan` 回扫不变）。
    2. 并行对每家 `getLogs(from, to)`。一家的答复只有在它自己的最终确认高度 ≥ `to` 时才计入 `answered`（否则视为未答）。
    3. 取所有成功答复中金库地址、`topics[0] === DEPOSITED_TOPIC` 的日志：区块号不在 `[from, to]` 内 → `RPC_MISMATCH` 并按"矛盾"处理（步骤 5）；按完整 `logId` 去重；同一 `交易哈希:序号` 出现不同 `logId` → 矛盾。其余按区块号、序号排序。
    4. 依次对每条调用 `confirmLog`：`ok` → 收下；`mismatch` / `unavailable` → 发对应告警（key `bsc:receipt:<交易哈希>`，文案列出发现它的节点与每家的票），把区间终点收缩到该日志所在块减一，停止处理后续日志。
    5. 若 `answered < 2`：只把已收下的日志入库，不写游标，返回 `waiting`。
    6. 否则：对（可能收缩后的）终点取哈希（终点等于最终确认块时直接用），调用 D4 的存入编号检查；检查通过才与入库在同一事务写游标（E4），收缩过则返回 `waiting`（与 WANTOS 侧一致），否则 `ok`；收缩到起点之前时不写游标、返回 `waiting`。
  - 每轮结束时，对本轮所有 `abstain` 票的节点各发一条 `BSC_RPC_DEGRADED`（2 级，key `bsc:degraded:<节点名>`，靠 E13 的 15 分钟去重限流）。
- 出错时：任何一步拿不到两家确认就等待；出现反对就停并告警。
- 回退：随版本回退。
- 依据：E1, E2, E3, E4, E5, E6, E7, E13, E19, E20, E24

### D3 出金确认改为两家确认
- 位置：`packages/relayer/src/processor.ts:124` `finalPayout` 及其调用方 `:156`、`:326`、`:364`、`:445`；`packages/relayer/src/relayer.ts:115` 附近构造处理器 `bsc` 一侧；`packages/relayer/src/bootstrap.ts:224`；`packages/relayer/test/helpers/system.ts:123`
- 改成：
  - `RelayerDeps.bsc` 增加**可选**字段 `confirmClients?: PublicClient[]`。`relayer.ts` 若该字段长度 ≥2，就为每个客户端建 `BridgeView("bsc", 客户端, vault)` 作为处理器 BSC 一侧的 `confirmViews`；未提供时保持现在的单视图行为（只供 pr9 演练工具与旧测试使用，pr9 代码不改）。
  - `bootstrap.ts` 生产路径传入 `confirmClients: c.bsc.readers`（与读节点同源，不另建数组）。`test/helpers/system.ts` 也传入两个客户端，让现有 anvil 集成测试走新路径。
  - `finalPayout(o)` 改为返回 `{ kind: "ok"; view } | { kind: "wait" } | { kind: "mismatch" }`：有 `confirmViews` 时用 `quorumPayout`，`mismatch` 发 `RPC_MISMATCH`（key `payout:<eventKey>`，文案带各家票）。
  - 四个调用方：`ok` 按原逻辑；`wait` 按原"null"逻辑；`mismatch` 一律 `return`，不发交易、不改状态。`evaluateAndSubmit`（`:326`）在 `mismatch` 时必须在读 latest、发交易之前返回。
- 出错时：分歧时不发交易；合约本身也防重复放款。
- 回退：随版本回退。
- 依据：E8, E9, E10, E11, E21, E25

### D4 存入编号连续性检查（防漏）
- 位置：`packages/relayer/src/chain/bscScanner.ts`（`scanOnce` 写游标前）；`packages/relayer/src/alerts.ts`
- 改成：
  - `ALERT_LEVEL` 新增 `BSC_DEPOSIT_GAP: 1`。
  - 写游标前做两项检查，任一不通过就不写游标、返回 `waiting`、发 `BSC_DEPOSIT_GAP`（key `bsc:gap`）：
    1. 连续性：本轮要入库的存入编号与库里已有的 B2W 编号合起来，从 1 到当前最大必须连续无缺口（只查本轮最小编号以下是否缺，用 `select count(*) ... where direction='B2W' and src_event_nonce < 本轮最小编号` 与"本轮最小编号减一"比较）。
    2. 追平时总数核对：当写入的终点等于本轮最终确认块时，用 `quorumCall` 让 ≥2 家读 `depositNonce()`（在该最终确认块上），结果必须等于"库里 B2W 最大编号（含本轮）"；读不到两家一致时不写游标（等待，不告警缺口，只发掉线告警）。
  - 告警文案写明缺的编号范围，并写处置：缺口在游标之后会自动重扫补上；缺口在游标之前需要人工把游标回拨到缺失存入所在块之前（操作写进运维手册）。
- 出错时：fail-closed，宁可不前移也不悄悄漏。
- 回退：随版本回退。
- 依据：E4, E5, E18, E25

### D5 BSC 扫描停滞一级告警
- 位置：`packages/relayer/src/alerts.ts`；`packages/relayer/src/chain/bscScanner.ts`
- 改成：
  - `ALERT_LEVEL` 新增 `BSC_SCAN_STALLED: 1`。
  - `BscScanner` 新增 `lastProgressAt`（构造时取 `now`）、`lastCursor`、常量 `STALL_ALERT_MS = 30 * 60 * 1000`。
  - **推进**定义：写入的游标严格大于 `lastCursor`，或本轮已追平（最终确认块 < 下一个起点）。推进时更新两者。
  - `scanOnce` 的**每一条返回路径**（包括最终确认块取不到的提前返回、`answered < 2`、收缩、catch 分支）在返回前都检查：未推进且 `now - lastProgressAt >= STALL_ALERT_MS` → 发 `BSC_SCAN_STALLED`（key `bsc:stalled`，文案含停滞分钟数、游标、最终确认块）。`halted`（重组）路径不发（已有 1 级 `BSC_REORG`）。
- 出错时：告警发送失败不影响扫描。
- 回退：随版本回退。
- 依据：E12, E13, E23

### D6 共用服务商白名单、读节点必须不同服务商
- 位置：`packages/ops/src/rpcPolicy.ts:256` `assertDistinctBscProviders`；`packages/relayer/src/bootstrap.ts:73`、`:74`
- 改成：
  - 新导出常量 `ALLOW_SHARED_BSC_ENV = "ALLOW_SHARED_BSC_PROVIDERS"`，值为逗号分隔的服务商（按 `providerOf` 规范化，如 `nodereal.io,48.club`）。
  - `assertDistinctBscProviders` 返回 `string[]`（警告）。重叠的服务商若全部在该名单内：不抛错，返回一条警告（列出共用的服务商）；名单外的重叠照旧拒绝启动；名单为空或未设置时行为与现在完全相同。设置了名单时，`PEER_BSC_RPC_HOSTS` 仍必须设置（只是允许与名单内的重叠）。
  - `bootstrap.ts`：把警告并入 `warnings`；另外新增硬性检查：BSC 读节点两两 `providerOf` 不同，否则抛 `RpcPolicyError` 拒绝启动（同一服务商不能凑两票）。
  - `watcher/src/deploy.ts:164` 不改代码（忽略返回值，类型兼容）；监控下次发布时随共用函数自动支持这个名单。
- 出错时：未配置名单时 fail-closed 与现在相同。
- 回退：删掉该环境变量即恢复严格检查。
- 依据：E16, E20, E27

### D7 上线配置（运维步骤，需用户授权后执行）
- 位置：ss02 `/etc/savebridge/relayer.json`、`/etc/savebridge/rpc.env`
- 改成：最终三家读节点为 **NodeReal、48.club、Alchemy**（用户 2026-11-17 定；不用 publicnode，不用已停用的 Ankr）；`bsc.rpcUrlEnvs` 增加 `"BSC_RPC_3"`；`rpc.env` 增加 `BSC_RPC_3=<Alchemy BSC 主网 HTTPS 地址>`（Key 由用户在终端里输入，不经聊天；上线前只读测试日志、finalized、回执、最终确认块上的 payouts）和 `ALLOW_SHARED_BSC_PROVIDERS=48.club,nodereal.io`，`PEER_BSC_RPC_HOSTS=rpc-bsc.48.club,public-bsc.nownodes.io,bsc-mainnet.nodereal.io`（监控实际使用的服务商）；按发布流程装新版本、重启、观察。
- 出错时：新版本启动失败以退出码 78 停住（现有行为），按回退恢复。
- 回退：软链接切回 `savebridge-cf87711a8e68`，恢复配置备份，重启。
- 依据：E17, E22, E25, E26, E27

## 文件白名单

- `packages/relayer/src/chain/quorum.ts` (新)
- `packages/relayer/src/chain/bscScanner.ts`
- `packages/relayer/src/processor.ts`
- `packages/relayer/src/relayer.ts`
- `packages/relayer/src/bootstrap.ts`
- `packages/relayer/src/alerts.ts`
- `packages/ops/src/rpcPolicy.ts`
- `packages/relayer/test/quorum.test.ts` (新)
- `packages/relayer/test/scanners.test.ts`
- `packages/relayer/test/faults.test.ts`
- `packages/relayer/test/helpers/system.ts`
- `packages/ops/test/rpcPolicy.test.ts`
- `docs/SPEC-BSC-QUORUM-20261117.md`

## 验收标准

测试中按节点区分的最终确认高度、单方法失败，均用直接替换 `FakeReader` 实例方法的办法构造（先例 `scanners.test.ts:309`、`:314`）。

### AC1 最终确认块：取第二高、一家宕机仍取得、虚报高度不被采用
- 对应：D1, D2
- 检查：`packages/relayer/test/quorum.test.ts::quorumFinalized takes the second-highest of answering readers`
- 预期：三家高度 h1>h2>h3 → 结果高度为 h2；一家虚报极高高度 → 结果为另两家中较高者，不是虚报值；一家 `down` → 两家中较低者；只剩一家可用 → `unavailable`
- 证明会红：改成"取最低"，h1>h2>h3 场景得到 h3，用例失败

### AC2 已同步节点查不到区块算反对，未同步算弃权
- 对应：D1
- 检查：`packages/relayer/test/quorum.test.ts::quorumBlock counts an empty answer from a synced reader as a no`
- 预期：第三家 `heights` ≥ n 却返回空 → `mismatch`；`heights` < n 返回空 → 另两家一致则 `ok`；任一家哈希不同 → `mismatch`
- 证明会红：把"已同步返回空"当弃权，第一种场景返回 ok，用例失败

### AC3 两家串通伪造回执被诚实第三家否决
- 对应：D1
- 检查：`packages/relayer/test/quorum.test.ts::confirmLog: two forged receipts are vetoed by a synced honest reader`
- 预期：a、b 的 `receiptOverride` 返回同一伪造回执，c 已同步且返回空 → `mismatch`；同场景 c `down` → `ok`（推理中已写明的代价）
- 证明会红：把"已同步返回空"当弃权，第一种场景返回 ok，用例失败

### AC4 回执核对：区块号、区块哈希、状态、日志都要对
- 对应：D1
- 检查：`packages/relayer/test/quorum.test.ts::confirmLog rejects receipts that disagree on block number, hash, status or log`
- 预期：真实存入三家都有 → `ok`；只有一家能给回执、其余报错 → `unavailable`；任一家回执 `blockNumber` 不同、`blockHash` 不同、`status: "reverted"`、或日志 data 不同 → `mismatch`
- 证明会红：去掉 `blockNumber` 比较，"区块号不同"场景返回 ok，用例失败

### AC5 出金状态：两家一致才算
- 对应：D1
- 检查：`packages/relayer/test/quorum.test.ts::quorumPayout requires two equal payout views`
- 预期：两家相同、第三家抛错 → `ok` 且值相同；两家状态不同 → `mismatch`；只有一家答 → `unavailable`
- 证明会红：去掉相等比较，状态不同时返回 ok，用例失败

### AC6 一家漏日志，存入照常入库
- 对应：D2
- 检查：`packages/relayer/test/scanners.test.ts::BSC scanner: a reader that omits a deposit log does not block ingestion`
- 预期：b 设 `logsOverride = () => []`（回执正常）；扫描返回 `ok`，订单数 1，游标前移到区间终点，无 `RPC_MISMATCH`
- 证明会红：恢复"日志集合必须完全一致"，返回 waiting、订单数 0，用例失败

### AC7 三家中一家宕机，入金照常；掉线有告警
- 对应：D2
- 检查：`packages/relayer/test/scanners.test.ts::BSC scanner: with three readers one being down, deposits are still ingested and the down reader is reported`
- 预期：三家，其中 c `down = true`；扫描返回 `ok`，订单数 1；`BSC_RPC_DEGRADED` 至少 1 条且文案包含 c 的节点名
- 证明会红：恢复 E1 的"每家都答"，返回 waiting，用例失败

### AC8 只有一家能确认的日志：不入库、游标停在它之前
- 对应：D2
- 检查：`packages/relayer/test/scanners.test.ts::BSC scanner: a log only one reader can confirm is held and the cursor stays before it`
- 预期：b、c 的 `getBlock` 对最终确认块之外的调用正常但 `getTransactionReceipt` 抛错（弃权），只有 a 有回执；扫描返回 `waiting`，订单数 0，游标不超过该日志所在块减一，产生 `RPC_UNAVAILABLE` 且文案包含发现它的节点名
- 证明会红：把计票门槛改成 1，订单数变成 1，用例失败

### AC9 只有一家答了 getLogs：已确认的照样入库，但游标不动
- 对应：D2
- 检查：`packages/relayer/test/scanners.test.ts::BSC scanner: with only one getLogs answer confirmed deposits are stored but the cursor is not advanced`
- 预期：三家，用替换实例方法让 b、c 的 `getLogs` 抛错（回执正常）；订单数 1；返回 `waiting`；游标仍为扫描前的值
- 证明会红：去掉 `answered < 2` 分支，游标前移，用例失败

### AC10 区间外日志、内容冲突、矛盾回执都停
- 对应：D2
- 检查：`packages/relayer/test/scanners.test.ts::BSC scanner: out-of-range logs, conflicting duplicates and contradicting receipts hold the range`
- 预期：a 的 `logsOverride` 追加一条区块号大于 `to` 的日志 → 返回 `waiting`、订单数 0、`RPC_MISMATCH`；a、b 对同一 `交易哈希:序号` 给出不同 data → 同上；b 的 `receiptOverride` 改区块哈希 → 同上
- 证明会红：去掉区间检查，第一种场景订单数为 1，用例失败

### AC11 存入编号缺口与总数不符时不前移游标
- 对应：D4
- 检查：`packages/relayer/test/scanners.test.ts::BSC scanner: a deposit-nonce gap or a depositNonce mismatch blocks the cursor with BSC_DEPOSIT_GAP`
- 预期：库里已有编号 1，本轮扫到编号 3（编号 2 被所有节点漏掉）→ 不写游标、返回 `waiting`、1 级 `BSC_DEPOSIT_GAP` 文案含"2"；追平时假节点的 `depositNonce` 返回比库里最大编号大 1 → 同样不写游标并告警
- 证明会红：去掉连续性检查，游标前移，用例失败

### AC12 停滞 30 分钟发一级告警（覆盖两条真实路径）
- 对应：D5
- 检查：`packages/relayer/test/scanners.test.ts::BSC scanner: no progress for 30 minutes raises level-1 BSC_SCAN_STALLED on every waiting path`
- 预期：路径一（两家时一家 `noFinalized`）：注入的 `now` 推进 29 分钟无告警，31 分钟有 1 条且级别为 1；路径二（`answered < 2` 一直等待）同样；游标回写（firstScan 回扫写入不大于原值）不算推进
- 证明会红：把推进定义改成"写了游标即算"，firstScan 场景不告警，用例失败；或去掉提前返回路径上的检查，路径一不告警，用例失败

### AC13 旧断言按新规则改写
- 对应：D2
- 检查：`pnpm -C packages/relayer exec vitest run test/scanners.test.ts`
- 预期：退出码 0；`:251` 改为"两家时一家无最终确认块 → 等待；三家时一家无 → 照常"；`:283` 由 AC6 取代删除；`:268` 改名并改为断言"第二高"；`:231` 保留
- 证明会红：把 D2 的并集改回"只取第一家日志"，AC6 失败，从而本命令退出码非 0

### AC14 出金接线：一家读不到照常完成，两家分歧不发交易
- 对应：D3
- 检查：`packages/relayer/test/faults.test.ts::BSC payout confirmation: one confirm client failing still settles, a disagreement sends nothing`
- 预期：按 `faults.test.ts:362` 的写法构造三个 `confirmClients`，其中一个用 Proxy 让 `call`/`readContract` 抛错 → 订单从 SUBMITTED 变为 RELEASED；改为一个客户端返回不同 payouts 状态 → 订单停在原状态、`tx_attempts` 不新增、产生 `RPC_MISMATCH`
- 证明会红：`relayer.ts` 不把 `confirmClients` 接到处理器，分歧场景不产生 `RPC_MISMATCH`，用例失败

### AC15 共用名单只放行名单内的服务商；读节点必须不同服务商
- 对应：D6
- 检查：`packages/ops/test/rpcPolicy.test.ts::ALLOW_SHARED_BSC_PROVIDERS permits only listed shared providers`
- 预期：自己用 `a.p1.io`、PEER `b.p1.io`、名单 `p1.io` → 不抛错，返回 1 条警告；名单 `p2.io` → 仍抛 `/used by both/`；未设名单 → 与现有用例相同；另有 `packages/relayer/test/faults.test.ts::bootstrap refuses two BSC readers from the same provider`（若 bootstrap 入口不便测试，改为 `rpcPolicy.test.ts` 中对新导出的检查函数断言）预期抛 `RpcPolicyError`
- 证明会红：把名单判断改成"非空即全部放行"，名单 `p2.io` 场景不抛错，用例失败

### AC16 整包类型与原有测试
- 对应：D1, D2, D3, D4, D5, D6
- 检查：`pnpm -C packages/relayer exec tsc --noEmit && pnpm -C packages/ops exec tsc --noEmit && pnpm -C packages/watcher exec tsc --noEmit && pnpm -C packages/pr9 exec tsc --noEmit && pnpm -C packages/relayer exec vitest run && pnpm -C packages/ops exec vitest run`
- 预期：退出码 0
- 证明会红：把 `confirmClients` 改成必填，pr9 的 tsc 失败

### AC17 上线后实测（人工，需授权）
- 对应：D7
- 检查：[人工] ①上线前在 ss02 只读确认三家读节点各自的 `eth_blockNumber`、finalized、最近 100 块 `getLogs` 都正常；②新版本启动后只读查看 `journalctl -u savebridge-relayer`；③观察 30 分钟的游标与告警。（"关掉一家"的演练改由 AC7、AC14 在测试中证明，不在生产上改配置演练。）
- 预期：①三家全部正常；②启动日志含共用名单警告、无 fatal、无"同一服务商"错误；③游标持续前进、无 `BSC_FINALIZED_UNAVAILABLE`、无 `BSC_DEPOSIT_GAP`
- 证明会红：若部署的是旧版本，任一家掉线时游标停止并出现 `BSC_FINALIZED_UNAVAILABLE`

## 监工清单

- 施工顺序：D1（AC1–AC5，先红后绿）→ D2（AC6–AC10、AC13）→ D4（AC11）→ D5（AC12）→ D3（AC14）→ D6（AC15）→ AC16 → 停下，等用户授权再做 D7/AC17。D6 与 D1–D5 文件不重叠，可并行。
- 越界判据：改了白名单外的文件（尤其 `wantosScanner.ts`、`packages/watcher/**`、`packages/pr9/**`、合约、`fakeChain.ts`）；引入多数票覆盖反对者；把"已同步节点返回空"当弃权；新增数据库表或迁移；新增总开关；改动告警通道或心跳机制本身。
- 完成核对：D1 → AC1–AC5；D2 → AC6–AC10、AC13；D4 → AC11；D5 → AC12；D3 → AC14；D6 → AC15；全部 → AC16；D7 → AC17。
- 必须停下问用户：任何上线、重启、改服务器配置；第三家节点与共用名单的最终选择；测试中发现需要改 WANTOS 侧、监控代码或 `fakeChain.ts`；AC16 中出现与本票无关的失败。

## 刻意不做的

- WANTOS 侧确认不改 — 缓解：它本来就是"主节点 + 核对回执、空即反对"（E6），且是自己的链 — 何时再做：用户要求时另开一票。
- 不做多数票覆盖反对者 — 缓解：分歧时停并告警，30 分钟后一级停滞告警 — 何时再做：若实践中频繁因单家分歧停摆。
- 不加总开关 — 缓解：切回旧版本几秒完成 — 何时再做：不计划。
- 停滞计时不持久化 — 缓解：重启后最多晚 30 分钟告警 — 何时再做：不计划。
- 监控代码不改 — 缓解：监控本来就是 N 选 2；下次发布时自动支持共用名单 — 何时再做：监控下次发布。
- 不在生产上做"关掉一家"的演练 — 缓解：AC7、AC14 在测试中证明 — 何时再做：用户要求且另行授权时。
- 缺口在游标之前时不自动回拨游标 — 缓解：一级告警写明处置步骤 — 何时再做：若真的发生。

## 决定记录

- 2026-11-17 用户："按你的建议，定稿"。
  - WANTOS 侧本票不改（见"刻意不做的"）。
  - 第三个 BSC 节点用 Alchemy（D7）。
  - 只允许 `48.club`、`nodereal.io` 与监控共用；用户已知晓代价：这两家同时出错或被攻击时，付款程序与监控会被同时骗过，失去监控的独立兜底。

## 未决问题

- 无

## 版本记录

- 2026-11-17 草稿
- 2026-11-17 第二版：按独立审查修订——"已同步节点返回空"改为反对（阻塞 B1）；日志区间与区块号校验（B2）；新增存入编号连续性检查 D4（B3）；出金四个调用方显式处理分歧（S1）；`confirmClients` 可选并与读节点同源、补接线测试（S2、S3）；单家掉线告警与告警带节点名（S4、S5）；读节点须不同服务商（S6）；共用开关改为名单（S7）；AC1/AC12/AC13/AC16/AC17 按审查重写（S8、S9 与建议）；按完整 logId 去重（S10）。
- 2026-11-17 定稿：用户原话"按你的建议，定稿"；未决问题 1–3 按推荐写入（WANTOS 不改、第三家 Alchemy、共用名单 48.club 与 nodereal.io）。
