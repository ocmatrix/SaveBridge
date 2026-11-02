# PR-6 管理后台 admin.wanto.pro（含 /handover）+ 离线核对工具：实现说明、对齐点、偏差与待定

> 依据：`docs/DESIGN.md` v0.9.4（§4、§5、§8.2–8.4、§11、§12、§13 PR-6 行）、`docs/PR1-NOTES.md` §5（合约契约）、`docs/PR3-NOTES.md` §4.2（审核签名、只读 API、SIWE 占位）。分支 `pr-6-admin`（基于 `pr-3-relayer`）。
> 范围：只写代码与本地测试。**未部署 Cloudflare、未连接任何真实网络、未发送任何真实链上交易、未接触任何真实私钥。** 测试只用本机 anvil（127.0.0.1，31337 当 WANTOS、31338 当 BSC），钥匙全部 `generatePrivateKey()` 临时生成。17 条已拍板决定未改动。

## v0.9.5 范围变更：删除受控集合（用户决定，第 2 轮）

用户决定：**风控只靠白名单，不叠加其他规则**（白名单地址基本都是提前报备、公司实名登记的）。管理后台中与"资金来源 / 受控来源"有关的部分整体删除（单独一个提交）：

| 删除 / 改动 | 内容 |
|---|---|
| 页面 | 删除 `/controlled`「受控集合」页（`src/pages/ControlledPage.tsx`、路由与导航项）：增删、审计日志与推送说明、内置附录 A 列表 |
| 接口客户端 | `src/lib/api.ts` 删除 `controlled()`、`changeControlled()`、`ControlledItem`；`AddressInfo` 删除 `suspicious`；`ReviewOrder` 删除 `rules`、`sourcePath`。Worker 是通用转发，无需改动 |
| 白名单页标记 | `src/lib/risk.ts` 删除 🔴 受控来源、🟠 可疑/来源命中、内置附录 A（`APPENDIX_A`）、`defaultChecked`/`needsConfirm`；页面删除"🔴 默认不勾选、需二次确认"及确认框，清单载入后全部默认勾选。保留 🟡 不在网体内（来自付款程序的网体数据，不依赖受控集合，取不到时不标）和 ⚪ 合约地址（两链 `getCode`） |
| 订单审核页 | 不再展示"命中规则 / 资金来源路径"；只展示订单事实（方向、编号、用户、收款人、金额、eventKey、级别）与付款程序原因码的说明，其中 `onchain_mismatch` 显示为"来源检查冻结：源链订单与本单不一致"。通过 / 拒绝 / 批量作废 / 批量退款申请保留 |
| 测试 | 删除：`component/pages`「接口受控集合不覆盖附录 A」「受控集合列出与添加」、`component/whitelist`「确认勾选 🔴 行」、`unit/misc`「🔴 默认不勾选」；改写：`component/whitelist` 首个写入用例（全部默认勾选、无 🔴/🟠）、`component/pages` 审核用例（断言原因说明、无"命中规则/资金来源路径"）、`unit/misc` 标记用例（只剩 🟡⚪） |
| 变异 | 第 0 轮 M22（🔴 默认勾选）、第 1 轮 R26（接口受控集合覆盖附录 A）对应的代码已删除，不再适用 |
| 待用户确认 | 原 B1（移除模式下 🔴 默认不勾选）随之作废 |

## 1. 文件

| 路径 | 内容 |
|---|---|
| `packages/offline-check/offline-check.mjs` | **离线核对工具**：单文件、零依赖、Node ≥ 18，自带 keccak-256（不用任何库）；读原始地址文件 → rules v1 校验/去重/排序/切批 → `listHash`、`count`、两条链的 EIP-712 **domain hash / message hash / digest**；`--expect-list-hash` 比对屏幕；`--decode` 解码时间锁提议 calldata（含 schedule/scheduleBatch 内层） |
| `packages/offline-check/vectors.json` | **共享测试向量**（页面与工具用同一份）。解析结果手写，哈希由 viem 计算（与两边实现都独立）；生成脚本 `test/gen-vectors.mjs` |
| `packages/offline-check/offline-check.d.mts` | 类型声明（只给 TS 测试用） |
| `apps/admin-web/src/lib/*.ts` | 纯逻辑（全部可在 anvil 上测）：`config` 构建期配置；`chain` 客户端/Signer 接口/错误解码/先模拟再发送；`state` 两链角色与交接状态（**只读合约**）；`perm` 按钮门禁；`normalize` 页面侧 rules v1 与 EIP-712；`whitelist` 两链批次写入（可续跑）、历史与两链差异；`timelock` 提议列表/解码/提议/取消/执行；`params` 收紧/放宽判定与校验；`handover` 地址证明、交接/恢复动作、"只完成一条链"检测；`emergency`；`review` 审核签名消息与批量作废/退款；`siwe`；`api`（Worker 客户端）；`risk` 风险标记；`reserves` |
| `apps/admin-web/src/pages/*.tsx` | 8 个页面（§3） |
| `apps/admin-web/src/wallet/wagmi.tsx` | wagmi 注入式钱包 → `Signer`（每个链上请求前切链；签名都在钱包里） |
| `apps/admin-web/src/csp.ts` + `vite.config.ts` | 构建时生成 Cloudflare Pages `_headers`（严格 CSP、HSTS、禁止嵌入、no-referrer、no-store） |
| `apps/admin-web/wrangler.toml` | Pages 项目配置（**未部署**） |
| `apps/admin-web/worker/forward.ts` + `worker/wrangler.toml` | 管理接口转发 Worker（`/api/admin/*` → 付款程序 `/admin/*`，只转 GET/POST、只带 Authorization/Content-Type，不信任、不校验）（**未部署**） |
| `apps/admin-web/test/{unit,integration,component}` | 见 §8 |

## 2. 离线核对工具（DESIGN §8.3）

```
node offline-check.mjs list.csv --action add --contract 0x<桥> \
     --bsc-nonce N --wantos-nonce M --deadline <unix> [--bsc-chain-id 56] [--wantos-chain-id 13555] \
     [--batch K] [--expect-list-hash 0x<屏幕上的>] [--list] [--json]
node offline-check.mjs --decode 0x<calldata>
```

**rules v1**（页面 `src/lib/normalize.ts` 与工具逐条相同，工具文件头有全文）：去 BOM、按 `\r\n|\n|\r` 分行；空行/`#` 行忽略；每行取第一个字段（`, ; 制表符 空格` 之前），去成对引号；第一条有效行若不以 `0x` 开头视为表头跳过一次；必须 `0x`+40 位十六进制，**大小写混写必须是正确 EIP-55**，零地址拒绝；小写去重（重复只提示）；数值升序；按 ≤ 500 顺序切批；**有任何错误就不出哈希**。多批时第 i 批 nonce = 起始 nonce + i。

输出与合约完全一致（PR1-NOTES §5.4；两个 typehash 已用测试钉死）：`listHash = keccak256(abi.encode(address[]))`；domain name `BscVaultV2` / `WantosBridgeV2`、version `1`；message hash = structHash；digest = `keccak256(0x1901‖domain‖message)`。退出码：0 一致 / 1 文件错误 / 2 与屏幕 listHash 不一致 / 64 参数错误。文本与 `--json` 两种输出用同一个判定（第 1 轮 B8）。

**参数严格校验（第 1 轮 A3，fail-closed）**：只接受 `--action --contract --bsc-nonce --wantos-nonce --deadline --bsc-chain-id --wantos-chain-id --batch --expect-list-hash --decode --list --json`；未知选项（含拼错）、`--x=y` 写法、重复选项、多于一个文件参数、空值、缺 `--bsc-nonce/--wantos-nonce/--deadline`、chainId/batch 不是正整数（`0` 不再回落 56）、`--expect-list-hash` 不是 `0x`+64 位十六进制、`--batch` 超出范围 —— 一律退出 64，不打印任何哈希。

**`--batch K`（第 1 轮 A2）**：只算第 K 批（从 1 起），**直接使用给定 nonce**（= 页面「准备本批」时链上的 nonce）。不带 `--batch` 时算全部批次、第 i 批 nonce = 给定值 + i；此时若有多批，`--expect-list-hash` 被拒（64），避免"listHash 一致但 message hash 用错 nonce"。

页面在「准备本批」后直接显示可复制的完整命令（含 `--batch`、两链 nonce、deadline、`--expect-list-hash`）；组件测试用页面生成的命令原样跑工具，断言两条链的 message hash 与屏幕一致。

## 3. 管理后台页面（DESIGN §8.2）

所有写按钮都由 `perm.gate()` 依据**合约读数**（`timelock.adminWallet()`、`bridge.whitelistManager()`、待接收/恢复候选、暂停/冻结/恢复标志、时间）决定可用性；不可用时按钮旁显示原因（如"当前钱包不是 BSC 的白名单钱包（链上为 0x…）"）。页面顶部显示连接钱包的链上身份。服务器数据只用于审核订单列表、受控集合、参考信息、报告，**从不用于判定角色**。每笔交易先 `simulateContract`（以连接钱包身份）拿到解码后的回滚原因，再交给钱包。

| 页面 | 实现 | 门禁 |
|---|---|---|
| `/` 白名单 | 上传 CSV/TXT/粘贴 → rules v1 → 错误逐行列出并阻断 → 逐行参考信息（按 500 行分页加载：两链是否合约、WANTOS-USDT 余额、两链当前白名单；网体/上级/历史跨出走接口，不可用显示 —）→ 🟡⚪ 提示（不预选、不拦截；v0.9.5）→ 添加/移除 → 选批 → 「准备本批」(deadline = 链上时间 + 23h；读取并固定两链 nonce 与哈希) 显示第几批、listHash、count、两链 nonce/domain hash/message hash 和离线命令（**全部取自已准备的批次，不读表单**）→ 「签名并写入两条链」按 §4.4 顺序逐链（签名 → 提交 → 等回执），进度逐链可见；失败停在该链，「重试未完成的链」只补未完成的（复用已签签名；链上已是目标状态直接跳过）。**切换添加/移除、改清单、改勾选、换批次都会作废已准备的批次**（第 1 轮 A1）；**「准备本批」与「签名并写入」进行中，单选框、地址框、文件选择、勾选框、批次选择全部禁用；另有代数计数器：准备期间表单若仍被改动，读链结果丢弃并提示「准备期间表单已改动，请重新准备」；签名期间若被改动，`runJob` 在每条链开始前、签名前、签名后各检查一次，立即停止、不提交（第 2 轮 A-1）**；**签名/提交前链上 nonce 与准备时不同、或 deadline 将到，立即停止并要求重新准备、重新离线核对，绝不静默重签**（第 1 轮 B2）；重新准备先清掉旧哈希。页面明示：提交服务接通前每批每条链要在钱包确认两次（签名 + 发交易），两条链共 4 次，白名单钱包两条链都要备 gas（BNB / WANT）（B4）。另有：当前白名单（事件折叠）、批次记录、紧急移除记录、两链不一致列表、每条链「作废当前批次 nonce」 | 白名单钱包（两链）；恢复中禁写；冻结时禁止添加 |
| `/emergency` 紧急 | 紧急移除的地址输入严格解析：第一行不是地址算错误，不当表头跳过（第 1 轮 B7）。每条链：暂停、解除暂停、冻结白名单、否决白名单钱包交接、**紧急移除（未冻结时先发 `freezeWhitelist` 再 `emergencyRemove`，PR1-NOTES §5.11a-1）**、读取现有付款/暂停钥匙并吊销 | 暂停/解除：管理或白名单钱包；其余管理钱包 |
| `/timelock` 时间锁 | （第 1 轮 B3）每个调用显示**完整目标地址**并标【桥】【时间锁】【其他】，只按目标自己的 ABI 解码（桥 ABI 只解码目标为本链桥的调用，时间锁 ABI 只解码目标为本链时间锁的调用），【其他】与无法解码的一律红字、不解码。两链全部提议（`CallScheduled`/`CallSalt` + 实时 `getOperationState/getTimestamp/isOperationExpired/proposalEpoch`）：类别（升级/提取/参数/授予钥匙/更换管理钱包…）、逐个调用解码（未知 selector 标"无法解码，不要执行"）、等待中/可执行/已执行/已取消/已过期/已作废、倒计时与过期时间；取消、执行。执行回滚为 `BridgeCheckFailed`、空回滚或无法解码 → 显示"新实现不合格，不要重试，到期前取消换实现重提"（PR1-NOTES §5.11a-4） | 取消：管理或白名单钱包；执行：任何已连接钱包、就绪、无恢复 |
| `/params` 参数 | 两链当前值（整币/秒）→ 编辑 → 每项标"收紧 / 放宽（需时间锁）" → 全部收紧：管理钱包一笔 `setParams` 立即生效；有任何放宽：生成时间锁提议（`schedule(bridge, setParams)`，delay = `getMinDelay()`，随机 salt）。前端按 PR1-NOTES 范围与约束预检（合约仍是权威），显示跨链一致性提示与收紧顺序；WANTOS `supplyCeiling` 降低立即、提高走时间锁 | 管理钱包；暂停期间不能提议放宽 |
| `/handover` 交接与恢复 | 显示两链桥与时间锁地址、两链当前两个钱包；**新持有人签名生成地址证明**（personal_sign 固定文本，见 §5）→ 现任粘贴验证（`verifyMessage`，EOA 与 ERC-1271 都支持；验签出错按失败处理；签名时间超过 7 天或在未来 10 分钟以上拒绝）→ 自动填入新地址，之后若手改的新地址与已验证地址不同，红条提示（第 1 轮 B6）；每条链：白名单钱包交接（发起/取消或否决/接收，倒计时）、白名单钱包恢复（启动/取消/接收）、管理钱包交接（提议 `transferAdmin`；执行在时间锁页；接收 `acceptAdmin`）、管理钱包恢复（启动/取消/接收）；**任一项只在一条链完成时顶部红条提示去哪条链补签** | 按合约：现任 WL / 管理钱包 / 被指定的新地址（含等待期、有效期、恢复中检查） |
| `/review` 订单审核与退款 | 经 Worker 读 REVIEW 订单（订单事实、级别、付款程序原因码说明，如 `onchain_mismatch` 来源检查冻结；v0.9.5 起不展示资金来源规则）→ 通过/拒绝：管理钱包对 PR-3 `reviewMessage` 文本 personal_sign（付款链 chainId，1 小时有效）→ 提交给付款程序验签；批量作废（BSC `voidSourceBatch`）、批量退款申请（WANTOS `requestRefundBatch`），订单号支持 `1, 3-5` | 审核：付款链管理钱包；作废：管理或白名单钱包；退款申请：管理钱包 |
| `/reserves` 储备与对账 | 链上只读：两链桥余额、约几天用量、今日已用/日额度、WANTOS 总量/上限；经接口读对账、告警、每日白名单变更报告 | 只读 |

接口会话：首次调用管理接口时，连接的钱包签一条 EIP-4361（SIWE）消息（15 分钟有效），之后同一会话复用；请求头 `Authorization: SIWE <base64(消息)>.<签名>`。

## 4. 与 PR-1 / PR-3 的对齐点

| 项 | PR-6 做法 | 依据 / 测试 |
|---|---|---|
| EIP-712 批次 | domain/typehash/listHash/structHash 与合约逐字节一致；页面经 viem、工具经自写 keccak，同一向量；anvil 上合约接受页面签的批次 | PR1 §5.4；`normalize.test`、`offline-check.test`、`whitelist.test` |
| 写入顺序 | 添加先 BSC 后 WANTOS；移除先 WANTOS 后 BSC；失败即停，不越序 | DESIGN §4.4；`whitelist.test` |
| 非白名单钱包 | 页面按钮不可用；即便绕过，合约 `InvalidSigner` 拒绝，页面显示且链上不变 | `whitelist.test`、组件测试 |
| 先冻结再紧急移除 | 自动先 `freezeWhitelist` | PR1 §5.11a-1；`governance.test`、组件测试 |
| 时间锁自检失败 | 显示"不合格，不要重试" | PR1 §5.11a-4；`misc.test` |
| 角色读取 | `timelock.adminWallet()`、`bridge.whitelistManager()`、`pendingWhitelistManager()`、`whitelistRecovery()`、`pendingAdmin()`、`adminRecovery*()`、`epoch()` | PR1 §5.5/§5.9 |
| 审核签名 | 文本与 `packages/relayer/src/review.ts reviewMessage` **逐字节相等**（测试直接比对 relayer 的函数），chainId = 付款链（W2B→BSC，B2W→WANTOS），有效期 1h（≤ 24h），每次决定单独签名 | PR3 §4.2；`governance.test`、组件测试（取 POST 体用 relayer 函数验签） |
| 管理接口 | 只经 Worker；Worker 不校验、不持密钥；付款程序须自己验 SIWE 与签名 | PR3 §2.8、Q5 |
| ABI | 只用 `@bridge/abi`（由合约生成） | — |

## 5. 偏差（保守选择，均未改变 17 条决定）

| # | 偏差 | 理由 |
|---|---|---|
| D1 | **白名单批次由页面用已连接钱包提交**（`applyWhitelistBatch` 任何人可调）。若连接的就是白名单钱包，每批 = 2 次 EIP-712 签名 + 2 笔交易确认 | PR-3 提交服务尚无 `submitWhitelistBatch`（PR3 Q6）。接口一旦存在，只需把 `runJob` 里的 `send(...)` 换成 POST 签名给提交服务（见 Q1），即回到"一批 = 两次签名"（决定 16） |
| D2 | 两条链共用一个 deadline（准备时 = 链上时间 + 23h），离线工具只需一个 `--deadline`；剩余不足 5 分钟、或链上 nonce 与准备时不同，都停止并要求重新准备（哈希会变，须重新离线核对）；未经「准备」的批次一律拒绝签名 | 合约要求提交时 deadline ≤ now + 24h（PR1 D11） |
| D3 | 某条链上该批地址**已全部**是目标状态 → 该链跳过、不签名；"两链不一致补齐" = 把同一清单按原操作再提交一次 | 让重试幂等，少签名 |
| D4 | rules v1 的具体口径（只取第一列、表头只跳一次、混写大小写必须是正确校验和、任何错误都拒绝出哈希） | 规格只写"校验、去重、排序"；取最严格且最简单 |
| D5 | 在页面上取消勾选会使清单与原始文件不同 → 页面明确提示"离线核对前先在原始文件中删掉这些地址"，并可导出**已准备批次**的清单（文件名与内容都取自已准备的批次；页面注明离线核对请用原始文件） | 离线核对必须基于负责人自己的文件，页面不能替他改文件 |
| D6 | （v0.9.5 已删除：原 🔴 受控来源判定） | — |
| D7 | 新持有人的"证明地址"为 personal_sign 固定文本的 JSON（离线传给负责人，页面本地验证），不经服务器 | /handover 只读链上数据（§8.4）；不新增后端 |
| D8 | 历史/提议/钥匙持有人通过公共 RPC `getLogs` 从 `VITE_*_FROM_BLOCK` 起按 5 万块分段扫描；读区块高度时 `cacheTime: 0`（测试发现 viem 默认缓存会漏掉刚上链的提议） | 简单；若 RPC 限制更严，改用付款程序索引接口 |
| D9 | 只支持注入式钱包（MetaMask/Rabby/OKX/TP 等及其连接的硬件钱包），未接 WalletConnect | 严格 CSP、无第三方模态；多签见 Q3 |
| D10 | 时间锁提议 salt 随机，delay = 当前 `getMinDelay()`；执行按钮对任何已连接钱包开放（合约本就允许任何人执行） | §4.2 |
| D11 | 审核页金额按 18 位小数显示；参考信息里的余额读代币 `decimals()` | 仅显示 |
| D12 | 离线工具的 calldata 解码只覆盖本系统合约函数表（selector 由测试对照 ABI 校验）、嵌套一层 | §8.3"也可解码时间锁提议"的最小实现 |

## 5a. 待用户确认（第 1 轮审查留给用户）

| # | 事项 | 现状与风险 |
|---|---|---|
| B1 | ~~移除模式下 🔴 默认不勾选~~ | **已作废**：v0.9.5 范围变更删除了 🔴 标记，清单载入后全部默认勾选 |

## 6. 待定项（需总控 / 负责人确认；当前均按最保守、最简单实现）

| # | 问题 | 当前做法 / 建议 |
|---|---|---|
| Q1 | 提交服务代提交白名单批次的接口（PR3 Q6） | 建议 `POST /admin/whitelist/submit {side, addrs, allowed, nonce, deadline, signature}`，提交服务按顺序发 `applyWhitelistBatch` 并回报 txHash；接上后页面只签名 |
| Q2 | 付款程序 `/admin/*` 端点与 `AdminSessionVerifier`（PR3 Q5）尚未实现 | PR-6 提议的端点：`GET /admin/orders?status=REVIEW`、`POST /admin/review {eventKey,decision,expires,signature}`（即 `ReviewService.decide`）、`POST /admin/address-info {addrs}`、`GET /admin/report`；会话头 `SIWE <base64(EIP-4361)>.<sig>`，域名 `admin.wanto.pro`、15 分钟、签名者须是链上管理钱包（审核）或白名单钱包（只读）。形状见 `src/lib/api.ts` |
| Q3 | 管理钱包交接给多签后：审核签名（ERC-1271，relayer 已支持）、SIWE、页面发交易的流程 | 页面目前假设连接的是 EOA/硬件钱包；多签需另设计（例如 Safe 交易构建），PR-9 前定 |
| Q4 | 单批上限 500 待 PR-0 ④（硬件钱包显示能力）定稿 | 页面与工具常量 500，改一处即可 |
| Q5 | FAILED 订单人工"重试 / 拒绝"（PR3 §4.2 建议 `decision: retry|reject-failed`） | 未在页面开放（付款程序还没有对应签名格式与端点） |
| Q6 | 每日变更报告、告警、对账的数据源（PR-7/PR-3） | 页面只按 `/admin/report` 展示 |
| Q7 | 网体、上级、历史跨出、可疑名单的数据源（PR-4） | 页面按 `/admin/address-info` 展示，缺省为 — |
| Q8 | 仓库根 `packageManager: "pnpm@10"` 不是完整版本（PR3 Q8） | 未改；本地用 pnpm 10.34.5 直接调用 |

## 7. Cloudflare 与供应链（DESIGN §8.4；本 PR **不部署**）

- 构建：`pnpm --filter @bridge/admin-web build:prod`（需要 `.env.production`，模板 `.env.example`；只含公开值）。占位构建 `build` 用 `.env.placeholder`，页面会显示"占位构建"。
- `dist/_headers`：`default-src 'none'`、`script-src 'self'`、`connect-src` 只含两条链 RPC 与管理接口源、`frame-ancestors 'none'`、HSTS、`no-referrer`、`no-store`。无内联脚本、无第三方脚本或字体。
- Pages：`apps/admin-web/wrangler.toml`（项目名 `wanto-admin`）。Cloudflare Access 在 Zero Trust 控制台配置：保护 `admin.wanto.pro/*`，**放开 `/handover`**（SPA 路由，`/handover` 由 Pages 回落到 index.html）。
- Worker：`apps/admin-web/worker/`，路由 `admin.wanto.pro/api/*`，`RELAYER_ORIGIN` 部署时设置。
- 发布前：依赖已由 `pnpm-lock.yaml` 锁定；发布产物（`dist/` 各文件 sha256）与离线工具 `offline-check.mjs` 的 sha256 在两个独立渠道公布。

## 8. 测试

运行：`cd apps/admin-web && pnpm exec vitest run [--coverage]`；`cd packages/offline-check && pnpm exec vitest run`；`pnpm exec tsc --noEmit -p apps/admin-web/tsconfig.json`。集成/组件测试在本机起两个 anvil（缺 `out/` 时 `forge build` 一次），进程带 `--config-out <tmp>/wantos-admin-web-anvil-*` 标记，退出时按自己的 PID 停止。

结果见文末「验证结果」。

### 8.1 DESIGN §13 PR-6 验收 ↔ 测试

| 验收 | 测试 |
|---|---|
| 篡改页面后签名的批次被离线核对拦下 | `integration/whitelist.test.ts` › tamper scenario（页面偷加地址 → 工具 listHash/count/message/digest 全不同、`--expect-list-hash` 退出 2；页面显示真哈希但让钱包签别的 → digest 不同；诚实页面 → 一致） |
| 非白名单钱包无法写入 | `whitelist.test` › non-whitelist wallet（合约 `InvalidSigner`，链上不变）；`component/whitelist.test` › 未连接/错钱包按钮不可用且有原因 |
| 两链部分成功可补齐 | `whitelist.test` › partial failure（重试只写 WANTOS、复用签名；nonce 变化后重签）；`component/whitelist.test` › 失败可见 + 重试按钮 |
| 紧急操作和批量作废可用 | `governance.test` › emergency、batch void / refund；`component/pages.test` › emergency |
| /handover 全流程 | `governance.test` › 证明 → 两链发起 → 等待期门禁 → 两链接收 → 旧钱包失效；只完成一条链的提示；否决；两种恢复；管理钱包交接（提议 → 48h → 执行 → 两链接收） |
| 时间锁取消/执行 | `governance.test` › timelock panel；`component/pages.test` › timelock |
| 审核签名格式与 PR-3 一致 | `governance.test`、`component/pages.test` › review（用 relayer 自己的 `reviewMessage` 验签） |
| 页面与工具共用规则 | `unit/normalize.test`（向量 + 30 轮随机清单对比）、`offline-check.test` |

## 9. PR-9 / PR-10 上线门槛（PR-6 相关）

1. Q1 提交服务接口接通（否则每批多两次交易确认）；Q2 付款程序 `/admin/*` 与 SIWE 校验实现并在测试网联调。
2. 在 WANTON 1345 + BSC 测试网用**硬件钱包**走一遍：一批白名单（含离线工具比对 domain/message hash 与硬件屏幕）、部分失败补齐、紧急移除、/handover 两种交接与两种恢复、时间锁取消与执行、审核通过/拒绝。
3. 确认硬件钱包对 EIP-712 的显示（PR-0 ④）与 500 上限（Q4）。
4. Cloudflare：Qbit 账户硬件密钥两步验证、Access（放开 `/handover`）、部署令牌最小权限；`dist/` 与 `offline-check.mjs` 哈希双渠道公布。
5. 离线工具拷到**另一台设备**并核对其 sha256。

## 10. 需要负责人提供

1. 两个钱包地址（管理钱包、白名单钱包；硬件钱包，两者不同），以及部署后的桥合约地址与部署区块（填 `.env.production`）。
2. 域名确认：`admin.wanto.pro`（DESIGN §14-6），Qbit 账户下 Pages 项目与 Worker 路由的创建授权。
3. BSC / WANTOS 的生产 RPC 地址（会进 CSP 与包内，必须是公开地址，不能带密钥）。
4. 付款程序管理接口的对外地址（Worker 的 `RELAYER_ORIGIN`）。

## 11. 共享文件改动

- `pnpm-lock.yaml`：新增 `apps/admin-web`、`packages/offline-check` 的依赖条目（`pnpm install` 生成）。根 `package.json`、`pnpm-workspace.yaml` 未改（`apps/*` 已在工作区内）。

## 验证结果（本地，2026-11-02，第 2 轮修复后）

| 项 | 结果 |
|---|---|
| typecheck | `tsc --noEmit -p apps/admin-web/tsconfig.json` 通过 |
| admin-web 测试 | **81 通过 / 0 失败**（unit 21、integration 32、component 28；9 个文件） |
| offline-check 测试 | **30 通过 / 0 失败** |
| 覆盖率 admin-web（v8） | 全部 行 94.1% / 语句 92.1% / 分支 85.8% / 函数 83.4%；`src/lib` 行 98.2% / 分支 91.1%；`src/pages` 行 86.5% |
| 覆盖率 offline-check | 行 97.5% / 分支 96.4% |
| 构建 | `vite build --mode placeholder` 通过 |
| `offline-check.mjs` sha256 | `c96df61116f015f035bcf9b15122db763e297302f4e19f0426504d44e829a664`（第 2 轮：删除 `--batch-size`） |

## 第 2 轮审查修复

| 项 | 修复 | 新增测试（对旧代码 / 变异体为红） |
|---|---|---|
| A-1 | ①代数计数器：任何表单改动 `gen++`；准备返回时代数不符 → 丢弃结果、不落屏，提示「准备期间表单已改动，请重新准备」。②准备或签名写入进行中，单选框、地址框、文件选择、勾选框、批次选择全部禁用。③`runJob` 新增 `shouldStop`，在每条链开始前、签名前、签名后（提交前）检查；页面在签名期间表单被改动时停止、不提交、不复活旧批次，提示「签名期间表单已改动，已停止」 | `component/race`（P1/P3 准备中全部控件禁用、点「移除」无效且批次与表单一致；P2 批次选择锁定；代数守卫：准备中仍送达的改动使结果被丢弃；签名中全部控件禁用、仍送达的改动使运行停止且 0 次提交）；`integration/whitelist` › shouldStop 两个用例（签名后停止不提交；签名前停止不打开钱包；开始即停止不读链） |
| 随修 1 | — | 改勾选作废（M06）、改清单作废（M07）、两链逐行 nonce/domain/message（M04/M08）、恰好 2 批 + expect 无 `--batch` → 64（M20）、`--batch` 等于最后一批可用、超出 → 64（M18）、时间锁前缀相似目标显示完整地址且为【其他】、「附带 5 wei」（M36/M34） |
| 随修 2 | 删除 `offline-check --batch-size`（固定 500，与页面相同）；传入即「未知选项」64 | `offline-check` 测试同步 |
| 随修 3 | 导出按钮只在已准备后可用，文件名与内容取自已准备批次；注明「离线核对请用你自己的原始文件」 | `component/whitelist` › export |

### 第 2 轮变异测试（目录 `scratchpad/pr6-lane6-r2`，独立副本，27 个）

第一遍：杀死 23 / 存活 4（S07a、S09、S10、S19）。为 S09、S10 补 `shouldStop layers` 测试后重跑均杀死。最终 **25 杀死 / 2 存活（等价）**。

| # | 针对 | 变异 | 结果 / 杀死它的测试 |
|---|---|---|---|
| S01 | A-1 代数 | 准备返回后不比对代数 | 杀死：component/race › generation guard |
| S02 | A-1 代数 | resetJob 不递增代数 | 杀死：component/race › generation guard |
| S03a–f | A-1 禁用 | 文件选择 / 地址框 / 添加 / 移除 / 勾选框 / 批次选择 各自去掉 disabled | 全部杀死：a–e 由 race › P1/P3，f 由 race › P2 |
| S04 | A-1 禁用 | 签名期间不锁 | 杀死：race › 签名期间 |
| S05 | A-1 禁用 | 准备期间不锁 | 杀死：race › P1/P3 |
| S06 | A-1 runJob | 页面不传 shouldStop | 杀死：race › 签名期间（出现提交） |
| S07a | A-1 runJob | 进度回调不检查代数 | 存活（等价：停止后 runJob 立即返回，不再回调进度） |
| S07b | A-1 runJob | 结束后不检查代数、复活旧批次 | 杀死：race › 签名期间 |
| S08 | A-1 runJob | 去掉签名后（提交前）检查 | 杀死：race › 签名期间；integration › shouldStop |
| S09 | A-1 runJob | 去掉签名前检查 | 补测后杀死：integration › shouldStop layers |
| S10 | A-1 runJob | 去掉每条链开始前检查 | 补测后杀死：integration › shouldStop layers |
| S11 | M06 | 改勾选不作废 | 杀死：whitelist › M06 |
| S12 | M07 | 改清单不作废 | 杀死：whitelist › M07 |
| S13 | M20 | 多批判定改成 >2 | 杀死：offline-check › exactly two batches |
| S14 | M18 | `--batch` 等于最后一批被拒 | 杀死：offline-check › `--batch K` |
| S15 | M04 | 每链行显示另一条链的 nonce | 杀死：whitelist › M04/M08 |
| S16 | M08 | 每链行显示另一条链的 domain hash | 杀死：whitelist › M04/M08 |
| S17 | M36 | 目标地址截短 | 杀死：pages › timelock targets |
| S18 | M34 | 不显示附带 wei | 杀死：pages › look-alike target and value |
| S19 | 导出 | 文件名取表单 | 存活（等价：任何表单改动都作废批次，导出又只在有批次时可用，两者必然相同） |
| S20 | 导出 | 未准备也可导出 | 杀死：whitelist › export |

## 第 1 轮修复后的验证结果（历史）

| 项 | 结果 |
|---|---|
| typecheck | `tsc --noEmit -p apps/admin-web/tsconfig.json` 通过 |
| admin-web 测试 | **73 通过 / 0 失败**（unit 21、integration 30、component 22；8 个文件） |
| offline-check 测试 | **29 通过 / 0 失败**（含真实子进程 CLI、共享向量 7 组、fail-closed 参数 30 种错误调用） |
| 覆盖率 admin-web（v8） | 全部 行 92.8% / 语句 91.3% / 分支 85.9% / 函数 82.8%；`src/lib` 行 98.2% / 分支 91.1%；`src/pages` 行 83.3% |
| 覆盖率 offline-check | 行 97.5% / 分支 96.4% |
| 构建 | `vite build --mode placeholder` 通过，产出 `dist/_headers` |
| `offline-check.mjs` sha256 | `ad104e35de48bc8d806053802978bb35812500c4ef36facf576886a7cee88776`（第 1 轮修复后） |

## 第 1 轮审查修复（A1–A3 阻塞、B2–B8 随修）

| 项 | 修复 | 新增测试（对旧代码 / 变异体为红，对修复后为绿） |
|---|---|---|
| A1 | 切换添加/移除（以及改清单、改勾选、换批次）一律作废已准备的批次；「操作」、哈希、离线命令只取自已准备的批次 | `component/whitelist` › A1（添加→移除、移除→添加都要求重新准备；移除真正签名 2 次并落链） |
| A2 | 工具 `--batch K`（只算第 K 批、nonce 用给定值）；页面命令带 `--batch`；多批无 `--batch` 时 `--expect-list-hash` 被拒 | `component/whitelist` › A2（501 地址、第 2 批、两链 nonce 不同，用页面生成的命令原样跑工具，两链 message hash 等于屏幕）；`offline-check` › `--batch K` |
| A3 | 参数解析 fail-closed（见 §2） | `offline-check` › fail-closed（30 种错误调用全部 64 且不打印哈希，含真实子进程） |
| B2 | 签名/提交使用准备时的 nonce；nonce 变了或待签内容与准备时哈希不同 → 停止、要求重新准备（重试按钮不可用并写明原因）；未准备的批次拒绝；准备开始先清旧哈希 | `integration/whitelist` › 两个用例；`component/whitelist` › B2（含准备失败时旧哈希消失） |
| B3 | 时间锁调用显示完整目标地址 + 【桥/时间锁/其他】，按目标 ABI 解码，【其他】红字不解码 | `integration/governance` › decode by target；`component/pages` › timelock targets |
| B4 | 白名单页明示：每批每条链 2 次确认、两链共 4 次；两链都要 gas | `component/whitelist`（文字断言） |
| B5 | — | `integration/params`（逐字段方向与合约 `NotTightening(i)` 对照，两条链，含 releaseDelay/b2wDelay）；`unit/misc` › 完整 CSP 字符串、Worker `/api/x` 404、验签异常不当通过；`component/pages` › 接口受控集合不覆盖附录 A |
| B6 | 证明 issuedAt：超过 7 天或在未来 10 分钟以上拒绝；新地址与已验证地址不同时红条 | `unit/misc`、`component/pages` › handover |
| B7 | 紧急移除输入不跳表头 | `component/pages` › emergency strict |
| B8 | 文本与 `--json` 共用同一判定 | `offline-check` › `--batch K` 用例中两种模式逐一断言 |

### 第 1 轮变异测试（目录 `scratchpad/pr6-lane6-r1`，独立副本，32 个）

第一遍：杀死 25 / 存活 7（R01、R03、R04、R07、R11、R16、R22）。针对 R01、R07、R11、R16 补测试后重跑：全部杀死。最终 **29 杀死 / 3 存活（均为等价变异）**。

| # | 针对 | 变异 | 结果 | 杀死它的测试 |
|---|---|---|---|---|
| R01 | A1 | 「添加」单选不作废批次 | 补测后杀死 | component/whitelist › A1（移除→添加） |
| R02 | A1 | 「移除」单选不作废批次 | 杀死 | component/whitelist › A1 |
| R03 | A1 | 「操作」读表单而非批次 | 存活（等价：任何切换都会先作废批次，有批次时两者必然相同；保留为纵深防御） | — |
| R04 | A1 | 命令 `--action` 读表单 | 存活（同 R03，等价） | — |
| R05 | A2 | 命令漏 `--batch` | 杀死 | component/whitelist › A2 |
| R06 | A2 | 工具 `--batch` 仍加 i | 杀死 | offline-check › `--batch K` |
| R07 | A2（N18） | 命令两链 nonce 对调 | 补测后杀死 | component/whitelist › A2（两链 nonce 不同） |
| R08 | A2（N19） | 命令漏 `--deadline` | 杀死 | component/whitelist › A2 |
| R09 | A2 | 批号差一（0 起） | 杀死 | component/whitelist › A2 |
| R10 | A3 | 未知选项照收 | 杀死 | offline-check › fail-closed |
| R11 | A3 | 允许 `--x=y` | 补测后杀死 | offline-check › fail-closed（错误文字） |
| R12 | A3 | 多余文件参数被忽略 | 杀死 | offline-check › fail-closed |
| R13 | A3 | 不校验 expect 格式 | 杀死 | offline-check › fail-closed |
| R14 | A3 | chainId 允许 0 | 杀死 | offline-check › fail-closed |
| R15 | A3 | deadline 可缺省 | 杀死 | offline-check › fail-closed |
| R16 | A3 | 允许空值 | 补测后杀死 | offline-check › fail-closed（`--decode ""`） |
| R17 | A3 | 多批无 `--batch` 也比对 | 杀死 | offline-check › `--batch K` |
| R18 | A3 | 允许重复选项 | 杀死 | offline-check › fail-closed |
| R19 | B2（N39） | nonce 变化静默重签（去掉 nonce 与哈希两道检查） | 杀死 | component/whitelist › B2 |
| R20 | B2 | 准备时不先清旧批次 | 杀死 | component/whitelist › A1 / B2 |
| R21 | B2 | 需重新准备时重试仍可点 | 杀死 | component/whitelist › B2 |
| R22 | B2 | 去掉"未准备"检查 | 存活（等价：未准备的批次 nonce 为空，随后 nonce 比对必然不等而停止） | — |
| R23 | B5（N24） | releaseDelay 方向反 | 杀死 | integration/params › bsc |
| R24 | B5（N35） | 去掉 frame-ancestors | 杀死 | unit/misc › CSP |
| R25 | B5（N36） | style-src 加 unsafe-inline | 杀死 | unit/misc › CSP |
| R26 | B5（N38） | 接口受控集合覆盖附录 A | 杀死 | component/pages › appendix A |
| R27 | B5（N33） | Worker 放行 `/api/*` | 杀死 | unit/misc › Worker 404 |
| R28 | B5（N29） | 验签异常当通过 | 杀死 | unit/misc › proof |
| R29 | B3 | 其他目标当桥解码 | 杀死 | component/pages › timelock targets |
| R30 | B6 | 不查证明时效 | 杀死 | unit/misc › proof |
| R31 | B7 | 紧急移除跳表头 | 杀死 | component/pages › emergency strict |
| R32 | B6 | 地址不一致不提示 | 杀死 | component/pages › handover |

## 第 0 轮（首次提交）记录

### 第 0 轮变异测试（32 个，在 scratchpad 的独立副本中逐个注入、跑测试、还原）

| # | 文件 | 变异 | 第 1 轮 | 补测后 |
|---|---|---|---|---|
| M01 | offline-check | 去掉排序 | 杀死 | |
| M02 | offline-check | 去掉 EIP-55 校验 | 杀死 | |
| M03 | offline-check | 去掉零地址拒绝 | 杀死 | |
| M04 | offline-check | listHash 漏掉动态数组偏移字 | 杀死 | |
| M05 | offline-check | allowed 编码取反 | 杀死 | |
| M06 | offline-check | keccak 填充改成 SHA3 的 0x06 | 杀死 | |
| M07 | offline-check | 多批 nonce 不递增 | 杀死 | |
| M08 | offline-check | 两链合约名对调 | 杀死 | |
| M09 | offline-check | listHash 不一致仍退出 0 | 杀死 | |
| M10 | offline-check | 表头判定改为区分大小写（`0X…` 首行被当表头跳过） | **存活** | 加向量 `uppercase-0X-first-line-is-an-error-not-a-header` → 杀死 |
| M11 | 页面 normalize | 去掉排序 | 杀死 | |
| M12 | 页面 normalize | 去掉 EIP-55 校验 | 杀死 | |
| M13 | whitelist | 移除也先 BSC | 杀死 | |
| M14 | whitelist | 失败后继续下一条链 | 杀死 | |
| M15 | whitelist | "已是目标状态"用 some 代替 every | **存活** | 加 `recovery.test` › 部分已在白名单的批次不得跳过 → 杀死 |
| M16 | whitelist | nonce 变了也复用旧签名 | 杀死 | |
| M17 | whitelist | 去掉 deadline 余量检查 | 杀死 | |
| M18 | perm | 白名单钱包门禁恒真 | 杀死 | |
| M19 | perm | 管理钱包门禁放行白名单钱包 | 杀死 | |
| M20 | perm | 交接过期不检查 | 杀死 | |
| M21 | emergency | 紧急移除不先冻结 | 杀死 | |
| M22 | risk | 🔴 默认勾选 | 杀死 | |
| M23 | params | 收紧/放宽方向反了 | 杀死 | |
| M24 | params | 放宽不走时间锁 | 杀死 | |
| M25 | review | 审核消息少一个空格 | 杀死 | |
| M26 | review | 付款链对调 | 杀死 | |
| M27 | handover | 两链白名单钱包不同不提示 | 杀死 | |
| M28 | handover | 证明里的桥地址不单独比对 | **存活** | 等价变异：同一函数随后按 `o.bridge` 重建整条消息逐字比对，桥地址不同必然被拒（测试覆盖该拒绝），保留显式检查只为给出更准确的错误文字 |
| M29 | timelock | `BridgeCheckFailed` 不再判为"不合格" | 杀死 | |
| M30 | timelock | 不识别陈旧 epoch | **存活** | 加 `recovery.test` › 管理钱包恢复完成后旧提议显示"已作废" → 杀死 |
| M31 | chain | 发送前不模拟 | 杀死 | |
| M32 | whitelist | 读区块高度用缓存 | 杀死 | |

最终：**31 杀死 / 1 存活（M28，等价变异）**。

### RED→GREEN 说明

`normalize.test`（页面与工具共享向量）先写、先红（模块不存在）再实现；变异存活者（M10/M15/M30）先补测试（对变异体为红）再确认对原代码为绿。其余模块为"实现与测试同批提交"，以 anvil 集成测试与变异测试证明测试有效。
