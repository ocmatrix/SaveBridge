# 管理前端 admin.wanto.pro 上线开发文档（试运营，2026-11-02）

> 依据：`docs/DESIGN.md` v0.9.5 §8、`docs/PR6-NOTES.md`（管理页已实现并测过，**未部署**）、`docs/DEPLOY-RECORD-20261102.md`（合约与服务已上线）。
> 目标：今天把**已有的** `apps/admin-web` 以最小改动部署到 `admin.wanto.pro`，让负责人在 **TP 钱包 DApp 浏览器**里用白名单钱包完成白名单导入，并支撑后续冒烟测试。
> 范围：只部署管理页（`/`、`/emergency`、`/timelock`、`/params`、`/handover`、`/reserves`）。用户跨链页 `bridge.wanto.pro` 由另一会话负责，本文不涉及。

---

## 1. 现状（已核实）

| 项 | 现状 |
|---|---|
| 管理页代码 | `apps/admin-web`，PR-6 已实现并通过测试；注入式钱包（TP / MetaMask / OKX 的 DApp 浏览器），**没有 WalletConnect、没有硬件钱包专用路径** |
| 合约 | 两条链桥合约 `0xe2fD0F2Ee8041Ff1bDA023e6Fca65ba889114AD5`（代理）；白名单钱包 `0x8F36C2b951ff9Cc752844d50460e1e3D51EaF4A9`（**在 TP 钱包里**，负责人 2026-11-02 确认）；管理钱包 `0x860f5B29f60F86c82b18f789E0219Cf966375669` |
| 白名单合约对钱包类型 | **无限制**：`applyWhitelistBatch` 只验证 EIP-712 签名恢复出的地址 == 白名单钱包；任何钱包都可提交交易（`BridgeBase.sol`） |
| 白名单状态 | 两条链 nonce 均为 0、白名单为空；待导入：T0 `0x63Fcb75b54e0fdDCFC3b422A543A191B55225554`、T1 `0x222A4223a4046671e68346ABEde37E583050258c` |
| 生产构建 | 已在本机用生产配置构建成功（`dist/`），产物里是新桥地址与两条主网，无占位值（见 §3 校验） |
| 站点形态（已在 Cloudflare 核实） | Qbit 账户（ID `1cdc00a2…99c9`）里的 Worker **`savebridge-admin`**，自定义域 `admin.wanto.pro`，12 小时前部署的占位页；另一个 `savebridge-bridge`（`bridge.wanto.pro`）**不碰**。`wanto.pro` 的域名在这个账户里 |
| 占位页现状（公网实测） | `GET /` 200；**`GET /handover` 404**（占位页没有单页应用回退）；`savebridge-admin.qubitark.workers.dev` 返回 `error code: 1042`（workers.dev 已关闭，符合设计） |
| 部署历史（回退目标） | `wrangler versions list`：两个版本，当前生效 `17b39b4c-f2ef-49ce-b535-fb4050468cc2`（02:50 UTC），上一个 `9575cf75-ac24-44f7-a8eb-c332d6d64872`（02:42 UTC）。回退用 `wrangler rollback` |
| 仓库内配置 | `apps/admin-web/wrangler.toml` 原是 **Pages 风格**（与 DESIGN 不一致），**已改为 Workers Static Assets**：`name=savebridge-admin`、`workers_dev=false`、`preview_urls=false`、`assets.directory=./dist`、**`not_found_handling="single-page-application"`**，不写 `routes`（自定义域已在控制台绑定，部署不动它）。`wrangler deploy --dry-run` 已通过 |
| wrangler | 本机已用 Qbit 账户 OAuth 登录（`qubitark@gmail.com`）；浏览器里的 Cloudflare 控制台也已登录（只读核对用） |
| 管理接口（`/api`） | 付款程序的管理 API 与 Worker 转发**今天不上**：`VITE_ADMIN_API` 留空。审核、对账、网体信息等依赖接口的页面功能今天不可用（页面会提示"未配置管理接口"），**白名单写入、紧急、时间锁、参数、交接、储备（链上只读）不依赖接口** |

## 1A. 范围变更（负责人 2026-11-02 确认；设计稿 Figma `D40saAPtWJax4gIthbTzOI` 已通过；N1–N3 已开发，**本机测试通过，未发布**）

**开发结果（本机）**：admin-web 全部测试 103 项通过（新增读 Excel、页面上传、竞态、换行、空行、模式警示等 18 项，竞态与大小上限两条已用变异证明会变红）；`tsc --noEmit` 通过；生产构建 793KB，新桥地址 1 处、旧地址与占位值 0 处；在带生产 CSP 的真实 Chromium 里读取 .xlsx 成功、无 CSP 报错。样式是 Figma 通过稿的"浅灰 + 深灰、无彩色、只浅色"，提示图标由彩色 emoji 改为 △（不在网体内）和 ○（合约地址）。**与设计稿的差异：电脑版是单栏**（设计稿画的是"地址 | 预览"两栏），因为预览表有 7 列参考信息，放进半栏会被挤坏。

页面名称：**跨链桥白名单管理**。在现有 `apps/admin-web` 白名单页上新增以下三项，其余签名、核对哈希、两链提交逻辑不改：

| # | 新增 | 规则 | 说明 |
|---|---|---|---|
| N1 | **批量导入：.xlsx 直读，同时接受 CSV、TXT、粘贴** | Excel 表只有地址：读第一个工作表的第一列，第一行若不是地址视为表头跳过一次；最多 5000 行；**.xlsx 文件不超过 500KB**（解压库对 <512KB 的压缩包走同步解压，更大的会启动 Web Worker，被页面 CSP 拦住；我们不放宽 CSP，所以限大小），CSV/TXT 不超过 2MB 且同样最多 5000 行；按文件头 `PK` 识别 .xlsx（手机选择器可能不带扩展名）；单元格含换行、或第一列为空而其他列有数据，整个文件拒绝（不静默丢行）；文件只在本机浏览器内读取，不上传；解析后的地址交给**同一套 rules v1**（去重、升序、EIP-55 校验、有错误整批阻断） | 现有代码只支持 CSV、TXT、粘贴，.xlsx 需新增一个小型解析依赖（已过 24 小时发布冷却期，版本精确锁定为 read-excel-file 9.3.14 与 write-excel-file 4.1.1（后者仅测试用，不进生产包），打进包内，不影响 CSP） |
| N2 | **添加 / 移除用页面上的按钮切换** | 整批只有一个方向（合约一批只能一个 `allowed`）；Excel 里**没有操作列**；切换按钮是两个醒目的分段按钮，移除模式用危险色并提示"这些地址将立即无法跨链"；顺序：添加先 BSC 后 WANTOS，移除先 WANTOS 后 BSC（已有逻辑） | 现有页面已有添加/移除两种模式，本项是把它做成顶部分段按钮并加提示 |
| N3 | **同时支持手机 TP DApp 浏览器和电脑 Chrome（TP 插件）** | 同一套页面做响应式：手机单列，电脑两栏；注入式钱包不变，不加连接逻辑 | 仅样式与布局 |

不变的约束：每批最多 500 个地址，超过自动分批，每批每条链各签名一次加发交易一次；任何写入都必须经"核对哈希"页；错误行不会部分导入。

## 2. 刻意不做的（简洁原则）

| 不做 | 少了什么 | 怎么缓解 | 何时再做 |
|---|---|---|---|
| 管理接口 Worker（`wanto-admin-api`）+ 付款程序 `/admin/*` 对外 | 订单审核页、对账与告警页、网体/上级等参考信息 | 今天无大额订单需要人工审核；对账看监控告警与 Healthchecks；订单事实可读链上 | 公开前或首个 REVIEW 订单出现时（先建 tunnel，见 TRAIN 外项） |
| WalletConnect / 硬件钱包专用路径 | 电脑上无注入钱包时不能连 | 今天用 TP 的 DApp 浏览器；电脑可用浏览器插件 | 明天换 KMS 前后视需要 |
| Cloudflare Access 作为安全边界 | — | DESIGN §8.4：Access 只是"防窥视"，**安全边界是链上权限 + 钱包签名**；页面没有任何服务端写权限 | 若想先关门，今晚由负责人在 Zero Trust 配（见 §5，可选且不阻塞） |
| 改签名、核对、两链写入逻辑 | — | 这些沿用已测试的实现，本次只改文件读取、模式提示和样式 | — |
| 今天换硬件钱包 / 换白名单钱包 | — | 白名单钱包仍是 `0x8F36…F4A9`（在 TP），见 §6 风险 | 明天 KMS 后随主流程评估 |

## 3. 配置（构建期，全是公开值，不含密钥）

```
VITE_BSC_CHAIN_ID=56
VITE_BSC_RPC_URL=https://bsc-rpc.publicnode.com
VITE_BSC_BRIDGE=0xe2fD0F2Ee8041Ff1bDA023e6Fca65ba889114AD5
VITE_BSC_FROM_BLOCK=131219867
VITE_WANTOS_CHAIN_ID=13555
VITE_WANTOS_RPC_URL=https://rpc.wantos.io
VITE_WANTOS_BRIDGE=0xe2fD0F2Ee8041Ff1bDA023e6Fca65ba889114AD5
VITE_WANTOS_FROM_BLOCK=3458826
VITE_ADMIN_API=            # 今天留空
VITE_SIWE_DOMAIN=admin.wanto.pro
```

- **只用无 Key 的公共 RPC**（publicnode、`rpc.wantos.io`）：这些值会进前端包，任何带 API Key 的地址（NodeReal、Ankr）**不得**放进来。
- 构建命令：`pnpm -C apps/admin-web build:prod`（Vite `--mode production`）；`_headers` 由构建生成（严格 CSP、HSTS、禁止嵌入、no-referrer、no-store；CSP 里的连接白名单来自上面的两个 RPC 域名）。
- 构建后核对（验收项 V1）：产物中出现新桥地址 `0xe2fD0F2E…4AD5`；**不出现**旧桥地址 `0x8dFd39…`、`0xeC6E35…`、旧 relayer `0x9dAb17…`；不出现 `<bsc rpc>`、`https://<` 之类占位串；`dist/_headers` 存在。**2026-11-02 本机已执行，全部通过**（新桥地址 1 处，旧地址与占位串 0 处）。
- 已核实的前置条件：
  - 两个 RPC 对来自 `https://admin.wanto.pro` 的预检请求都允许（`access-control-allow-origin: *`，允许 POST 与 `content-type`），浏览器跨域读链不会被挡。
  - CSP 为 `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https://rpc.wantos.io https://bsc-rpc.publicnode.com …; frame-ancestors 'none'`，没有内联脚本，页面连接白名单与上面的 RPC 一致。
  - 页面换链用 wagmi 的 `switchChain`，链定义带原生币符号（BNB / WANT）和 RPC 地址，钱包里没有 WANTOS（13555）时会触发"添加网络"；TP 里若弹出添加网络请确认 RPC 为 `https://rpc.wantos.io`。

## 4. 开发/部署步骤（按顺序）

| # | 步骤 | 谁 | 产出/验证 | 回退 |
|---|---|---|---|---|
| 1 | ✅ 已完成：核对占位 Worker（`savebridge-admin`、自定义域 `admin.wanto.pro`、workers.dev 关闭、`wanto.pro` 在 Qbit 账户、两个历史版本） | 我 | 见 §1 | — |
| 2 | ✅ 已完成：`wrangler.toml` 改为 Workers Static Assets（含单页应用回退） | 我 | `wrangler deploy --dry-run` 通过 | git 还原 |
| 3 | 发布前**重新**按 §3 配置做生产构建，执行 V1 核对，计算 `dist` 各文件 sha256 并与 §8 对比；任何文件哈希变化都要写明原因 | 我 | V1 全过；哈希入档 | — |
| 4 | **发布**：`wrangler deploy`（只发这个 Worker，**需负责人明确说"发布"**） | 我（负责人授权） | 命令输出版本 ID | `wrangler rollback` 回到占位页版本 |
| 5 | 公网验证（V2）：<br>• `https://admin.wanto.pro/` 返回 200，响应头含 CSP/HSTS/no-store 等（与 `dist/_headers` 一致）<br>• **`https://admin.wanto.pro/handover`、`/emergency`、`/timelock`、`/params`、`/reserves` 直接打开均返回 200 并渲染对应页面**（单页应用回退生效；占位页的 `/handover` 现在是 404）<br>• 页面能读到两条链：显示的桥地址、白名单钱包（`0x8F36…F4A9`）、管理钱包（`0x860f…5669`）与链上一致<br>• `workers.dev` 地址仍是 1042<br>• 页面加载时的网络请求只去 `admin.wanto.pro` 和两个 RPC 域名 | 我（用内置浏览器 + curl） | 记录结果 | 同步骤 4 |
| 6 | **白名单导入（负责人操作）**：在 TP DApp 浏览器打开 `https://admin.wanto.pro/` → 连接白名单钱包 `0x8F36…F4A9` → 白名单页粘贴 T0、T1 → 准备本批 → 核对页面显示的 `listHash/domainHash/messageHash`（可选：用 `packages/offline-check` 在另一台设备核对）→ 先签并提交 BSC，再签并提交 WANTOS | 负责人 | 两条链 nonce 变 1 | 提交错了：`emergencyRemove`（管理钱包）立即移除 |
| 7 | 链上核对（V3）：两链 `whitelisted(T0)`、`whitelisted(T1)` 均为 true，`whitelistNonce` 均为 1；监控收到 `WhitelistBatchApplied` 事件（一级告警按设计会提示"白名单变更"，属预期） | 我（只读） | 记录 | — |
| 8 | 冒烟测试（另文，见 §7） | 负责人 + 我 | — | — |

**今晚可选（不阻塞）：** 负责人在 Cloudflare Zero Trust 给 `admin.wanto.pro/*` 配 Access（只放行负责人邮箱，`/handover` 放开）。配了更安心，不配也不改变安全边界。

## 5. 验收

| 编号 | 验收点 | 方法 |
|---|---|---|
| V1 | 生产包配置正确、无旧地址与占位值 | 构建后对 `dist` 做字符串检查（§3） |
| V2 | 公网页面可用，头部安全，链上数据与合约一致 | 步骤 5 |
| V3 | 白名单导入后链上状态正确 | 步骤 7，读 `whitelisted`、`whitelistNonce` |
| V4 | 非白名单钱包无法写入（负面用例） | 用管理钱包或任意非白名单钱包打开页面，白名单页写入按钮应不可用并显示原因（PR-6 已有该行为，上线后抽查一次） |

## 6. 风险与取舍

1. **白名单钱包在手机 TP（软件钱包）上**：设计原意是硬件钱包。白名单权限 = 决定谁能进桥。软件钱包助记词泄露即可被任意加白名单。缓解（已有机制，不新增）：管理钱包可 `emergencyRemove` / `freezeWhitelist` 立即收紧；监控对白名单变更发告警；明天 KMS 切换后再评估是否把白名单角色换到更稳妥的钱包（走 48 小时两步交接）。助记词只存离线，不截图不上云。
2. **TP 对 `eth_signTypedData_v4` 的支持未在本环境验证**：第一次签名可能表现为不弹窗或报错。预案：同一钱包在 MetaMask/OKX 的 DApp 浏览器打开同一页面，或在电脑浏览器插件里导入同一钱包；仍不行再回到终端离线签名（命令已备，见会话记录，待型号确认）。
3. **严格 CSP 与 TP 的 DApp 浏览器**：`script-src 'self'` 不允许内联脚本。钱包注入 `window.ethereum` 一般不受页面 CSP 约束（由 App 原生注入），但我无法在本环境验证 TP。如果页面在 TP 里打开后"找不到钱包"，先在同一页面用 MetaMask/OKX 对比，确认是 TP 注入问题再决定是否放宽 CSP；**不要先放宽**。
4. **单页应用回退吃掉 404**：`not_found_handling="single-page-application"` 会让任何不存在的路径都返回首页（200）。页面本身只读链上数据并不依赖服务端路径，影响仅是 URL 看起来都"存在"；`/api/*` 今天不存在，也会返回首页，这是预期的。
5. **页面是开源构建、公网可访问**：伪造页面诱导签名的风险靠"签名前核对 `listHash` 与钱包屏幕、可选离线工具"来拦（DESIGN §8.3），今天导入的只有 T0、T1，影响有限。
6. **导入白名单的 T0/T1 是测试钱包**：它们在主网桥里是真实白名单地址，冒烟测试的资金与额度按真实资金对待。

## 7. 冒烟测试（另一份，今天做；此处只列与本页相关的前提）

- 前提：T0、T1 白名单已生效（V3）；BSC 金库有 USDT（目前 0，需负责人先充值）；T0/T1 在 BSC 上有 USDT 和 BNB gas（T0 现有约 0.002 BNB，不够多次交易）。
- 转账、测试交易每一笔都需要负责人明确授权（地址 + 资产 + 数额）。

## 8. 发布记录

| 项 | 值 |
|---|---|
| 发布时间 | 2026-11-02 16:10 UTC 前后（负责人当场明确授权「部署到 workers」） |
| 仓库基线 | `b12744d` + 未提交的工作区改动（本文、admin-web、packages/ops、deploy，尚未提交） |
| Worker | `savebridge-admin`（Qbit 账户），自定义域 `admin.wanto.pro`，`workers_dev=false` |
| **当前版本 ID** | `95749449-de13-4bfb-b0da-77775a697f8a`（含 500KB 上限的说明文字）。此前版本：`e6740f7a-dfdf-4c1f-9d5b-fb19d990e792`（说明文字仍写 2MB），占位页 `17b39b4c-f2ef-49ce-b535-fb4050468cc2` |
| 回退 | `npx wrangler rollback`（回到上一个版本），或 `npx wrangler rollback 17b39b4c-f2ef-49ce-b535-fb4050468cc2`（占位页） |
| `_headers` | `5e50661357fa7a55c0db4a798d30c40d5521af20e67e43e8eb590100ce7d89ef` |
| `index.html` | `588c73740b93e7d1e7ca1fe2ace1a25812a64c83626c55189129220f947743c5` |
| `assets/index-CY4UEJu7.js` | `f572641f976f585ed000ea8abe73f26fa76ca18d59315e02b8ad2895fbcfaf5f` |
| `assets/ccip-BPRmgoPW.js` | `0c5a5057ed7e26d3645cec28853d05da315fe323a2a9c098c95d1b14f2a4c482` |
| `assets/index-Bc3Ed6dp.css` | `67ed8872a2398198c37675abea60fbd382e174f6961d08a95da7f31b14fa9879` |

**发布后公网验证（2026-11-02）**：`/`、`/handover`、`/emergency`、`/timelock`、`/params`、`/reserves`、`/review` 均 200 并返回「跨链桥白名单管理」页；响应头含 CSP、HSTS、no-store、X-Frame-Options DENY、Referrer-Policy no-referrer；线上三个资源文件的 sha256 与本地构建一致；`savebridge-admin.qubitark.workers.dev` 返回 404（workers.dev 关闭）；浏览器打开页面没有链上读取错误。**已知无害噪声**：控制台有一条 Cloudflare 自动注入的 Web Analytics 脚本 `beacon.min.js` 被 CSP 拦截（我们不放行第三方脚本）；如不想看到，可在 Cloudflare 的 `wanto.pro` Web Analytics 设置里关掉自动注入。

**尚未验证（需要负责人在 TP 里做）**：TP DApp 浏览器能否注入钱包、`eth_signTypedData_v4` 能否弹出签名。
