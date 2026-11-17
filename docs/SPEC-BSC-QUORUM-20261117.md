# 付款程序 BSC 入金"任一发现、两家确认"（精简版）

状态：定稿
版本：第三版（精简），2026-11-17 用户定稿
仓库/工作树：/Volumes/Projects/SaveBridge-lane-bscq　基线：749b490（= origin/main 03495bc + 规范稿提交）

## 目标

- 用户原话："入金跨链，只要有一个节点，扫到交易，可以再拿哈希值去其他节点单笔确认即可。所有确认都要两个节点扫链确认"；"不要过度设计，能不改尽量不改……其实也是'简化'设计"；"好，按精简方案改，其他功能正常，不要动"。
- 可观察的结果：
  1. 付款程序配 3 个 BSC 节点时，任意 1 个节点完全不可用（报错、Key 停用、403），入金在最终确认后照常入库放款。
  2. 任意 1 个节点漏掉某段区块的日志，只要另一个节点扫到，且至少 2 个节点按交易哈希核对回执一致，这笔存入照常入库。
  3. 回执对不上（查不到、区块哈希/区块号不同、交易失败、不含这条日志）或日志不在扫描区间内：不入库、游标停在它之前、告警。
  4. 能回日志的节点不到 2 家时：已经两家确认的存入照样入库，但游标不前移（防止漏单），下一轮重扫。
  5. 其他行为（WANTOS 侧、出金、告警种类、启动检查、监控程序）一律不变。

## 侦查证据

- E1 [已核实] BSC 最终确认块要求"每个节点都答"：`ok.length < this.o.readers.length` 即告警并等待 — `packages/relayer/src/chain/bscScanner.ts:46`
- E2 [已核实] 取区块哈希时任一节点返回空就整体失败 — `packages/relayer/src/chain/bscScanner.ts:62`
- E3 [已核实] 存入日志要求所有节点的日志集合逐条完全一致，否则 RPC_MISMATCH 并等待；随后只取第一个节点的结果入库 — `packages/relayer/src/chain/bscScanner.ts:106`、`packages/relayer/src/chain/bscScanner.ts:110`
- E4 [已核实] 各节点 getLogs 用 `Promise.all` 一起等，任一家抛错整轮进 catch 发 `RPC_UNAVAILABLE`（key `bsc:scan`）— `packages/relayer/src/chain/bscScanner.ts:96`、`packages/relayer/src/chain/bscScanner.ts:123`
- E5 [已核实] 游标与入库在同一个数据库事务里写 — `packages/relayer/src/chain/bscScanner.ts:118`
- E6 [已核实] 入库对同一事件幂等（`on conflict (event_key) do nothing`）— `packages/relayer/src/orders.ts:87`
- E7 [已核实] WANTOS 一侧的现成写法：按交易哈希取回执，回执须 status 成功、区块哈希相同、含同一条日志；**回执为空即 mismatch，只有抛错才跳过不计票**；不一致时把区间终点收缩到该日志所在块减一并返回 waiting — `packages/relayer/src/chain/wantosScanner.ts:55`、`packages/relayer/src/chain/wantosScanner.ts:65`、`packages/relayer/src/chain/wantosScanner.ts:74`、`packages/relayer/src/chain/wantosScanner.ts:136`
- E8 [已核实] 节点接口有 `getTransactionReceipt`；`logId` 含交易哈希、序号、地址、topics、data、区块哈希，不含区块号 — `packages/relayer/src/chain/reader.ts:34`、`packages/relayer/src/chain/reader.ts:41`
- E9 [已核实] 现有 BSC 扫描测试：少于 2 个节点拒绝构造（`:231`）；两家时一家无最终确认块 → 等待（`:251`）；取两家中较低高度（`:268`）；两家日志不一致 → 等待（`:283`）；单家游标块为空 → 等待、单家 getLogs 抛错 → `RPC_UNAVAILABLE`（`:304`）— `packages/relayer/test/scanners.test.ts:231`、`packages/relayer/test/scanners.test.ts:251`、`packages/relayer/test/scanners.test.ts:268`、`packages/relayer/test/scanners.test.ts:283`、`packages/relayer/test/scanners.test.ts:304`
- E10 [已核实] 假节点支持 `down`、`noFinalized`、`logsOverride`、`receiptOverride`；现有测试用替换实例方法模拟单方法失败 — `packages/relayer/test/helpers/fakeChain.ts:60`、`packages/relayer/test/helpers/fakeChain.ts:65`、`packages/relayer/test/helpers/fakeChain.ts:89`、`packages/relayer/test/scanners.test.ts:309`、`packages/relayer/test/scanners.test.ts:314`
- E11 [已核实] 设计文档要求 BSC "只处理 finalized 区块" — `docs/DESIGN.md:371`
- E12 [已核实] 配置只要求 BSC 节点 ≥2 个，3 个是建议 — `packages/relayer/src/config.ts:200`、`packages/relayer/src/bootstrap.ts:73`
- E13 [已核实] 11 月 16 日 15:50 UTC 起付款程序停 12 小时：Ankr 返回 `API key disabled`，E1 因此一直等待 — 命令（ss02 只读）对 Ankr `eth_blockNumber` 输出 `API key disabled, json-rpc code: -32051`；日志 `BSC_FINALIZED_UNAVAILABLE ... unavailable on 1/2 RPCs`
- E14 [已核实] publicnode 漏掉稍早区块日志，付款程序因 E3 卡在 `RPC_MISMATCH ... disagree on Deposited logs in 133957158..133957257` — 命令（ss02 只读）对该区间各查 3 次：nodereal 3/3、48club 3/3、publicnode 0/3
- E15 [已核实] 线上付款程序（ss02 release cf87711a8e68）的 relayer 源码与基线相同 — 命令 `git diff --stat cf87711 03495bc -- packages/relayer packages/ops` 只列出两个测试文件
- E16 [已核实] ss02 现配 BSC 读节点 NodeReal + 48.club — 命令（ss02 只读）`grep -E "^BSC_RPC" /etc/savebridge/rpc.env`（Key 打码）
- E17 [已核实] 现有 BSC 扫描测试可直接运行 — 命令 `pnpm -C packages/relayer exec vitest run test/scanners.test.ts` 输出 `Tests 23 passed (23)`

## 推理

- 根因：BSC 侧把"所有节点都答、且日志逐条相同"当成安全条件（E1、E2、E3、E4），任何一家宕机或漏日志都让整条链路停下（E13、E14）。
- 规则：**发现靠任一节点；确认靠两家一致；有人反对就停。** 节点报错不计票（弃权）；回执为空或对不上算反对——与 WANTOS 侧现成写法相同（E7），不另起规则。
- 情况枚举：
  - 正常：三家一致 → 处理。
  - 一家宕机：另两家确认 → 处理。只剩一家时等待，沿用现有告警。
  - 一家漏日志：取并集，另一家扫到，回执由 ≥2 家确认 → 入库（E14 的场景）。
  - 一家伪造日志：别家给不出这笔回执（空）→ 反对 → 停并告警，不放款。
  - 同一笔被报成不同内容：内容不对的那条回执核对不过 → 停。
  - 日志区块号不在 `[from, to]`（例如未最终确认的块）：直接按反对处理（E11）。
  - 落后节点给不出回执：算反对 → 本轮停在它之前，下一轮它追上后自愈。代价是偶尔晚一轮，换来不用记各家高度。
  - 只有一家答了 getLogs：它扫到且两家回执确认的存入照样入库；游标不动，因为"区间里没有别的存入"只有一家说了算。重扫入库幂等（E6）。
  - 最终确认高度：在答复的节点中取最低（沿用现有做法，只是不再要求全部答复）。
  - 并发/重复：单线程；入库与游标同事务（E5）；按 `logId` 去重。
  - 回退：切回旧版本目录并重启。
- 方案：只改 `bscScanner.ts` 一个文件，照搬 WANTOS 侧的回执核对写法。不新建模块。
- 裁剪（第二版中删去）：计票模块、出金两家确认（合约本身防重复放款，出金当前正常）、存入编号连续检查（只防"两家同时漏同一笔且第三家挂了"，监控程序独立核对兜底）、停滞告警与单家掉线告警（节点不够用时现有告警每 15 分钟报一次）、共用服务商名单（现配置能用）。

## 设计

### D1 BSC 扫描改为"并集发现 + 两家确认"
- 位置：`packages/relayer/src/chain/bscScanner.ts:43` `agreedFinalized`、`:60` `blockAgreed`、`:74` `scanOnce`，以及 `:25`、`:39` 的注释
- 改成：
  - `agreedFinalized()`：各家取 `finalized`，报错/空的不算；答复不足 2 家 → 照旧发 `BSC_FINALIZED_UNAVAILABLE`（key 与文案格式不变）返回 null；否则取答复中最低高度，调 `blockAgreed`。签名不变。
  - `blockAgreed(n)`：各家取第 n 块，报错/空的不算；答复中哈希不全相同 → `RPC_MISMATCH`（key 不变）返回 null；答复不足 2 家 → `RPC_UNAVAILABLE`（key 不变）返回 null；否则返回该块。
  - 构造仍要求 `readers.length >= 2`。
  - `scanOnce()` 中最终确认块、游标重组检查、区间计算不变；`:96`–`:110` 替换为：
    1. 各家分别 `getLogs(from, to)`，单家抛错只算它没答（不再整轮进 catch）；记 `answered` = 答复家数。
    2. 取所有答复里金库地址、`topics[0] === DEPOSITED_TOPIC` 的日志，按 `logId` 去重，`sortLogs` 排序。
    3. 逐条核对：日志区块号不在 `[from, to]` → 反对；否则各家取回执，抛错跳过，回执为空、`status !== "success"`、`blockHash` 或 `blockNumber` 与日志不同、或不含同 `logId` 的日志 → 反对；无反对且 ≥2 家通过 → 收下。反对 → `RPC_MISMATCH`，否则（通过不足 2 家）→ `RPC_UNAVAILABLE`；key 均为 `bsc:receipt:<交易哈希>`，文案含交易哈希和区块号；然后 `to = 该日志区块号 - 1`，状态记为 `waiting`，停止处理后续日志（与 E7 相同）。
    4. `answered < 2`：在一个事务里只入库已收下的日志，不写游标，发 `RPC_UNAVAILABLE`（key `bsc:logs`，文案写明答复家数与区间），返回 `waiting`（不改 `firstScan`）。
    5. 否则：`to < from` → 返回 `waiting`；取终点块（等于最终确认块时直接用，否则 `blockAgreed(to)`，取不到返回 `waiting`）；入库与写游标同一事务（E5）；返回第 3 步记下的状态（默认 `ok`）。
- 出错时：拿不到两家确认就等待；出现反对就停并告警；不放宽到 `latest`。
- 回退：随版本回退。
- 依据：E1, E2, E3, E4, E5, E6, E7, E8, E11, E14

### D2 上线配置（运维步骤，需用户授权后执行）
- 位置：ss02 `/etc/savebridge/relayer.json`、`/etc/savebridge/rpc.env`
- 改成：三家读节点 NodeReal、48.club、Alchemy（用户 2026-11-17 定）；`bsc.rpcUrlEnvs` 加 `"BSC_RPC_3"`；`rpc.env` 加 `BSC_RPC_3=<Alchemy BSC 主网地址>`（Key 由用户在终端输入，不经聊天；上线前只读测日志、finalized、回执）；按发布流程装新版本、重启、观察。
- 出错时：新版本启动失败以退出码 78 停住（现有行为），按回退恢复。
- 回退：软链接切回 `savebridge-cf87711a8e68`，恢复配置备份，重启。
- 依据：E12, E15, E16

## 文件白名单

- `packages/relayer/src/chain/bscScanner.ts`
- `packages/relayer/test/scanners.test.ts`
- `docs/SPEC-BSC-QUORUM-20261117.md`

## 验收标准

测试中的单方法失败用替换 `FakeReader` 实例方法构造（先例 `scanners.test.ts:309`、`:314`）；三家场景在用例内另建第三个 reader 与 scanner。

### AC1 三家中一家宕机，入金照常
- 对应：D1
- 检查：`packages/relayer/test/scanners.test.ts::BSC scanner: with three readers one being down, deposits are still ingested`
- 预期：三家，c `down = true`；扫描返回 `ok`，订单数 1，游标前移到区间终点
- 证明会红：恢复 E1 的"每家都答"，返回 waiting，用例失败

### AC2 一家漏日志，存入照常入库（取代旧 `:283`）
- 对应：D1
- 检查：`packages/relayer/test/scanners.test.ts::BSC scanner: a reader that omits a deposit log does not block ingestion`
- 预期：两家，**a**（第一家）`logsOverride = () => []`（回执正常）；扫描返回 `ok`，订单数 1，无 `RPC_MISMATCH`
- 证明会红：恢复"日志集合必须完全一致"，返回 waiting、订单数 0，用例失败；改成"只取第一家日志"，订单数 0，用例失败

### AC3 只有一家能给回执：不入库、游标停在它之前
- 对应：D1
- 检查：`packages/relayer/test/scanners.test.ts::BSC scanner: a log only one reader can confirm is held and the cursor stays before it`
- 预期：三家，b、c 的 `getTransactionReceipt` 抛错；扫描返回 `waiting`，订单数 0，游标（若写入）小于该日志区块号，有 `RPC_UNAVAILABLE`
- 证明会红：把门槛 ≥2 改成 ≥1，订单数为 1，用例失败

### AC4 回执为空、回执对不上、区间外日志：都停
- 对应：D1
- 检查：`packages/relayer/test/scanners.test.ts::BSC scanner: an empty or contradicting receipt, or an out-of-range log, holds the range`
- 预期：三种场景各自独立：① b 的 `receiptOverride` 返回 null；② b 的 `receiptOverride` 改区块哈希；③ a 的 `logsOverride` 追加一条区块号大于 `to` 的存入日志。每种都：返回 `waiting`、订单数 0、有 `RPC_MISMATCH`
- 证明会红：把"回执为空"当跳过，场景①返回 ok、订单数 1，用例失败；去掉区间检查，场景③订单数为 1

### AC5 只有一家答了 getLogs：已确认的照样入库，游标不动
- 对应：D1
- 检查：`packages/relayer/test/scanners.test.ts::BSC scanner: with only one getLogs answer confirmed deposits are stored but the cursor is not advanced`
- 预期：三家，b、c 的 `getLogs` 抛错（回执正常）；订单数 1；返回 `waiting`；游标仍为扫描前的值；有 `RPC_UNAVAILABLE`
- 证明会红：去掉 `answered < 2` 分支，游标前移，用例失败

### AC6 扫描测试整文件通过，旧用例除 `:283` 外不改
- 对应：D1
- 检查：`pnpm -C packages/relayer exec vitest run test/scanners.test.ts`
- 预期：退出码 0；`git diff 749b490 -- packages/relayer/test/scanners.test.ts` 中旧用例只有 `:283` 那条被删除/替换，其余旧用例原样
- 证明会红：把 D1 的并集改回"只取第一家日志"，AC2 失败，本命令退出码非 0

### AC7 relayer 包类型检查与全部测试
- 对应：D1
- 检查：`export PATH="$HOME/.foundry/bin:$PATH"; pnpm -C packages/relayer exec tsc --noEmit && pnpm -C packages/relayer exec vitest run`
- 预期：退出码 0
- 证明会红：改动破坏类型（如 `agreedFinalized` 返回类型变化），tsc 失败

### AC8 上线后实测（人工，需授权）
- 对应：D2
- 检查：[人工] ①上线前在 ss02 只读确认三家各自 `eth_blockNumber`、finalized、最近 100 块 `getLogs` 正常；②新版本启动后只读查看 `journalctl -u savebridge-relayer`；③观察 30 分钟游标与告警
- 预期：①三家正常；②无 fatal；③游标持续前进、无 `BSC_FINALIZED_UNAVAILABLE`
- 证明会红：若部署的是旧版本，任一家掉线时游标停止并出现 `BSC_FINALIZED_UNAVAILABLE`

## 监工清单

- 施工顺序：先写 AC1–AC5 并确认红 → 实现 D1 → AC1–AC6 绿 → AC7 → 停下，等用户授权再做 D2/AC8。
- 越界判据：改了白名单外任何文件（含 `alerts.ts`、`processor.ts`、`relayer.ts`、`bootstrap.ts`、`wantosScanner.ts`、`fakeChain.ts`、`packages/ops/**`）；新增模块、告警种类、配置项、开关；改动 `:283` 以外的旧用例；多数票覆盖反对者；把回执为空当跳过。
- 完成核对：D1 → AC1–AC7；D2 → AC8。
- 必须停下问用户：任何上线、重启、改服务器配置；需要改白名单外文件；AC7 出现与本票无关的失败。

## 刻意不做的

- 出金确认不改 — 缓解：合约本身防重复放款，出金当前正常 — 何时再做：出现出金读错的实例时。
- 不做存入编号连续检查 — 缓解：游标只在 ≥2 家答复 getLogs 后前移；监控程序独立核对每个事件 — 何时再做：真发生漏单时。
- 不加停滞告警、单家掉线告警 — 缓解：节点不够用时现有告警每 15 分钟一次 — 何时再做：用户要求时。代价：三家剩两家时不报警。
- 不加共用服务商名单、不改启动检查 — 缓解：现配置能用，Alchemy 与监控节点不重叠 — 何时再做：监控下次发布时一并考虑。
- WANTOS 侧、监控程序不改 — 缓解：WANTOS 侧本来就是回执核对（E7）— 何时再做：用户要求时。
- 不做多数票覆盖反对者 — 缓解：分歧时停并告警 — 何时再做：实践中频繁因单家分歧停摆时。

## 决定记录

- 2026-11-17 用户："按你的建议，定稿"——第三个 BSC 节点用 Alchemy（D2）；WANTOS 侧不改。
- 2026-11-17 用户："不要过度设计，能不改尽量不改"；"好，按精简方案改，其他功能正常，不要动"——范围缩为只改 `bscScanner.ts`；第二版 D3–D6 与共用名单删去。

## 未决问题

- 无

## 版本记录

- 2026-11-17 草稿
- 2026-11-17 第二版：按独立审查修订（计票模块、出金两家确认、存入编号检查、停滞告警、共用名单等）。
- 2026-11-17 第二版定稿：用户原话"按你的建议，定稿"。
- 2026-11-17 第三版（精简）：用户原话"不要过度设计，能不改尽量不改……'简化'设计"，"好，按精简方案改，其他功能正常，不要动"。只保留 BSC 扫描"并集发现 + 两家回执确认 + 不足两家答 getLogs 不前移游标"；删去计票模块、D3 出金确认、D4 编号检查、D5 停滞告警、D6 共用名单与掉线告警；白名单缩为 `bscScanner.ts` 与 `scanners.test.ts`。
- 2026-11-17 第三版勘误（总控，范围不变）：施工中实测发现 AC2 让 b 漏日志时，"只取第一家日志"的改坏方式测不出（AC6 的证明会红不成立）。AC2 改为让 a（第一家）漏日志，使"只取第一家"与"必须完全一致"两种改坏方式都会让 AC2 变红。只改测试用例的构造，不改设计与白名单。
