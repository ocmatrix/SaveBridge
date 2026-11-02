# PR-8 迁移与旧单补付工具：流程、清单格式、接口对齐、偏差与待定项

> 依据：`docs/DESIGN.md` v0.9.4 §10（旧单补付）、§5（合约，以 `docs/PR1-NOTES.md` §5 与 `contracts/src/BscVaultV2.sol` 实际接口为准）、§9.2（ΣLegacyPaid 对账口径）、§13 PR-8 行。分支 `pr-8-legacy`，新包 `packages/migrate`（`@bridge/migrate`）。
> 范围：只写代码与本地测试。**未连接任何真实链或节点，未发送任何真实交易，未读写任何真实私钥。** 唯一会签名发交易的是 `drill`，它只对自己启动的本地 anvil（127.0.0.1 随机端口）使用 anvil 公开默认账户。17 条决定未改。

## 1. 流程

```
T 之前               扫描旧桥 ──▶ 补付清单（CSV + 哈希）──▶ 公开发布（公告 + 清单哈希）
                                   │
提议                管理钱包按清单 schedule 每批 payLegacyBatch（≤100 条 / 批，48h 时间锁）
                                   │
48h 内              白名单钱包：validate（清单 + 已发布哈希）→ 对每个 CallScheduled 跑 verify-call
                    任何一条不在清单里 / 收款人或金额不符 / 收不到清单 ⇒ cancel
                                   │
执行前（每批）       preflight：新金库 legacyPaid(oldKey) 仍为 false；重新读一次旧桥放款记录，确认没付过
                    有阻断项 ⇒ 不执行；取消该操作，去掉该行后换 round 重新提议
                                   │
执行                任何人 execute（提交服务代发）
                                   │
执行后              reconcile：LegacyPaid 事件逐条对清单；ΣLegacyPaid == Σ清单 时 complete
```

| 命令（`pnpm --filter @bridge/migrate cli <cmd>`） | 作用 | 是否写链 |
|---|---|---|
| `scan --source <json> \| --rpc-config <json> --cutoff T --vault --bsc-chain-id [--paid-keys] --out` | 读旧单与旧放款 → `scan-report.json`（全部旧单与状态）、`manifest.csv`、`manifest.json` | 否（只读 RPC） |
| `validate <csv> [--hash] [--rpc] [--controlled]` | 独立校验：重算 oldKey、总额、条数、重复、排序、零地址/零金额、哈希；合约地址与受控集合地址给警告 | 否 |
| `propose <csv> --hash --timelock [--batch-size] [--round] --out` | 干跑：生成每批 `schedule` / `execute` calldata、operationId、`proposals.txt` 解码视图 | 否 |
| `verify-call <csv> --hash --target --data --delay` | 白名单钱包对一个 `CallScheduled` 的核对 | 否 |
| `reconcile <csv>... --rpc --vault --from-block` | ΣLegacyPaid 对账 | 否 |
| `drill <csv>` | 本地 anvil 全流程演练 | 只写本地 anvil |

代码：`src/scan.ts`（扫描与分类）、`src/source-rpc.ts`（RPC 读取）、`src/io.ts`（离线 JSON）、`src/manifest.ts`（清单与校验器）、`src/proposal.ts`（提议与核对）、`src/reconcile.ts`（预检与对账）、`src/drill.ts`（anvil 演练）、`src/cli.ts`。

## 2. 输入

**离线 JSON**（`test/fixtures/legacy-basic.json` 为例）：

```jsonc
{ "cutoverT": 1762000000,
  "orders":  [{ "srcChainId": 13555, "txHash": "0x…", "logIndex": 3, "timestamp": 1761999000,
                "direction": "W2B", "from": "0x…", "recipient": "0x…"(可省), "amount": "100.5" }],
  "payouts": [{ "chainId": 56, "txHash": "0x…", "logIndex": 0, "to": "0x…", "amount": "100.5",
                "srcTxHash": "0x…"(可省), "srcLogIndex": 3(可省) }] }
```

- `orders`：旧桥上「用户已发起」的事件。`W2B` = 用户在 WANTOS 旧金库 `0x8dFd` 锁币、BSC 未放款；`B2W` = 用户存进 BSC 旧金库 `0xec6e`、WANTOS 未入账。
- `payouts`：旧桥做过的放款（BSC 放款或 WANTOS 入账）。旧桥若在放款事件里记了源交易，填 `srcTxHash/srcLogIndex`（精确关联）；没记的（例如只能看到旧金库转出的 `Transfer`）不填，按「同收款人 + 同金额」保守匹配。
- 金额一律是**十进制字符串**（代币单位），按 18 位小数严格换算，**不四舍五入**。

**RPC 配置**（`--rpc-config`，bigint 写成 `"123n"`）：`{ rpc: { "56": url, "13555": url }, orders: OrderEventSpec[], payouts: PayoutEventSpec[], chunk? }`。每个 spec 给出合约地址、事件签名（human-readable ABI）、区块范围、代币小数位、可选的 indexed 参数过滤（如 `{ from: 旧金库 }`），以及哪个参数是 from / recipient / amount / to / srcTxHash / srcLogIndex。旧桥事件格式不在本仓库，所以做成配置；本 PR 没有连主网。

## 3. 扫描分类（每条旧单只出现一次，按 `(srcChainId, txHash, logIndex)` 排序）

| 状态 | 条件（按此优先级） | 进清单 |
|---|---|---|
| `INVALID_AMOUNT` | 金额格式错或超过 18 位小数 | 否 |
| `INVALID_ZERO_ADDRESS` / `INVALID_ZERO_AMOUNT` | 收款人为零地址 / 金额为 0 | 否 |
| `NEW_PAID` | 新金库 `legacyPaid(oldKey)` 已为 true（`--paid-keys`） | 否 |
| `OLD_PAID` | 关联到该旧单的旧放款合计 ≥ 订单金额（收款人不同会在 note 写明） | 否 |
| `OLD_PARTIAL` | 关联旧放款合计 > 0 但 < 订单金额 | 否，人工处理 |
| `SUSPECT_PAID` | 有未关联的旧放款：收款人与金额都相同 | 否，人工处理 |
| `AFTER_T` | `timestamp ≥ T` | 否，走 T+14 天流程 |
| `PAYABLE` | 其余 | **是** |

- 收款人：`W2B` 付给旧事件里的 `recipient`（没有该字段时付给发起人）；`B2W` 退给 BSC 上的存款人 `from`（见偏差 D3）。
- 重复事件：同一 `(txHash, logIndex)` 内容完全相同 → 去重计数；内容不同 → **报错停止**（不猜）。旧放款按 `(chainId, txHash, logIndex)` 去重，重复事件不会被重复累加。
- 同一 `txHash` 的不同 `logIndex` 是不同旧单，各有各的 `oldKey`。
- 关联到不存在旧单的旧放款列入 `orphanPayouts` 报告。

## 4. 清单格式（发布物）

`oldKey = keccak256(abi.encode(bytes32 srcTxHash, uint256 srcLogIndex))`，txHash 先转小写。此编码定稿，关闭 PR1-NOTES 待决 Q2。

`manifest.csv`（UTF-8，LF，末尾换行；**清单哈希 = keccak256(整个 CSV 文本)**，表头、注释行和页脚都在哈希里）：

```
# wantos-bridge-v2 legacy payout manifest v1
# bscChainId=56
# vault=0x…(checksum)
# cutoverT=1762000000
# oldKey=keccak256(abi.encode(bytes32 srcTxHash, uint256 srcLogIndex))
# amountUnit=wei (18 decimals)
oldKey,srcChainId,srcTxHash,srcLogIndex,direction,to,amountWei,amount
0x…,56,0x…,4,B2W,0xABc…,12345678000000000000,12.345678
…
# count=5
# total=152845678000000000001
```

- 行按 `(srcChainId, srcTxHash, srcLogIndex)` 严格递增；`to` 必须是 checksum 地址；`amount` 列必须等于 `amountWei` 的十进制显示。
- 同一输入永远生成同一 CSV 与同一哈希（与输入顺序无关）。
- `manifest.json` 是同内容的 JSON 视图（含哈希），权威发布物是 CSV + 哈希。
- 校验器（`validate`）错误项：格式、oldKey 重算不符、重复 oldKey、乱序、零地址、零金额、页脚条数/总额不符、哈希与已发布值不符、oldKey 编码声明不同；**警告项**（不阻断）：收款人有合约代码（需 `--rpc`）、收款人在受控集合（`--controlled`）。

## 5. 提议

- 清单按发布顺序每 100 条切一批（`--batch-size` 可更小，>100 拒绝），**每批一个独立的时间锁操作**：`schedule(vault, 0, payLegacyBatch(oldKeys,to,amounts), 0x0, salt, 48h)`。
- `salt = keccak256(abi.encode("WANTOS-BRIDGE-V2-LEGACY", manifestHash, batchIndex, round))`：与清单哈希绑定；过期或被取消后重新提议用 `round+1`（时间锁同 id 不能再次提议，PR1-NOTES §4 第 6 条）。
- `operationId` 由工具按 OZ `hashOperation` 算出，演练里与链上 `timelock.hashOperation` 逐批比对一致。
- `proposals.txt` 是给人看的解码视图：每批条数、合计、operationId、salt，以及每行的 oldKey / 收款人 / 金额 / 来源交易。
- **白名单钱包核对**（`verifyScheduledCall` / `verify-call`）：目标必须是清单里的金库、value 0、无前置、延迟 ≥ 48h、函数必须是 `payLegacyBatch`、1～100 条、调用内无重复 oldKey，每个 `(oldKey, to, amount)` 必须与已发布清单中的同一行完全一致。不要求与工具切出的批次一一对应（重新排序或子集也接受），因为合约保证一个 oldKey 只付一次。

## 6. 执行前预检与执行后对账

- **预检**（`preflightBatch`，DESIGN §10「每批放款前再查一次旧 BSC 金库的放款记录」）：对批内每行，`legacyPaid(oldKey)` 必须为 false；重新读取的旧放款里不能有关联到该旧单的，也不能有同收款人同金额的未关联放款。有任何阻断项就不执行。
- **对账**（`reconcileLegacy` / `reconcile`）：读取金库全部 `LegacyPaid(oldKey, to, amount)`，逐条对照已发布清单（可多份，例如 T 之后的补充清单）。错误：清单外的支付、同一 oldKey 支付多次、收款人或金额不符、多份清单重复包含同一 oldKey。`complete` = 无错误 + 全部行已付 + **ΣLegacyPaid == Σ清单**。部分批次已执行时 `ok=true, complete=false`，并列出未付行。
- 口径与 PR-7 一致：PR-7 余额对账里的 `ΣLegacyPaid` 就是这些事件的金额合计（PR7-NOTES §9.2 公式），日报 `LEGACY_PAID` 同源。

## 7. 与合约接口的对齐点（`BscVaultV2.sol`）

| 合约事实 | 工具的做法 |
|---|---|
| `payLegacyBatch(bytes32[] oldKeys, address[] to, uint256[] amounts)`，仅时间锁（`onlyTimelockA`）、非暂停、无恢复 | 只生成时间锁 schedule/execute；演练验证管理钱包直接调用被 `NotTimelock` 拒绝 |
| `MAX_LEGACY_BATCH = 100`，空批 `BadBatchSize` | 切批 ≤ 100；空批与 >100 在工具里就拒绝 |
| 任一 oldKey 已付 → 整批 `LegacyAlreadyPaid` 回滚（D16） | 预检先查 `legacyPaid`；演练验证「已付行 + 新行」的整批被拒、新行仍未付 |
| 零收款人 `ZeroAddress`、零金额 `ZeroAmount` | 扫描与校验器都提前排除 |
| 收款地址不要求白名单、不占日额度 | 不检查白名单；金库须**另外**备足清单总额（§5.5 储备口径） |
| `legacyPaid(bytes32)` 视图、`LegacyPaid` 事件 | 预检与对账的唯一数据源 |
| 时间锁：48h 最小延迟、14 天过期、epoch、恢复期间不能执行、暂停时 A 类不能执行 | 延迟 < 48h 拒绝；过期 / 被取消用新 round 重提；暂停或恢复期间执行会失败，等解除后再执行（14 天内） |

## 8. 偏差

| # | 做法 | 理由 |
|---|---|---|
| D1 | oldKey 编码定为 `keccak256(abi.encode(bytes32, uint256))`，txHash 小写 | PR1-NOTES Q2 要求 PR-8 定稿；用其建议值。测试里有 `cast` 算出的对照向量 |
| D2 | 每批一个 `schedule`，不用一个 `scheduleBatch` 包多批 | 一批被取消或执行失败不影响其他批；单笔执行的 gas 有上限（100 笔转账）。「批量 schedule」理解为一次生成全部批次的 schedule |
| D3 | `B2W` 旧单（BSC 存了、WANTOS 没入账）用 `payLegacyBatch` 在 BSC 上**原路退回 USDT 给存款人** | `payLegacyBatch` 只在 BSC；WANTOS 没有旧单入账函数。退回原地址最保守 |
| D4 | 金额按旧单全额补付，不扣旧桥手续费 | 旧桥手续费规则不在仓库；见待定 Q2 |
| D5 | `OLD_PARTIAL`、`SUSPECT_PAID`、`AFTER_T` 不进清单 | 宁可人工处理，也不重复付；对账支持多份清单，人工核实后可发补充清单 |
| D6 | 时间戳 == T 视为 T 之后 | §10「T 之前未放款的列入」，取严格小于 |
| D7 | 合约收款人、受控集合收款人只给警告 | §10「收款地址不要求白名单」，由负责人判断 |

## 9. 待定项（按最保守方案实现，需负责人确认）

1. **旧桥事件格式与放款关联方式**：旧金库 `0x8dFd`（WANTOS）与 `0xec6e`（BSC）的发起事件签名、放款事件是否记录源交易。目前做成 RPC 配置；若旧放款不记源交易，只能按「同收款人 + 同金额」匹配（命中即人工处理）。
2. **旧桥手续费**：若旧桥本应扣手续费，补付金额是否扣除。当前不扣。
3. **B2W 旧单的处理**：当前退 BSC USDT 给存款人；若负责人希望改为在 WANTOS 上补入账，需要另一机制（合约没有）。
4. **T 之后存入 `0x8dFd` 的资金**（T+14 天内受理、须过 §7 来源检查、只付给存款人本人）：本工具把它们标 `AFTER_T` 排除；需 PR-4 来源检查结论后由负责人发补充清单（`reconcile` 已支持多份清单）。
5. **`0x8dFd` 在 T 之后的转出归入受控集合**：这是 PR-7 / 管理后台的配置（`legacyAddresses`、`controlledSetFile`），本 PR 不改它们；`validate --controlled` 可读同一份受控地址清单给警告。
6. **新金库 `legacyPaid` 查询**：`scan` 目前通过 `--paid-keys` 文件接收已付 oldKey（可由 `reconcile` 输出生成）；正式补充清单前应先跑 `reconcile`。
7. **旧 WANTOS-USDT 小数位**：RPC 读取时按配置的 `decimals` 换算；超过 18 位小数且有非零尾数的金额标 `INVALID_AMOUNT`，不四舍五入。

## 10. 上线前需要负责人提供

1. **切换时刻 T**（UTC 秒）及公告文本（含清单哈希、清单下载地址、T+14 天规则）。
2. 旧桥地址确认：WANTOS 旧金库 `0x8dFd39E98f478688A41Cdbe40bc544d672F0A9E3`、BSC 旧金库 `0xeC6E356a2E986D6A9b103217B9d215c8a6F37139`、旧付款程序 `0x9dAb17a9…6E90`；两链的扫描起止区块。
3. 旧桥事件的 ABI（或旧合约源码 / 已验证合约），以及放款记录来源（旧金库事件、`Transfer`、旧付款程序交易）。
4. 新金库地址、时间锁地址、BSC chainId（主网 56）。
5. 补付总额对应的 BSC 储备（在 §5.5 首批储备之外另备）。
6. 两条链各一个可信只读 RPC（扫描与预检用；建议与 PR-7 一样多 RPC 交叉，当前版本单 RPC，见待定）。

## 11. 测试

- `pnpm --filter @bridge/migrate test`：8 个文件、92 个测试；`typecheck` 通过。覆盖率（v8，`cli.ts`/`index.ts` 除外）：语句 96.6%、分支 92%、函数 100%、行 99.1%。
- 夹具 `legacy-basic.json` 覆盖：重复事件（订单与放款各一）、已放款旧单、部分放款（重复放款事件不被重复累加）、未关联放款、同一 txHash 多个 logIndex、1 wei 金额、19 位小数、零地址、零金额、T 边界、B2W、无 recipient 字段、新金库已付、孤立放款。
- 分批边界：1 / 99 / 100 / 101 / 250 条；30 条小批；>100 拒绝。
- anvil 端到端（`test/integration/drill.test.ts`）：部署 PR-1 金库 + 时间锁 → 注资 → schedule → 链上 operationId 比对 → `CallScheduled` 解码核对 → 48h 前执行被拒 → 预检 → 执行 → `legacyPaid` 全真、收款人余额、金库支出 == 清单总额 → ΣLegacyPaid 对账 complete → 同一 oldKey 再提议执行被合约以 `LegacyAlreadyPaid` 拒绝；250 条三批；部分执行与迟到旧放款被预检拦下并由白名单钱包取消；混合批整批回滚；非时间锁调用被拒。
- 变异测试：见 §12。

## 12. 变异测试（独立副本，scratchpad 拷贝，不改本 worktree）

30 个变异，28 个被杀死，2 个存活（均为等价变异）。

| id | 变异 | 结果 |
|---|---|---|
| M01 | T 边界 `>=` 改 `>` | 杀死 |
| M02 | 旧桥已付判定 `>=` 改 `>` | 杀死 |
| M03 | 冲突的重复订单不报错 | 杀死 |
| M04 | 重复放款事件被重复累加 | 杀死 |
| M05 | B2W 付给 recipient 而非存款人 | 杀死 |
| M06 | 忽略未关联旧放款 | 杀死 |
| M07 | 忽略新金库已付 | 杀死 |
| M08 | oldKey 编码偏移 | 杀死 |
| M09 | 超精度不报错 | 杀死 |
| M10 | 不剥离尾零 | 杀死 |
| M11 | 清单排序检查由严格改为非严格 | **存活（等价）**：相邻相同 `(tx, logIndex)` 必然 oldKey 相同，已被「重复 oldKey」检查拦下 |
| M12 | 校验器不重算 oldKey | 杀死 |
| M13 | 校验器不报零地址 | 杀死 |
| M14 | 校验器不核总额 | 杀死 |
| M15 | 校验器不核清单哈希 | 杀死 |
| M16 | 校验器不查重复 oldKey | 杀死 |
| M17 | 批大小上限放到 101 | 杀死 |
| M18 | 提议核对不查金额 | 杀死 |
| M19 | 提议核对不查收款人 | 杀死 |
| M20 | 提议核对接受 48h−1s | 杀死 |
| M21 | salt 忽略 round | 杀死 |
| M22 | 提议核对不查目标合约 | 杀死 |
| M23 | 提议核对不查调用内重复 oldKey | 杀死 |
| M24 | 对账不查重复补付 | 杀死 |
| M25 | `complete` 不比较 ΣLegacyPaid 与 Σ清单 | **存活（等价）**：无错误且无未付行时两者必然相等（清单外支付、金额不符、重复支付都已是错误）；保留为纵深防御 |
| M26 | 预检不查 `legacyPaid` | 杀死 |
| M27 | 预检不查未关联旧放款 | 杀死 |
| M28 | 对账不查金额 | 杀死 |
| M29 | 扫描不标零地址 | 杀死 |
| M30 | getLogs 分块越界重叠 | 杀死 |

## 13. 范围外改动

- `pnpm-lock.yaml`：仅新增 `packages/migrate` importer 段（25 行，依赖版本与 `packages/watcher` 相同，未新增下载）。
- `lib/` 子模块在本 worktree 执行了 `git submodule update --init`（只是检出既有提交，`git status` 无变化），用于 `forge build` 生成 `out/`（已在 `.gitignore`）。
- 根 `package.json`、`pnpm-workspace.yaml`、合约、其他包：无改动。
