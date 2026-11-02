# PR-8 迁移与旧单补付工具：流程、清单格式、接口对齐、偏差与待定项

> 依据：`docs/DESIGN.md` v0.9.4 §10（旧单补付）、§5（合约，以 `docs/PR1-NOTES.md` §5 与 `contracts/src/BscVaultV2.sol` 实际接口为准）、§9.2（ΣLegacyPaid 对账口径）、§13 PR-8 行。分支 `pr-8-legacy`，新包 `packages/migrate`（`@bridge/migrate`）。
> 范围：只写代码与本地测试。**未连接任何真实链或节点，未发送任何真实交易，未读写任何真实私钥。** 唯一会签名发交易的是 `drill`，它只对自己启动的本地 anvil（127.0.0.1 随机端口）使用 anvil 公开默认账户。17 条决定未改。

## 1. 流程

```
T 之前               扫描旧桥 ──▶ 补付清单（CSV + 哈希）──▶ 公开发布（公告 + 清单哈希）
                                   │
提议                管理钱包按清单 schedule 每批 payLegacyBatch（≤100 条 / 批，48h 时间锁）
                                   │
48h 内              白名单钱包：用自己的 RPC 独立跑一遍 scan，比对清单哈希；validate（清单 + 已发布哈希）
                    → 对每个 CallScheduled 跑 verify-call
                    任何一条不在清单里 / 收款人或金额不符 / 收不到清单 / 自己扫出的哈希不同 ⇒ cancel
                                   │
48h 内、到期之前     preflight（只读）：新金库 legacyPaid(oldKey) 仍为 false；重新读旧桥放款记录，确认没付过
（每批）            有阻断项 ⇒ 白名单钱包或管理钱包在到期前 cancel 该操作；
                    先取消上一轮所有尚未执行的批次，再把阻断行写进排除文件，propose --exclude --round N+1 重新提议其余行
                    （BridgeTimelock 的执行人是任何人：到期后「不执行」挡不住，只能到期前取消）
                                   │
到期后执行          任何人 execute（提交服务代发）
                                   │
执行后              reconcile：LegacyPaid 事件逐条对清单；ΣLegacyPaid == Σ清单 时 complete
```

| 命令（`pnpm --filter @bridge/migrate cli <cmd>`） | 作用 | 是否写链 |
|---|---|---|
| `scan --source <json> \| --rpc-config <json> --cutoff T --vault --bsc-chain-id --out` | 读旧单与旧放款 → `scan-report.json`（全部旧单与状态）、`manifest.csv`；配置不合法或放款覆盖不全时报错退出 1、不写清单；stdout 标明来源（`rpc` 或 `offline-json (NOT RPC-verified)`） | 否（只读 RPC） |
| `validate <csv> [--hash]` | 独立校验：重算 oldKey、总额、条数、重复、排序、零地址/零金额、哈希、表头页脚结构 | 否 |
| `propose <csv> --hash --timelock [--round] [--exclude <oldKey 文件>] --out` | 干跑：生成每批 `schedule` / `execute` calldata、operationId、`proposals.txt` 解码视图 | 否 |
| `preflight <csv> --hash --rpc-config <旧桥> --rpc <新金库> --vault [--data <CallScheduled 的 payLegacyBatch calldata>]` | 到期前预检：`--rpc` 的 chainId 必须等于清单头的 bscChainId；`legacyPaid` + 重新读取两条链的旧单与旧放款，并用重读的旧单逐字段核对清单行；`--data` 时只查该操作里的行（先按已发布清单解码核对，任何一行不符即退出 1），不给则查全部行；有阻断项或覆盖不全退出码 1 | 否（只读） |
| `verify-call <csv> --hash --target --data --delay` | 白名单钱包对一个 `CallScheduled` 的核对 | 否 |
| `reconcile <csv>... --rpc --vault --from-block` | ΣLegacyPaid 对账 | 否 |
| `drill <csv>` | 本地 anvil 全流程演练 | 只写本地 anvil |

退出码：0 通过；1 检查失败或错误；2 未知命令；64 用法错误（缺少必填参数，如 preflight 的 `--hash`，或已删除 / 未知的参数）。错误信息只打印 viem 的 `shortMessage`，并把任何 `http(s)://` / `ws(s)://` URL 替换成 `<rpc-url>`，RPC 地址里的 API key 不会进 stderr。

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
- `payouts`：旧桥做过的放款（BSC 放款或 WANTOS 入账）。旧桥若在放款事件里记了源交易，填 `srcTxHash/srcLogIndex`（精确关联）；没记的（例如只能看到旧金库转出的 `Transfer`）不填。
- **松散放款**（第 1 轮修订）：没有关联、或关联到一个不认识的旧单（例如 logIndex 错位）的旧放款，一律不忽略：付给了某旧单的任一地址（发起人 `from`、W2B 的收款人；B2W 的存款人与 WANTOS 收款人）、且放款时间不早于该旧单的时间→ 该旧单 `SUSPECT_PAID`，**不比金额**（旧桥可能扣了手续费）；关联到同一 txHash 的另一个 logIndex → 该 tx 的旧单 `SUSPECT_PAID`。宁可人工核实，也不重复付。
- **第 2 轮**：发起人 `from` 也纳入比对（卡单用户最可能被手工从 `0x8dFd` 原路退回）；只有放款时间 ≥ 旧单时间的松散放款才算命中（早于下单的放款不可能是为这笔单付的；没有时间的放款一律算命中）；txHash / srcTxHash 在入口统一转小写。
- 金额一律是**十进制字符串**（代币单位），按 18 位小数严格换算，**不四舍五入**。

**RPC 配置**（`--rpc-config`，bigint 写成 `"123n"`）：`{ rpc: { "56": url, "13555": url }, orders: OrderEventSpec[], payouts: PayoutEventSpec[], chunk? }`。每个 spec 给出合约地址、事件签名（human-readable ABI）、区块范围、代币小数位、可选的 `token`（读 `decimals()` 核对小数位）、可选的 indexed 参数过滤（如 `{ from: 旧金库 }`），以及哪个参数是 from / recipient / amount / to / srcTxHash / srcLogIndex。读取时拒绝：`removed` 日志、发出合约不是 spec 地址的日志、区块号不在请求范围内的日志、小数位不符。**配置运行时校验（第 3 轮，A-R3-1）**：配置来自 JSON，TypeScript 类型不起作用，所以在 CLI 入口与 `loadFromRpc` 开头各校验一次（`checkRpcConfig`）：`fromBlock` 必须是真 bigint（JSON 里写 `"123n"`，只接受十进制，不接受 `"0x…"`、`"123"`、数字）；**放款 spec 的 `toBlock` 只允许字面量 `"latest"`**（数字形式整体删除；`"0x8"`、`"8n"`、`8`、`"Latest"`、`null`、缺省一律报错）——此前十六进制字符串会把「必须读到链头」的检查变成字符串拼接比较而静默绕过，迟到放款漏读，会重复付；订单 spec 的 `toBlock` 只能是 bigint 或 `"latest"`；`chunk` 给出时必须是 ≥1 的 bigint；chainId、地址、小数位、事件签名、方向也逐项检查。`"latest"` 在读取开始时按 `getBlockNumber()` 解析为当时的链头。**第 2 轮起一律报错（fail closed，scan 不写清单、preflight 退出 1）**：RPC 的 chainId 与配置不符；某条链有订单 spec 却没有本链放款 spec（旧金库原路退款）或没有对端链放款 spec（跨链放款）；放款 spec 返回 0 条日志（地址或区间写错）；同一 txHash 被两个订单 spec 各抓到（会生成两个 oldKey，合约拦不住）。订单 spec 可以只读到 T；放款 spec 必须读到当前（迟到的旧放款正是要抓的），第 2 轮的「数字 toBlock + 12 块容忍」已按用户决定删除，只留 `"latest"`。离线 JSON 不经过这些检查，由准备数据的人负责覆盖。旧桥事件格式不在本仓库，所以做成配置；本 PR 没有连主网。

## 3. 扫描分类（每条旧单只出现一次，按 `(srcChainId, txHash, logIndex)` 排序）

| 状态 | 条件（按此优先级） | 进清单 |
|---|---|---|
| `INVALID_AMOUNT` | 金额格式错或超过 18 位小数 | 否 |
| `INVALID_ZERO_ADDRESS` / `INVALID_ZERO_AMOUNT` | 收款人为零地址 / 金额为 0 | 否 |
| `OLD_PAID` | 关联到该旧单的旧放款合计 ≥ 订单金额（收款人不同会在 note 写明） | 否 |
| `OLD_PARTIAL` | 关联旧放款合计 > 0 但 < 订单金额 | 否，人工处理 |
| `SUSPECT_PAID` | 有松散旧放款付给了该旧单的任一地址（`from` / 收款人 / `srcRecipient`，不比金额，放款时间 ≥ 旧单时间 − 600 s），或有放款指向该旧单的 txHash（另一个 logIndex，或只有 srcTxHash 没有 srcLogIndex；这一条不做时间过滤） | 否，人工处理 |
| `AFTER_T` | `timestamp ≥ T` | 否，走 T+14 天流程 |
| `PAYABLE` | 其余 | **是** |

- 收款人：`W2B` 付给旧事件里的 `recipient`（没有该字段时付给发起人）；`B2W` 退给 BSC 上的存款人 `from`（见偏差 D3）。
- 重复事件：同一 `(txHash, logIndex)` 内容完全相同 → 去重计数；内容不同 → **报错停止**（不猜）。旧放款按 `(chainId, txHash, logIndex)` 去重，重复事件不会被重复累加。
- 同一 `txHash` 的不同 `logIndex` 是不同旧单，各有各的 `oldKey`。
- 关联到不存在旧单的旧放款列入 `orphanPayouts` 报告，同时按松散放款参与比对。
- 第 3 轮：时间门槛放宽为「旧单时间 − `LOOSE_TIME_SKEW_SECONDS`（600 s）」，容忍两条链的时钟偏差；只带 `srcTxHash`、不带 `srcLogIndex` 的旧放款不再报错，按「指向该 tx」处理（该 tx 的全部旧单 `SUSPECT_PAID`）；只带 `srcLogIndex` 的按未关联放款处理。
- 第 3 轮删除（用户原则「只靠白名单」）：`NEW_PAID` / `--paid-keys`（新金库已付的行由合约 `LegacyAlreadyPaid` 整批回滚兜底，执行前预检也查 `legacyPaid`）、受控集合（`CONTROLLED_RECIPIENT` / `--controlled`）。

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
oldKey,srcChainId,srcTxHash,srcLogIndex,direction,to,srcRecipient,amountWei,amount
0x…,56,0x…,4,B2W,0xABc…(存款人),0xABc…(WANTOS 收款人),12345678000000000000,12.345678
…
# count=5
# total=152845678000000000001
```

- `srcRecipient`（第 1 轮新增列）：旧事件里写的收款人。W2B 必须等于 `to`；B2W 是 WANTOS 收款人（`to` 是 BSC 存款人）。执行前预检同时盯这两个地址。
- 行按 `(srcChainId, srcTxHash, srcLogIndex)` 严格递增；地址必须是 checksum；`amount` 列必须等于 `amountWei` 的十进制显示。
- 结构严格（第 1 轮修订）：第一行是标题；表头键（bscChainId / vault / cutoverT / oldKey / amountUnit）只能在列名行之前，页脚键（count / total）只能在数据行之后；任何键重复、未知键、未知注释行、页脚之后再出现数据行都是错误。
- 同一输入永远生成同一 CSV 与同一哈希（与输入顺序无关）。权威发布物只有 CSV + 哈希（第 1 轮删除了重复的 `manifest.json`）。
- 第 2 轮收紧：`bscChainId`、`cutoverT` 只接受十进制正整数，`count` 只接受十进制非负整数（不接受 0x、科学计数、尾空格）；`vault` 必须是 checksum 形式；重复标题行、行内多余列、B2W 的 `srcRecipient` 为零地址都是错误。
- 校验器（`validate`）错误项：以上结构、oldKey 重算不符、重复 oldKey、乱序、零地址、零金额、页脚条数/总额不符、哈希与已发布值不符、oldKey 编码或金额单位声明不同。

## 5. 提议

- 清单按发布顺序每 100 条切一批（第 1 轮删除了 `--batch-size`），**每批一个独立的时间锁操作**：`schedule(vault, 0, payLegacyBatch(oldKeys,to,amounts), 0x0, salt, 48h)`。
- `salt = keccak256(abi.encode("WANTOS-BRIDGE-V2-LEGACY", manifestHash, batchIndex, round))`：与清单哈希绑定；过期或被取消后重新提议用 `round+1`（时间锁同 id 不能再次提议，PR1-NOTES §4 第 6 条）。
- `--exclude <文件>`（每行一个 oldKey，格式不对报错）：去掉被预检阻断的行，其余行重新切批；必须同时换 `--round`。**重提前必须先取消上一轮所有尚未执行的批次**（白名单钱包或管理钱包 cancel），否则新旧两轮里同一行会被两个操作包含，后执行的那个整批以 `LegacyAlreadyPaid` 回滚，连带其他行。排除的 oldKey 必须在清单里。重新提议的批次仍是同一份清单的子集，`verify-call` 照常通过，`reconcile` 仍只用这一份清单，不会因重叠报错。
- `operationId` 由工具按 OZ `hashOperation` 算出，演练里与链上 `timelock.hashOperation` 逐批比对一致。
- `proposals.txt` 是给人看的解码视图：每批条数、合计、operationId、salt，以及每行的 oldKey / 收款人 / 金额 / 来源交易。
- **白名单钱包核对**（`verifyScheduledCall` / `verify-call`）：目标必须是清单里的金库、value 0、无前置、延迟 ≥ 48h、函数必须是 `payLegacyBatch`、1～100 条、调用内无重复 oldKey，每个 `(oldKey, to, amount)` 必须与已发布清单中的同一行完全一致。不要求与工具切出的批次一一对应（重新排序或子集也接受），因为合约保证一个 oldKey 只付一次。

## 6. 执行前预检与执行后对账

- **预检**（`preflightBatch` / `preflight`，DESIGN §10「每批放款前再查一次旧 BSC 金库的放款记录」）：**在 48h 窗口内、操作到期之前**跑（可多跑几次，最后一次尽量靠近到期）。先核对 `--rpc` 的 chainId 等于清单头的 `bscChainId`。对批内每行：该行的旧单必须仍在重新读取的旧单里（找不到 = 被 reorg 或数据源不对，阻断）；**清单行的 `to` / `srcRecipient` / 金额 / 方向 / 源链必须与重读的旧单算出的值完全一致**（第 3 轮：清单金额 1000 而旧单 100、或 B2W 写成 W2B，都会阻断）；`legacyPaid(oldKey)` 必须为 false；重新读取的旧放款里不能有关联到该旧单的；不能有付给 `to`、`srcRecipient` 或发起人 `from`（从重新读取的旧单查出）的松散放款（不比金额、时间不早于旧单 − 600 s）；不能有指向同一 txHash 的放款（另一个 logIndex 或没有 logIndex，不做时间过滤）。两条链所有放款 spec 读到的放款都参与（BSC 的跨链放款与 WANTOS 旧金库的原路退款）。CLI 把 RPC 读到的全部旧单作为「已知旧单」，正确关联到其他旧单的放款不误伤；库函数不给 `orders` 时只认被检查的行、任何松散放款都算（最严）。`--data` 用 `verifyScheduledCall` 解出操作里的行，解码或核对失败直接退出 1（第 2 轮删除了 `--timelock/--round/--exclude/--batch`，避免参数与 propose 不一致时查错行）。有阻断项 ⇒ 白名单钱包或管理钱包**在到期前 cancel**（执行人是任何人，到期后无法靠「不执行」挡住），再按 §5 `--exclude` 换 round 重提。
- **对账**（`reconcileLegacy` / `reconcile`）：读取金库全部 `LegacyPaid(oldKey, to, amount)`，逐条对照已发布清单（可多份，例如 T 之后的补充清单）。错误：清单外的支付、同一 oldKey 支付多次、收款人或金额不符、多份清单重复包含同一 oldKey。`complete` = 无错误 + 全部行已付 + **ΣLegacyPaid == Σ清单**。部分批次已执行时 `ok=true, complete=false`，并列出未付行。
- 口径与 PR-7 一致：PR-7 余额对账里的 `ΣLegacyPaid` 就是这些事件的金额合计（PR7-NOTES §9.2 公式），日报 `LEGACY_PAID` 同源。

## 6a. 重复付款路径逐条结论（第 3 轮）

目标：同一笔旧单不被付两次，也不付给旧桥已经付过的人。逐条列出可能的路径、防线和证据。「已测试」= 有回归测试且对应变异被杀死；「仅文档」= 靠操作流程，代码不强制；「残余风险」= 已知不能完全排除。

| # | 路径 | 防线 | 证据 | 结论 |
|---|---|---|---|---|
| 1 | **同一 oldKey 付两次**（同一行出现在两个已执行的操作里，或已付后再提议） | 合约 `legacyPaid[oldKey]`，任一已付整批 `LegacyAlreadyPaid` 回滚；清单内 oldKey 唯一（校验器）；`verify-call` 拒绝调用内重复 oldKey；预检查 `legacyPaid` | drill（再提议执行被合约拒绝、混合批整批回滚）、manifest 重复 oldKey、proposal 调用内重复、reconcile 重复支付报错 | **已测试**（合约是硬防线） |
| 2 | **同一事实被记成两个 oldKey**（同一笔存款被 Deposit spec 和 Transfer spec 各抓一次；同一笔订单被重复读入） | 同一 txHash 被两个订单 spec 抓到 → 报错，不出清单；同一 `(txHash, logIndex)` 重复事件内容相同去重、不同报错；大小写在入口统一 | source-rpc › 重复抓取；preflight-rpc › 双 spec 时 scan 退出 1 不写清单；scan › 冲突重复；round2 › B5 大小写去重 | **已测试**。残余风险：同一笔存款在**同一个 spec** 里产生两条不同 logIndex 的日志（旧合约自己发了两次事件）会是两个 oldKey——属于旧合约行为，需人工对照 `scan-report.json` |
| 3 | **旧桥已付但放款没关联到订单**（手工从旧金库原路退款、扣手续费后的放款、关联错 logIndex、只记 srcTxHash） | 松散放款规则：付给该旧单任一地址（`from`、收款人、`srcRecipient`）即 `SUSPECT_PAID`，不比金额，时间 ≥ 旧单时间 − 600 s；指向同一 tx 的放款（异 logIndex 或无 logIndex）不论时间都命中；扫描与预检同一套规则 | round1 P1–P4、round2 A-3 / B3 / B7、round3 fix 5、preflight-rpc（扣费迟到放款、WANTOS 侧退款） | **已测试**。残余风险：旧桥付给了**完全无关的第三个地址**且不留源交易记录时无法识别；600 s 之外的更早放款不计（早于下单的放款不可能是为该单付的） |
| 4 | **迟到放款**（清单发布后、执行前旧桥才付） | 放款 spec 只能读到 `"latest"`；预检在 48h 窗口内、到期前重读两条链的放款，命中即 cancel | preflight-rpc（迟到扣费放款 → 预检退出 1；WANTOS 侧退款 → 预检退出 1；重新 scan 不再列出该行） | **已测试**。残余风险：最后一次预检之后、操作执行之前的放款——操作 48h 后任何人都能执行，必须**在到期前尽量靠近到期**再跑一次预检（仅文档）；旧付款程序 `0x9dab` 仍在活动时风险最高，DESIGN §10 Phase 0 要求先停掉 |
| 5 | **配置漏读**（toBlock 写成 `"0x8"` / 数字、放款 spec 地址或区间错、缺对端链放款 spec、RPC 指向别的链） | `checkRpcConfig` 在 CLI 入口与 loader 各校验一次：放款 `toBlock` 只允许 `"latest"`、区块号必须是 bigint；空放款 spec、缺本链 / 对端链放款 spec、chainId 不符一律报错；新金库 RPC chainId 必须等于清单头 | source-rpc（`"0x1"`、`"1"`、`1`、`1n`、`"Latest"`、`null`、缺省等全部拒绝）；preflight-rpc（审查者探针：`"0x<块号>"`、`"0x8"`、`"<n>n"`、数字、`"Latest"`、`null` 时 scan 退出 1 且不写清单、preflight 退出 1；chainId 不符） | **已测试** |
| 6 | **重提批次与旧批次重叠**（预检阻断后用 `--exclude` 换 round 重提，旧一轮未执行的操作仍在） | 合约层面同一行最多付一次（第 1 条），后执行的操作整批回滚——不会重复付，但连带同批其他行；流程要求先 cancel 上一轮所有未执行的批次再重提 | proposal › exclude；drill › 混合批整批回滚 | 不会重复付（**已测试**）；「先取消再重提」的顺序**仅文档** |
| 7 | **清单或提议被篡改**（改金额、改收款人、改方向、塞入清单外的行） | 清单哈希（发布物 = CSV + 哈希，`validate --hash`）；白名单钱包对每个 `CallScheduled` 跑 `verify-call`（每行 oldKey / to / amount 必须与已发布清单一致）；预检再用**重读的旧单**逐字段核对清单行（to / srcRecipient / 金额 / 方向 / 源链），`--data` 任一行不符即退出 1；白名单钱包用自己的 RPC 独立重扫比对哈希 | manifest（哈希、结构、B6）；proposal（多付 / 少付 1 wei、换收款人、末字节）；round3 fix 1（金额 1000 vs 100、方向翻转、各字段）；preflight-rpc（部分正确的 calldata 退出 1） | **已测试**。独立重扫比对哈希**仅文档** |
| 8 | **离线 JSON 路径**（`scan --source`，不经过任何 RPC 核对） | stdout 标明 `offline-json (NOT RPC-verified)`；字段格式、重复事件、松散放款规则照常执行 | cli › offline 标记 | **残余风险**：放款覆盖是否完整、数据是否真实，完全取决于准备数据的人；正式清单应由 `--rpc-config` 生成，执行前预检只接受 RPC 配置（`preflight` 没有离线入口），所以离线清单在执行前仍会被 RPC 重新核对一次 |

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
| D7 | （第 3 轮删除）受控集合机制、`NEW_PAID` / `--paid-keys` 已按用户「只靠白名单」原则删除 | 新金库已付由合约 `LegacyAlreadyPaid` 与预检 `legacyPaid` 兜底 |
| D8 | 松散旧放款（未关联、或关联到不认识的旧单）付给旧单任一地址（含发起人）即 `SUSPECT_PAID`，不比金额；同 txHash 异 logIndex 的关联也算；只计放款时间 ≥ 旧单时间 − 600 s 的（指向本 tx 的规则不过滤） | 第 1、2 轮审查：宁可人工，不重复付。代价：老用户在下单后收到过其他未关联放款时会被转人工 |
| D9 | 放款覆盖不全（缺 spec、空结果、没读到链头、chainId 不符、订单被重复抓取）一律报错，不再是警告 | 第 2 轮审查 A-1/A-2：警告会被忽略，清单照出 |

## 9. 待定项（按最保守方案实现，需负责人确认）

1. **旧桥事件格式与放款关联方式**（待用户确认，口径未改）：旧金库 `0x8dFd`（WANTOS）与 `0xec6e`（BSC）的发起事件签名、放款事件是否记录源交易。目前做成 RPC 配置；若旧放款不记源交易，只能按收款人匹配（命中即人工处理，见 D8）。
2. **旧桥手续费**（D4，待用户确认，口径未改）：若旧桥本应扣手续费，补付金额是否扣除。当前不扣。
3. **B2W 旧单的处理**（D3，待用户确认，口径未改）：当前退 BSC USDT 给存款人；若负责人希望改为在 WANTOS 上补入账，需要另一机制（合约没有）。
4. **T 之后存入 `0x8dFd` 的资金**（T+14 天内受理、须过 §7 来源检查、只付给存款人本人）：本工具把它们标 `AFTER_T` 排除；需 PR-4 来源检查结论后由负责人发补充清单（`reconcile` 已支持多份清单）。
5. **`0x8dFd` 在 T 之后的转出归入受控集合**：这是 PR-7 / 管理后台的配置（`legacyAddresses`、`controlledSetFile`），本 PR 不改它们。（本工具第 3 轮已删除受控集合参数。）
6. **新金库已付的行**：`scan` 不再读取已付 oldKey（`--paid-keys` 已删除）；补充清单若误含已付行，执行前预检会以 `legacyPaid` 阻断，即使漏过，合约 `LegacyAlreadyPaid` 也会让整批回滚（不会重复付，但会连带同批其他行，需取消重提）。
7. **旧 WANTOS-USDT 小数位**：RPC 读取时按配置的 `decimals` 换算；超过 18 位小数且有非零尾数的金额标 `INVALID_AMOUNT`，不四舍五入。

## 10. 上线前需要负责人提供

1. **切换时刻 T**（UTC 秒）及公告文本（含清单哈希、清单下载地址、T+14 天规则）。
2. 旧桥地址确认：WANTOS 旧金库 `0x8dFd39E98f478688A41Cdbe40bc544d672F0A9E3`、BSC 旧金库 `0xeC6E356a2E986D6A9b103217B9d215c8a6F37139`、旧付款程序 `0x9dAb17a9…6E90`；两链的扫描起止区块。
3. 旧桥事件的 ABI（或旧合约源码 / 已验证合约），以及放款记录来源（旧金库事件、`Transfer`、旧付款程序交易）。
4. 新金库地址、时间锁地址、BSC chainId（主网 56）。
5. 补付总额对应的 BSC 储备（在 §5.5 首批储备之外另备）。
6. 两条链各一个可信只读 RPC（扫描与预检用；当前版本单 RPC，靠白名单钱包用自己的 RPC 独立重扫比对哈希来交叉）。
7. RPC 配置里两条链的旧金库放款来源（旧金库事件或旧金库转出的 `Transfer`），每条有订单的链都要有本链与对端链的放款 spec，放款 spec 的 `toBlock` 必须写 `"latest"`。

## 11. 测试

- `pnpm --filter @bridge/migrate test`：13 个文件、160 个测试；`typecheck` 通过。覆盖率（v8，`cli.ts`/`index.ts` 除外）：语句 97.0%、分支 94.0%、函数 100%、行 99.3%。
- 夹具 `legacy-basic.json` 覆盖：重复事件（订单与放款各一）、已放款旧单、部分放款（重复放款事件不被重复累加）、未关联放款、同一 txHash 多个 logIndex、1 wei 金额、19 位小数、零地址、零金额、T 边界、B2W、无 recipient 字段、新金库已付、孤立放款。
- 第 1 轮新增（`test/unit/round1.test.ts`，在 e614965 的旧代码上 13 个里 10 个红，修复后全绿）：P1 错链放款（同 tx 异 logIndex、关联到未知旧单但付给本单收款人、正确关联到其他已知旧单不误伤）、P4 预检同样阻断（含 `knownOrders`）、P2 扣手续费后的松散放款、P3 B2W 的 WANTOS 收款人（扫描与预检）、N14 大小写不同的重复放款事件、D7 受控地址四种角色。
- 第 1 轮新增（其他文件）：P5 / B5 清单结构（第二行 `# vault=`、表头在列名后、页脚在行前、页脚后再有行、未知键、杂注释、金额单位）；N11 B2W 在发布物里写 B2W 且带 srcRecipient、W2B 的 srcRecipient 必须等于 to；N03 少付 1 wei、N04 地址只差最后一字节；`--exclude` 重新切批；RPC 读取的 removed / 地址 / 区块范围 / decimals / 空放款警告 / 跨 spec 同 tx 警告；`test/integration/preflight-rpc.test.ts` 在 anvil 上用真实 `Transfer` 日志跑 `scan --rpc-config` 与 `preflight` CLI（旧桥扣手续费的迟到放款被阻断，退出码 1）。
- 第 2 轮新增（在 0e04e1d 的旧代码上跑，23 个红，修复后全绿）：`test/unit/round2.test.ts`（A-3 发起人被原路退回，扫描与预检；重读不到旧单即阻断；B7 放款早于 / 同秒 / 晚于 / 无时间，同 tx 规则同理；坏时间戳）；`source-rpc.test.ts`（`"latest"` 解析与放款时间戳、落后 12 块边界、空放款 spec、缺本链 / 对端放款 spec、chainId 不符、同 tx 被两个订单 spec 抓到）；`preflight-rpc.test.ts` 改为两个 anvil（5600 + 13500）：放款地址写错、没有放款 spec、存款被两个 spec 重复抓取时 scan 退出 1 且不写清单；扫描时冻结的配置在链头前进 13 块后 preflight 退出 1；`"latest"` 配置抓到迟到的扣费放款；`--data` 只查该操作里的行（两笔存款、排除一行）、坏 calldata 退出 1、`--batch` 已删除；`manifest.test.ts` B6 七例；`cli.test.ts` B2（受控文件 / 排除文件 / 已付文件的非法行退出 1）。另有 B3、B5 的用例在旧代码上本来就是绿的（补的是存活变异 V03/V07/V08 的缺口），由变异 S23–S26 证明有效。
- 第 3 轮新增（在 c7c9ad1 的旧代码上跑 20 个红，修复后全绿；`redact.test.ts` 在旧代码上无此模块）：`source-rpc.test.ts` A-R3-1（放款 toBlock `"0x1"`/`"0x8"`/`"1"`/`1`/`1n`/`"Latest"`/`"LATEST"`/`"latest "`/`null`/缺省/`""`/`"finalized"` 全部拒绝；订单 toBlock、fromBlock、chunk 与其他字段的运行时校验）；`preflight-rpc.test.ts`（审查者探针：存款 → 旧金库退 9.9 → 挖 30 块后，`"0x<存款块>"`、`"0x8"`、`"<n>n"`、十进制字符串、数字、`"Latest"`、`null` 时 scan 退出 1 且不写清单、preflight 退出 1；`"latest"` 重新 scan 不再列出该行；WANTOS 侧退款阻断（随修 3）；部分正确的 `--data` 退出 1（随修 2）；新金库 RPC chainId 不符（随修 7）；带密钥的 RPC URL 不进 stderr（随修 6）；缺 `--hash` 退出 64）；`round3.test.ts`（随修 1：金额 1000 vs 100、少 1 wei、方向翻转、to / srcRecipient / srcChainId、旧单金额非法；随修 5：只有 srcTxHash 的放款、只有 srcLogIndex 的放款、非法 srcTxHash）；`round2.test.ts` 的 B7 改为 600 s 偏差（−601 s 不命中，−600 / −599 s 命中，指向本 tx 的规则不受时间影响）；`redact.test.ts`（两层脱敏各自独立验证）；`cli.test.ts`（oldKey 文件无 0x 前缀 / 过短 / 多余字段拒绝（N15）、已删除参数退出 64、preflight 缺 `--hash` 退出 64、离线来源标记）。
- 分批边界：1 / 99 / 100 / 101 / 250 条；>100 拒绝；排除 2 行后 248 条切成 100/100/48。
- anvil 端到端（`test/integration/drill.test.ts`）：部署 PR-1 金库 + 时间锁 → 注资 → schedule → 链上 operationId 比对 → `CallScheduled` 解码核对 → 48h 前执行被拒 → 预检 → 执行 → `legacyPaid` 全真、收款人余额、金库支出 == 清单总额 → ΣLegacyPaid 对账 complete → 同一 oldKey 再提议执行被合约以 `LegacyAlreadyPaid` 拒绝；250 条三批；部分执行与迟到旧放款被预检拦下并由白名单钱包取消；混合批整批回滚；非时间锁调用被拒。

## 12. 变异测试（独立副本，scratchpad 拷贝，不改本 worktree）

注：第 1、2 轮表格里涉及受控集合（D7）、`--paid-keys`、数字 `toBlock` 与 12 块容忍的测试与变异，已随第 3 轮删除这些机制而失效，保留为历史记录。

### 第 3 轮（HEAD 之上，29 个；28 个杀死，1 个等价存活）

脚本：`/private/tmp/claude-501/-Users-ark-Documents-gh-code-wantos/11660e7f-9184-4981-8a25-f0db54a89073/scratchpad/pr8-lane8-r3mut/run.py`（变异清单 `/private/tmp/claude-501/-Users-ark-Documents-gh-code-wantos/11660e7f-9184-4981-8a25-f0db54a89073/scratchpad/pr8-lane8-r3mut/muts.py`，用法 `python3 run.py <仓库副本根目录> [变异 id…]`，每个变异前检查原文恰好出现 1 次，跑完逐个还原），结果 `/private/tmp/claude-501/-Users-ark-Documents-gh-code-wantos/11660e7f-9184-4981-8a25-f0db54a89073/scratchpad/pr8-lane8-r3mut/out.txt`。T25/T26/T27 首轮在旧位置（cli.ts）上 T25、T26 存活：两层脱敏互为冗余，集成测试分不出单层；把 `safeMessage` 移到 `src/redact.ts` 并补单测后，三者及新增 T29 均被杀死。

| id | 组 | 变异 | 杀死它的测试 |
|---|---|---|---|
| T01 | A-R3-1 | 放款 toBlock 不校验 | source-rpc › A-R3-1；preflight-rpc（审查者探针） |
| T02 | A-R3-1 | 放款 toBlock 接受数字 | source-rpc › A-R3-1；preflight-rpc |
| T03 | A-R3-1 | fromBlock 不校验 | source-rpc › 订单 toBlock / fromBlock / chunk |
| T04 | A-R3-1 | 订单 toBlock 不校验 | 同上 |
| T05 | A-R3-1 | chunk 不校验 | 同上 |
| T06 | A-R3-1 | loader 不调用配置校验 | source-rpc › A-R3-1 等 |
| T07 | A-R3-1 | CLI 入口不调用配置校验 | **存活（等价）**：loader 第一行做同一校验，两层是用户要求的纵深防御，任一层单独去掉另一层仍拦住；两层同时去掉即 T06+T07，被 source-rpc 与 preflight-rpc 杀死 |
| T08 | A-R3-1 |  不区分大小写 / 空格 | source-rpc（、）；preflight-rpc |
| T09–T13 | 随修 1 | 预检不核金额 / 方向 / to / srcRecipient / 源链 | round3 › fix 1 各用例 |
| T14 | 随修 1 | 不一致不阻断 | round3 › fix 1 |
| T15 | 随修 2 | preflight 不强制  | cli、preflight-rpc（退出 64） |
| T16 | 随修 2 | 用法错误不返回 64 | cli、preflight-rpc |
| T17 | 随修 2 |  部分解出仍继续 | preflight-rpc（部分正确 calldata） |
| T18 | 随修 3 | CLI 只传 BSC 放款 | preflight-rpc（WANTOS 侧退款阻断） |
| T19 | 随修 4 | 没有时钟偏差容忍 | round2 › B7（−599 s） |
| T20 | 随修 4 | 偏差 6000 秒 | round2 › B7（常量、−601 s） |
| T21 | 随修 4 | 指向本 tx 的规则失效 | round1 P1、round2 B7、round3 fix 5 |
| T22 | 随修 4 | 偏差边界 off-by-one | round2 › B7（−600 s） |
| T23 | 随修 5 | 只有 srcTxHash 的放款不计 | round3 › fix 5、round2 › B7 |
| T24 | 随修 5 | srcTxHash 格式不校验 | round3 › fix 5 |
| T25 | 随修 6 | 不替换 URL | redact |
| T26 | 随修 6 | 打印完整 viem 错误 | redact |
| T27 | 随修 6 | 完全不脱敏 | redact、preflight-rpc |
| T29 | 随修 6 | 不删  行 | redact |
| T28 | 随修 7 | 不核新金库 RPC chainId | preflight-rpc |

### 第 2 轮（HEAD 之上，30 个，全部杀死）

S17 第一次跑存活（同 tx 规则缺「同一秒」边界用例），补用例后被杀死。

| id | 组 | 变异 | 杀死它的测试 |
|---|---|---|---|
| S01 | A-1 | 放款 spec 落后链头不报错 | source-rpc › 落后 12 块边界；preflight-rpc › 冻结配置 |
| S02 | A-1 | `latest` 解析成落后 20 块 | source-rpc › 解析 latest；preflight-rpc |
| S03 | A-1 | 容忍落后 1000 块 | source-rpc › 落后边界；preflight-rpc |
| S04 | A-1 | 落后边界 off-by-one | source-rpc › 落后边界（head 13 通过 / 14 拒绝） |
| S05 | A-2 | 放款 spec 空结果不报错 | source-rpc › 空结果；preflight-rpc › 地址写错 |
| S06 | A-2 | 订单链无本链放款 spec 不报错 | source-rpc › 缺放款 spec；preflight-rpc › payouts:[] |
| S07 | A-2 | 订单链无对端放款 spec 不报错 | source-rpc › 缺对端放款 spec |
| S08 | A-2 | 同 tx 被两个订单 spec 抓到不报错 | source-rpc › 重复抓取；preflight-rpc › 重复抓取 |
| S09 | A-2 | 不核 RPC chainId | source-rpc › chainId 不符 |
| S10 | A-3 | 扫描不看 W2B 发起人 | round2 › A-3 scan |
| S11 | A-3 | 预检不看发起人 | round2 › A-3 preflight |
| S12 | A-3 | 重读不到旧单不阻断 | round2 › A-3 旧单找不到 |
| S13 | B1 | `--data` 被忽略（查全部行） | preflight-rpc › `--data` checked=1 |
| S14 | B1 | `--data` 核对失败仍继续 | preflight-rpc › 坏 calldata |
| S15 | B2 | 受控文件非地址行不报错 | cli › B2 |
| S16 | B2 | oldKey 文件非法行不报错 | cli › B2 |
| S17 | B7 | 同 tx 规则同秒不命中 | round2 › B7 同 tx（补同秒用例） |
| S18 | B7 | 同秒放款不命中 | round2 › B7 scan |
| S19 | B7 | 时间过滤失效 | round2 › B7 scan / preflight |
| S20 | B7 | 取最早而非最晚放款时间 | round2 › B7 scan（多笔放款顺序） |
| S21 | B7 | 无时间的放款当作很早 | cli、drill、manifest、round1 等（离线夹具无时间） |
| S22 | B7 | 预检时间门槛错误（永不命中） | round2 › B7 preflight；preflight-rpc |
| S23 | B5 | 订单 txHash 不转小写 | round2 › B5 订单大写 |
| S24 | B5 | 放款 srcTxHash 不转小写 | round2 › B5 srcTxHash 大写（scan / preflight） |
| S25 | B5 | 放款 txHash 不转小写 | round1 › N14 |
| S26 | B3 | 预检不看 to（存款人） | round2 › B3 |
| S27 | B6 | 表头整数正则放宽 | manifest › 尾空格 / 科学计数 |
| S28 | B6 | B2W 零 srcRecipient 不报错 | manifest › B6 |
| S29 | B6 | vault 不要求 checksum | manifest › B6 |
| S30 | B6 | count 接受 0x / 尾空格 | manifest › B6 |

### 第 1 轮（HEAD 之上，31 个，全部杀死）

R18 与 R28 第一次跑存活：R18 没有测试覆盖，补了「页脚移到列名行之上」用例；R28 的原写法比较带大小写的前缀，地址末字节一变校验和大小写跟着变，变异体并没有更弱，改为比较小写前缀后重跑。两者现均被杀死。

| id | 组 | 变异 | 杀死它的测试 |
|---|---|---|---|
| R01 | A1 | 错链放款不进收款人比对 | round1 › P1 关联到未知旧单但付给本单收款人；P4 knownOrders |
| R02 | A1 | 不记录错链的 srcTxHash | round1 › P1 同 tx 异 logIndex；P4 预检阻断 |
| R03 | A1 | 同 tx 异 logIndex 规则失效 | round1 › P1 同 tx 异 logIndex；P4 预检阻断 |
| R04 | A1 | 所有带链接的放款都当作已关联 | round1 › P1（3 个） |
| R05 | A2 | 扫描不看 WANTOS 收款人 | round1 › P3 扫描 |
| R06 | A2 | 预检不看 srcRecipient | round1 › P3 预检 |
| R07 | A2 | 丢弃事件 recipient | manifest 构建、cli、drill |
| R08 | A2 | 校验器不查 W2B srcRecipient==to | manifest › W2B srcRecipient 不等于 to；B2W 改写成 W2B（N11） |
| R09 | A3 | 松散放款按金额匹配 | preflight-rpc（扣手续费的迟到放款）、cli、drill |
| R10 | A4 | 预检不查已关联旧放款 | reconcile › preflight；drill › 部分执行 |
| R11 | A4 | `--exclude` 失效 | proposal › exclude；cli；drill › 混合批 |
| R12 | A4 | 排除未知 oldKey 不报错 | proposal › exclude |
| R13 | A4 | CLI preflight 不核金库地址 | preflight-rpc |
| R14 | A4 | CLI 预检不传旧放款 | preflight-rpc |
| R15 | B5 | 键重复不报错 | manifest › 第二行 `# vault=`（P5）；页脚在行前 |
| R16 | B5 | 表头在列名行之后不报错 | manifest › 表头在列名行之后（P5） |
| R17 | B5 | 页脚之后的行不报错 | manifest › 页脚之后有行（P5） |
| R18 | B5 | 页脚在列名行之前不报错 | manifest › 页脚移到列名行之上（P5，新增） |
| R19 | D7 | 扫描不排除受控地址 | round1 › D7 |
| R20 | D7 | 校验器不报受控地址 | manifest › 受控地址为错误 |
| R21–R24 | RPC | 不拒 removed / 不核地址 / 不核区块范围 / 不核 decimals | source-rpc › 拒绝用例 |
| R25 | RPC | 放款 spec 空结果不警告 | source-rpc › 警告；preflight-rpc |
| R26 | RPC | 跨 spec 同 tx 不警告 | source-rpc › 警告 |
| R27 | N03 | 核对只查多付 | proposal › 少付 1 wei |
| R28 | N04 | 核对忽略地址最后一字节（比较小写前缀） | proposal › 地址只差最后一字节 |
| R28b | N04 | 核对不查收款人 | proposal › 换收款人；只差最后一字节 |
| R29 | N11 | 发布物 direction 写死 W2B | round1 › P3 预检、cli、preflight-rpc |
| R30 | N14 | 放款去重区分大小写 | round1 › N14 |

### 第 0 轮（e614965）

30 个变异，28 个被杀死，2 个存活（均为等价变异）。

| id | 变异 | 结果 |
|---|---|---|
| M01 | T 边界 `>=` 改 `>` | 杀死 |
| M02 | 旧桥已付判定 `>=` 改 `>` | 杀死 |
| M03 | 冲突的重复订单不报错 | 杀死 |
| M04 | 重复放款事件被重复累加 | 杀死 |
| M05 | B2W 付给 recipient 而非存款人 | 杀死 |
| M06 | 忽略未关联旧放款（第 1 轮已改为松散放款规则） | 杀死 |
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
