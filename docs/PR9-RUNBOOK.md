# PR-9 测试网作战手册（快速版，主线 ≤ 2 小时）

> 依据：`docs/PR9-TESTNET-PLAN.md`（下称「计划」）§0–§14、`docs/DESIGN.md` v0.9.5、`docs/PR1-NOTES.md`、`docs/PR10-MAINNET-RUNBOOK.md`（验收 V1–V14）。
> 用户拍板（2026-11-02）：测试网用**快速版合约**，等待窗口缩到分钟级，**只用于 WANTON 1345 与 BSC 测试网 97，主网永远不用**；PR-9 测试网流程控制在 2 小时以内。
> 本手册只描述做法。**任何链上动作都要负责人在对话里明确授权**（§3），授权按动作给，不外推。

## 0. 红线（沿用计划 §0，补充快速版）

1. 只在 WANTON 1345 与 BSC 测试网 97 上做；绝不碰 WANTOS 主网 13555、BSC 主网 56、rpc1/rpc2、S1。
2. 快速版字节码只能在 1345 / 97 / 本地 anvil（31337 / 31338）创建，三层防呆见 §1.2。主网部署只用 `contracts/src` 的原版（`Deploy.s.sol`）。
3. 测试钥匙全部由脚本临时生成，只存放在运行目录（仓库之外，权限 0600）。演练结束后整个目录销毁；不得复用主网钥匙。
4. 测试资产转账由 Testor 代理，必须有用户直接授权（目标地址 + 资产 + 金额）。
5. 不用 `pkill -f`；只停自己启动的进程（彩排脚本按自己记录的 pid 停 anvil）。

## 1. 快速版合约

### 1.1 生成与核对（构建期，不污染主网）

```bash
node scripts/make-fast-variant.mjs        # contracts/src|test|script → contracts/testnet-fast（已 gitignore）+ 替换表
node scripts/check-fast-variant.mjs       # 独立逐行 diff：只允许清单里的替换、chainid 防呆和 overlay
FOUNDRY_PROFILE=fast forge build          # 产物在 out-fast/，默认 profile 与 out/ 不变
FOUNDRY_PROFILE=fast forge test           # 快速版上重跑 PR-1 全部用例 + 快速版专用防呆用例
```

替换清单：`scripts/fast-variant/manifest.json`。每一项的 `old` 必须恰好出现 `count` 次，否则生成失败（防止漏替换或多替换）。生成后，`src` 里还剩没在白名单上的「天 / 小时」字面量，也算失败。

| 常量 | 主网 | 快速版 | 说明 |
|---|---|---|---|
| 时间锁 `MIN_DELAY`（构造参数、immutable、初始 `getMinDelay`，共 3 处） | 48h | **2 分钟** | 用户指定 |
| `MAX_DELAY` | 7 天 | 7 分钟 | 保持为 MIN 的 3.5 倍 |
| `EXPIRY_PERIOD` | 14 天 | 14 分钟 | |
| `PENDING_ADMIN_TTL` | 7 天 | 7 分钟 | |
| `ADMIN_RECOVERY_DELAY` | 14 天 | 14 分钟 | |
| 时间锁 `RECOVERY_COOLDOWN` | 3 天 | 3 分钟 | |
| `MAX_SIGNATURE_TTL` | 24h | **10 分钟** | 不按比例缩到 1 分钟：要够硬件钱包签名并在两条链各提交一次 |
| `WL_TRANSFER_DELAY` | 48h | 2 分钟 | |
| `WL_TRANSFER_TTL` | 7 天 | 7 分钟 | |
| `WL_RECOVERY_DELAY` | 7 天 | 7 分钟 | |
| 桥 `RECOVERY_COOLDOWN` | 3 天 | 3 分钟 | |
| `REFUND_DELAY` | 24h | 3 分钟 | 监控「可执行前核对」的宽限期同步改成 60 秒 |
| `releaseDelay` 下限 | 6h | 1 分钟 | 上限 7 天不变；测试网部署值 120 秒 |
| `b2wDelay` 下限 | 10 分钟 | 30 秒 | 上限 24h 不变；测试网部署值 90 秒 |
| UTC 日额度（`/ 1 days`） | 1 天 | **不变** | 额度跨日要真跨 UTC 零点，见 §6 |

保持不变的比例关系由 `FastGuards.test_fastWindowValues` 断言：MIN < MAX；签名有效期 < 提议过期；WL 交接 < WL 恢复 < 管理钱包恢复；冷却期 < 恢复期。

### 1.2 主网防呆（三层，互相独立）

| 层 | 位置 | 行为 | 证据 |
|---|---|---|---|
| ① 字节码 | 快速版 `BridgeTimelock` 与 `BridgeBase` 的构造函数（覆盖两个实现合约） | `block.chainid ∉ {1345, 97, 31337, 31338}` 时 revert，报 `TESTNET_FAST_ONLY` | `FastGuards`：在 56 / 13555 / 1 / 137 / 204 / 5611 上都无法创建 |
| ② 快速版部署脚本 | `contracts/fast-overlay/script/DeployFast.s.sol` | 创建任何东西之前先检查 chain id；接着要求被部署的字节码确实是快速版 | `test_deployFastRefusesBscMainnet` / `…WantosMainnet` / `…RunRefusesMainnetBeforeReadingEnv`：部署者 nonce 保持 0 |
| ③ 主网部署脚本 | `contracts/script/Deploy.s.sol` | 广播前在本地建一次性副本，探测窗口常量必须等于主网值，否则报 `testnet-fast bytecode refused`。部署后再核对时间锁 `MIN_DELAY` == 48h。`forge script` 先完整模拟，所以不一致的字节码到不了链上 | `test_productionDeployRefusesFastBytecode_*`；即使绕过探测，部署后的核对仍会拒绝（`…EvenIfProbeBypassed`） |

另有两道逐字节核对：`check-fast-variant.mjs` 断言快速版与主源码之间**只差**清单里的替换和 chainid 检查，`packages/pr9/test/fastVariant.test.ts` 再验证篡改能被抓到。测试网验收 V13 会显式检查「时间锁 = 2 分钟（测试网专用值，非主网 48h）」。

## 2. 彩排脚本（同一套脚本，换配置即可指向测试网）

```bash
pnpm --filter ./packages/pr9 run rehearse                                   # 本地双 anvil，快进时间（约 40 秒）
pnpm --filter ./packages/pr9 run rehearse -- --config config/rehearse.local-realtime.json   # 本地真实时钟（出块 1 秒）
pnpm --filter ./packages/pr9 run rehearse -- --only <stage> --run-dir <dir> # 单独重跑某阶段（本地从该阶段检查点恢复）
pnpm --filter ./packages/pr9 run rehearse -- --from <stage> --run-dir <dir> # 从某阶段续跑
PR9_TESTNET_AUTHORIZED=1 pnpm --filter ./packages/pr9 run rehearse -- --config config/rehearse.testnet.json --authorized --run-dir <dir>
pnpm --filter ./packages/pr9 run probe                                      # BSC 测试网 RPC 只读探测
```

- 阶段依次是 `build`、`deploy`、`verify`、`fund`、`roles`、`e2e`、`emergency`、`faults`、`monitor`、`legacy`。任一判据失败就立即停下，并打印日志位置：`<run-dir>/rehearse.log`、`report.md`、`watcher-alerts.jsonl`、`relayer-alerts.jsonl`、`alert-coverage.md`。
- 测试网 profile 要同时满足 `--authorized` 和 `PR9_TESTNET_AUTHORIZED=1` 才会运行。chain id 只认 1345 / 97，遇到 13555 / 56 / 1 一律拒绝。RPC 地址只从环境变量读（`WANTON_RPC_PRIMARY`、`WANTON_RPC_CROSSCHECK_1`、`BSC_TESTNET_RPC_1..3`）。生产节点主机名和 101.32.* 段直接拒绝。
- 付款程序用的是 PR-3 的真实代码，签名器为 `LocalTestSigner`（测试网替代 KMS，见 PR3 Q2）。监控用 PR-7 的真实代码，暂停钥匙经 `PauseOnlySigner` 发交易。旧单补付用 PR-8 工具，白名单离线核对用 PR-6 的 offline-check。
- 数据库：relayer 用 PGlite，数据在 `<run-dir>/relayer-pg*`。真实测试网若用服务器 A 的 Postgres，见 §8 待确认 4。

## 3. 需要用户在场 / 授权的节点

| # | 时点 | 动作 | 对应计划 |
|---|---|---|---|
| U1 | T−1 天 | 授权 Testor 向「资助钱包」转 WANTON 测试币（地址由彩排脚本 `keys.json` 生成后报给用户），并选定 BSC 测试网 BNB 来源（水龙头或用户转入） | A3 / A4 |
| U2 | T−1 天 | 确认 BSC 测试网第 3 个独立 RPC（免费公共节点只有 2 个可用，见 §7）和 WANTON 隧道 / 交叉节点 | 计划 §14-2 / 3 |
| U3 | T+0 | 口头授权「在 1345 / 97 部署快速版合约与测试 USDT」 | A1 / A2 |
| U4 | T+10 | 授权注资（每链储备 2 万测试 USDT） | A5 |
| U5 | T+15 | 硬件钱包演练 R1 / R2（负责人本人，与主线并行） | A6 |
| U6 | T+95 | 授权 WANTON 节点回滚演练 F6（先暂停桥） | A8 |
| U7 | T+20 | 授权同 nonce 替换测试 N1–N5（主线外并行） | A7 |
| U8 | — | 告警通道与外部心跳服务的选型和开通（没有真实通道，计划 §9.3 不通过） | A11 |

## 4. 资金与授权清单（最小量）

本地彩排实测 gas（全部 10 个阶段，100 笔端到端 + 全部应急与故障）：

| 链 | 合计 gas | 交易数 | 其中部署 | 用户 | 付款钥匙 | 管理钱包 | 资助钱包 |
|---|---|---|---|---|---|---|---|
| WANTON | 40.7M | 413 | 8.1M | 14.4M（157 笔） | 5.6M | 2.6M | 5.9M（106 笔铸币） |
| BSC 测试网 | 38.6M | 373 | 8.3M | 5.7M（75 笔） | 11.2M | 3.1M | 5.8M（104 笔铸币） |

按 gas 价 1 gwei 计，每条链约 0.04 原生币；按 10 gwei 约 0.4。另加「真实窗口背景轨」（§6）的一套原版部署和提议，约 1,000 万 gas。

| 角色 | 链 | 建议金额 | 由谁提供 | 授权 |
|---|---|---|---|---|
| 资助钱包（脚本生成，给其余钥匙补 gas、铸造测试 USDT） | BSC 测试网 | **1 BNB**（10 gwei 下约 2 倍余量） | 水龙头 / 用户转入 | U1（A4） |
| 资助钱包 | WANTON | **10 WTN**（gas 价未实测，按 10 gwei 留 20 倍余量） | Testor | U1（A3：地址 + WTN + 10） |
| 部署者（一次性，nonce 必须为 0） | 两链 | 各 0.02 | 资助钱包自动补 | 含在 U3 |
| 管理钱包 / admin2 / admin3（测试账户） | 两链 | 各 0.02 | 资助钱包自动补 | — |
| 白名单钱包 wl…wl4 | 两链 | 各 0.02 | 同上 | — |
| 付款钥匙（两链各 2 把，含补发） | 两链 | 各 0.02 | 同上 | — |
| 暂停钥匙（3 把，含泄露演练后补发） | 两链 | 各 0.02 | 同上 | — |
| 提交服务热钥匙 | 两链 | 各 0.02 | 同上 | — |
| 测试用户 U1…U100 | 两链 | 各 0.002 | 同上 | — |
| 测试 USDT（MockToken，18 位） | 两链 | 脚本自部署、自铸造：WANTON 用户 100×5,000 + 储备 2 万；BSC 用户 100×2,000 + 储备 2 万 | 资助钱包铸造（开放铸造，仅测试） | U4（注资） |

若改用现成的 WANTON 测试 USDT（非开放铸造），需由 Testor 转入：U1…U60 各 500、资助钱包 2.1 万（储备 + E11）。这种情况下 E11「增发」要由该代币 owner 操作，属另一项授权。

## 5. 时间表（主线 120 分钟）

时间估算来自本地真实时钟彩排（出块 1 秒，见 §9），再加上真实网络的额外耗时：WANTON 出块与 6 个确认、BSC 测试网 finalized 延迟约 1–5 块、RPC 往返。

| 时点 | 阶段 | 命令 | 通过判据 | 失败回退 |
|---|---|---|---|---|
| T−1 天 | 准备 | `pnpm --filter ./packages/pr9 run probe`；建 SSH 隧道到 rpc-test；Testor 转账（U1） | ≥ 3 个可用 BSC RPC；WANTON 两路 RPC 的 chainId = 1345 | 少于 3 个就加付费 RPC（U2） |
| T+0 → 3 | build | `--only build` | B1–B3：替换点计数吻合、逐字节核对、编译 | 停止，修清单 |
| T+3 → 10 | deploy（U3） | `--only deploy` | 部署者 nonce 0；预测地址无代码；两链代理地址相同；D4 失败规程只模拟 | 任一笔失败：两链一起作废，换新部署者（计划 §3.2） |
| T+10 → 12 | verify | `--only verify` | V1–V14 + `Verify.s.sol` 全过；V13 显示 2 分钟 | 不注资，回到 deploy |
| T+12 → 15 | fund（U4） | `--only fund` | 储备到账、精确授权 | — |
| T+15 → 45 | roles | `--only roles` | R3–R12（两链并行）；真实等待合计约 28 分钟（2+2+3+7+14 分钟），R11 / R12 不另等 | 判据失败即停；按 `report.md` 定位后 `--only roles` 重跑（测试网无检查点：重跑前须确认上次已执行的步骤，见 §8-5） |
| 并行 T+15 → 45 | 负责人 R1 / R2 | 硬件钱包签名、记录 EIP-712 显示 | 地址一致；显示结论写入 PR0 ④ | 不阻塞主线 |
| T+45 → 70 | e2e | `--only e2e` | 100 笔（95 笔真实 + 5 笔负面）全部终态、逐笔三处一致、零误暂停、零一级告警、无 SHORTFALL、授权为精确金额 | 未达终态的订单：查 relayer 告警，人工 retry / reject |
| T+70 → 100 | emergency | `--only emergency` | E1–E12、X2 / X3 / X6、M1–M4 / M6、三条件防误暂停、解除暂停不循环 | 未解释的暂停：负责人 `unpause` 前先核对 `watcher-alerts.jsonl` |
| T+100 → 110 | faults | `--only faults` | F1–F5、F7、F9–F11；F6 回滚只在 U6 授权后由 WANTON 运维执行 | — |
| T+110 → 118 | monitor + legacy | `--from monitor` | 三级告警覆盖、心跳；legacy 只提议（48h 背景项） | — |
| T+118 → 120 | 收尾 | 存档 `run-dir/report.md` 等，销毁 `keys.json` | — | — |

可以同时进行的：R1 / R2（负责人）、§6 的背景轨、同 nonce 替换 N1–N5（U7，要用单独的钥匙，避免 nonce 互相干扰）、告警通道到达测试（U8）。
不能同时进行的：同一钥匙在同一条链上的动作（脚本内部已按链并行，并在每次等待前设屏障对齐）。

**真实测试网比本地多出的耗时，以及压缩办法**

| 来源 | 估计 | 压缩办法 |
|---|---|---|
| WANTON 6 确认 | 每笔 6–12 秒 | 订单并发提交（脚本已经并发），等待互相重叠 |
| BSC 测试网 finalized | 约 1–5 块（< 5 秒） | 无需处理 |
| 水龙头 / 转账 | 不可控 | 全部挪到 T−1 天（U1） |
| RPC 限流 / getLogs 范围 | thirdweb 限 1,000 块；免费 drpc 只到 50 块 | `maxBlockRange=1000`；主线前加 1 个付费 RPC |
| 批量铸币 / 补 gas（约 210 笔 / 链） | 逐笔等待约 7 分钟 | `sendMany` 显式 nonce 一次发出，约 1 分钟 |
| 两条链各等一次窗口 | 加倍 | 两链并行 + 屏障（已实现） |
| 额度跨 UTC 日（5 笔 WAITING(quota)） | 最长 24h | 把主线排在 UTC 零点前后（北京时间 08:00 前后），否则列入背景项 |

## 6. 背景项：真实窗口在测试网各真等一次（不占 2 小时主线）

快速版只验证了「路径」，没有验证「真实时长」。建议 T+10 起，在两链另部署一套**原版**合约（`Deploy.s.sol`，另换一个部署者），后台跑下列项目，每类一次：

| # | 真实窗口 | 原版值 | 演练 | 层 |
|---|---|---|---|---|
| W1 | 时间锁延迟 | 48h | 提议 → 48h → 执行；到期前 24h / 6h 提醒各一次 | 测试网真等 |
| W2 | 退款等待 | 24h | `requestRefund` → 24h → `executeRefund`；B2W 入账退款同样一笔 | 测试网真等 |
| W3 | WL 交接 | 48h（+7 天接收窗口） | begin → 48h → accept | 测试网真等 |
| W4 | WL 恢复 | 7 天 | start → 7 天 → accept | 测试网真等 |
| W5 | 管理钱包恢复 / 提议过期 / 冷却 | 14 天 / 14 天 / 3 天 | — | 只在本地 fork（`anvil --fork` + 快进） |
| W6 | `releaseDelay` ≥ 6h、`b2wDelay` ≥ 10 分钟 | 参数下限 | 原版部署即用主网初值（12h / 15 分钟） | 测试网真等 |
| W7 | 签名有效期 | 24h | 硬件钱包签名后 23h 提交成功、25h 失败 | 测试网 |
| W8 | 额度跨 UTC 日 | 1 天 | 主线中 5 笔 WAITING(quota) 次日自动放行 | 测试网真等 |
| W9 | 旧单补付提议 | 48h（PR-8 工具固定，`verifyScheduledCall` 拒绝 < 48h） | legacy 阶段只提议，48h 后执行 | 测试网真等 |
| W10 | 监控宽限期 | 300 秒 / eta−180 秒 / 退款前 7,200 秒 | 用原版监控配置跑一轮核对 | 测试网 |
| W11 | 付款程序状态超时 | DETECTED 10 分钟 / QUEUED 宽限 30 分钟等 | 快速版下会出现超时噪音（本地彩排已见 STATE_TIMEOUT），原版下应安静 | 测试网 |

## 7. BSC 测试网 RPC 探测结果（2026-11-02，只读）

12 个公共节点中，能读事件的只有两个，可用于事件扫描：`bsc-testnet-rpc.publicnode.com`（getLogs ≥ 10,000 块）和 `97.rpc.thirdweb.com`（1,000 块）。

不够用的几类：
- bnbchain 官方 3 个 seed 节点：禁用 `eth_getLogs`（报 -32005），只能读区块高度和 finality。
- drpc：免费额度下 getLogs 只到 50–100 块，并间歇报错。
- onfinality：触发 429 限流。
- zan / tatum / blockpi：需要注册或 API key。blast 已关停，omniatech 返回 521。

建议配置：`maxBlockRange = 1000`，`minRpcAgreement = 2`。第 3 个独立服务商要用带 key 的节点（zan、Ankr、NodeReal、BlockPI 或 OnFinality 任一），这是 U2。

## 8. 与计划（`PR9-TESTNET-PLAN.md`）的差异和验证缺口

1. **合约字节码不同**：测试网主线跑快速版。主网字节码只在 §6 背景轨部署一次。计划 §12「本次测试使用的合约 commit = 送审冻结 commit」的含义因此变为「主源码 commit 相同，加上可审计的替换清单」。
2. 计划 §3.3「时间锁不可低于 48h、常量不能缩短」被用户拍板的快速版取代，**仅限测试网**。
3. 回滚 F6 和 rollback 演练在本地用 `evm_snapshot` / `evm_revert` 模拟，WANTON 上仍需 A8 授权由运维执行。
4. relayer 在彩排中用 PGlite，服务器 A / B 尚未建；测试网正式跑时，relayer / 监控是否放到服务器 A / B 测试实例上，待确认。
5. 测试网没有检查点：某阶段失败后重跑，必须先人工核对上次已执行到哪一步（交易已上链不可撤）。本地彩排有检查点。
6. 告警只写入 jsonl。电话 / 短信 / 24h 重复、外部心跳在监控停报时打电话，都需要真实通道（U8）。
7. N1–N5（同 nonce 替换）不在彩排脚本内，按计划 §7 单独授权（U7）。
8. 计划 §6.2 的「触发审核 5 笔」：`amount_limit` 3 笔按「拒绝 → 作废 → 退款」走。原因是批准后金额仍超单地址额度，合约会再次拒绝，PR-3 会让它停在 WAITING(quota)。`whitelist_removed` 2 笔一批准、一拒绝。

## 9. 本地彩排结果

见 GATE2-REQUEST PR-9-prep 报告（快进模式全流程约 40 秒，149 项判据；真实时钟模式分阶段耗时见该报告的耗时表）。

## 10. 通用回退

- 监控误暂停：负责人先核对告警原因，再 `unpause`（两个钱包都可以）。旧事件只告警（`MISMATCH_ACKNOWLEDGED`），不会循环暂停。
- 付款钥匙疑似泄露：管理钱包立即 `revokeKey` → 取消排队项 → `unpause` → 经时间锁补发（快速版 2 分钟）。
- 订单卡住：FAILED 由运维 `retryFailed` 或 `rejectFailed`；REVIEW 由负责人签名审核（EIP-191，管理钱包）。
- 任何步骤失败且原因不明：停止，保留 `run-dir`，不要重跑；把 `rehearse.log` 末尾交给总控。
