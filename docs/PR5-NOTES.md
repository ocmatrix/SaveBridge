# PR-5 用户跨链页 `bridge.wanto.pro`：实现说明、配置、接口约定、偏差与待决

> 依据：`docs/DESIGN.md` v0.9.4 §8.1 / §5.2 / §5.3 / §5.5 / §7，`docs/PR1-NOTES.md` §5。分支 `pr-5-user-page`。
> 范围：只写代码与本地测试。**未部署、未连接任何真实节点、未发送任何真实交易、未接触任何真实私钥。** 测试只用本机 anvil 及其公开默认测试账户。17 条决定未改。

## 1. 位置与技术栈

`apps/bridge-web`（`@bridge/bridge-web`）：Vite 7 + React 19 + TypeScript + viem 2 + wagmi 3（injected/EIP-6963 + WalletConnect v2）+ vitest 4 + Testing Library。依赖 `@bridge/abi`（PR-1 生成的 ABI）。

| 目录 | 内容 |
|---|---|
| `src/config.ts` | 构建期配置解析与校验（地址、https、链 ID 不同、占位标记） |
| `src/lib/guard.ts` | 交易目标白名单：`assertAllowedTarget`（两个桥 + 两个 USDT，且必须是该交易所在链的那一对）、`assertAllowedCall`（USDT 只允许 `approve(本链桥, ·)`；WANTOS 桥只允许 `bridgeOut`；BSC 桥只允许 `deposit`） |
| `src/lib/approve.ts` | 精确授权：`approve(bridge, amount)`，`amount` 必须 > 0 且 < 2^128（合约以 uint128 记账），拒绝 MaxUint256 |
| `src/lib/flows.ts` | `sendGuarded`（唯一发交易的路径：函数白名单 → 钱包链校验 → simulate → 再校验目标 → 发送）、`bridgeOutFlow`、`depositFlow`（预检 → 精确授权 → 发送 → 解析事件） |
| `src/lib/reader.ts` | 页面显示的所有链上读数 |
| `src/lib/statusProvider.ts` | `StatusProvider` 接口 + 默认实现 `ChainStatusProvider` |
| `src/lib/status.ts` | 用户可见状态映射；relayer 响应解析 |
| `src/lib/errors.ts` | 链上 / 钱包错误 → i18n 键 |
| `src/i18n/{zh,en}.ts` | 字典（en 以 zh 的键类型约束，测试再校验键集一致） |
| `src/csp.ts` + `vite.config.ts` | 由同一份构建配置生成 Cloudflare Pages `_headers` |
| `scripts/check-dist.mjs` | 构建后检查（`pnpm build` 自动运行） |

## 2. 配置项（`apps/bridge-web/.env.example`）

`VITE_{WANTOS,BSC}_{CHAIN_ID,CHAIN_NAME,NATIVE_SYMBOL,RPC_URL,EXPLORER_URL,BRIDGE,USDT,FROM_BLOCK}`，可选 `VITE_RELAYER_API`、`VITE_WC_PROJECT_ID`、`VITE_LOG_LOOKBACK_BLOCKS`（默认 50000）。

- 代码里**没有任何合约地址**；地址只来自构建配置，绝不从接口读取。
- `pnpm --filter @bridge/bridge-web build` 用 `.env.placeholder`（`VITE_CONFIG_PLACEHOLDER=1`，假地址）：产物**惰性**，页面只显示"站点配置错误"，不连接钱包。用于 CI / 构建检查。
- 正式构建：把 `.env.example` 复制为 `.env.production.local` 填真实值 → `pnpm --filter @bridge/bridge-web build:prod`（`check-dist --real` 另外检查 connect-src 只含 2～3 个 https 源和 WalletConnect relay，并且不含占位地址）。`.env.*.local` 已加入 gitignore。

## 3. 功能对照 DESIGN §8.1

| 要求 | 实现 |
|---|---|
| 钱包 | wagmi `injected()`，并启用 EIP-6963 多钱包发现（TP / MetaMask / OKX DApp 浏览器、插件）；配置了 `VITE_WC_PROJECT_ID` 时增加 WalletConnect v2，`showQrModal:false`，**自己画二维码**（`qrcode`，`img-src data:`），托管弹窗 `@reown/appkit/core` 在构建时被替换为空实现（不进 bundle，也不访问其远程 API） |
| 缺 WANTOS 网络 | "切换到 WANTOS"（wagmi 遇 4902 时自动用配置里的链参数 `wallet_addEthereumChain`）+ 显式"添加 WANTOS 网络"按钮（chainId `0x34f3`，RPC / 浏览器 URL 来自配置） |
| 开通状态 | 读两条链 `whitelisted(addr)`：都开 → 已开通；都没开 → "跨链未开通，请联系客服"；不一致 → "开通同步中" |
| 今日剩余额度 | W2B：`w2bPerAddrDailyCap − addrDailyUsed(currentDay, user)`（WANTOS）；B2W：`b2wDailyCap − dailyUsed(currentDay)`（WANTOS 全局）。"今天"用合约的 `currentDay()`，不用浏览器时钟 |
| 暂停 / supplyCeiling | `paused()` → 维护中，禁用；`totalSupply > supplyCeiling` → 提示并禁用跨出 |
| W2B | 金额校验（min / 单笔上限 / 当日剩余 / 余额）→ 预检（暂停、白名单、合约钱包含 EIP-7702、发行上限、最小值、地址额度、余额）→ 授权不足时**精确授权** → `bridgeOut` → 解析 `BridgeOut` 得订单号 |
| B2W | `deposit(amount, wantosRecipient)`；收款地址默认当前地址，必须是有效地址（混合大小写须通过 EIP-55 校验）且非零；提示"请勿填写交易所充值地址"；发送前显示"将存入 X USDT，到账 WANTOS 地址：…"；`minDeposit`/`maxDepositPerTx` 校验；进度"BSC 已存入，等待 WANTOS 到账（约 15 分钟）" |
| 订单状态 | 见 §4；风控相关状态一律显示"处理中" |
| 安全 | 目标与函数白名单（发送前断言）；精确授权；页脚固定显示两条链的桥地址（来自配置，带浏览器链接）；严格 CSP；无 eval、无内联脚本 |
| 不含管理功能 | 无白名单、暂停、时间锁、参数、退款发起等任何管理操作；不显示受控集合 / 风险标记 |

用户可见订单状态只有 5 个：处理中 / 已到账 / 退款中 / 已退款 / BSC 已存入等待 WANTOS 到账。

| 方向 | 链上依据 | 显示 |
|---|---|---|
| W2B | WANTOS `orders(id).status`：2 → 退款中，3 → 已退款；1 时看 BSC `payouts(eventKeyOf(id)).status`：2 → 已到账，其余（0/1/3、读失败）→ 处理中 | Queued（大额排队）、Voided（拒绝待退款）都不单独披露 |
| B2W | BSC `deposits(nonce).refundStatus`：1 → 退款中，2 → 已退款；否则 WANTOS `payouts(eventKeyOf(nonce)).status`：2 → 已到账，3 → 处理中，0/1/读失败 → 等待到账 | — |

## 4. StatusProvider 与 relayer API 约定（向 PR-3 提的需求）

`StatusProvider.list(user, knownIds)` 是可替换接口（组件测试用 mock）。默认 `ChainStatusProvider`：

1. 订单号来源：①用户自己的事件（`BridgeOut(user)` / `Deposited(from)`，从 `FROM_BLOCK` 和"最新块 − LOOKBACK"两者较晚处开始，每段 5000 块）；②本浏览器记住的订单号（localStorage，每地址最多 50 个，仅为方便）；③可选 relayer API（最多取 50 个）。
2. **每个订单号都回链上重读**，并核对属于该用户；状态只由链上决定。API 只提供订单号和目标链交易哈希（仅在链上已到账时显示链接）。API 失败、超时（8 秒）、格式不符时静默忽略，退回只读链。

**向 PR-3 提的需求（未自行发明，前端按此形状解析，PR-3 可改，改了同步改 `parseRelayerOrders`）：**

```
GET /v1/orders?address=0x…   （只读、无鉴权、CORS 允许 bridge.wanto.pro）
200 { "orders": [ { "direction": "W2B" | "B2W",
                    "srcEventNonce": "<十进制字符串：W2B 为 orderId，B2W 为存款 nonce>",
                    "status": "<§6.3 状态名>",
                    "dstTxHash": "0x…64 位" | null } ] }
```
- R1：**对外接口不要返回 REVIEW / 冻结级别 / 命中规则 / 风险标记**，最好在服务端就把内部状态折叠为 `PROCESSING / RELEASED / REFUNDING / REFUNDED`（前端已经把未知状态都当"处理中"，这是第二道保险）。
- R2：按 `address` 同时匹配 W2B 的 `user` 和 B2W 的 `from`（存款人），返回最近 N 笔（建议 50）。
- R3（可选）：B2W 已检测但还没 `queueRelease` 的金额合计，用于更准确地显示"WANTOS 今日剩余入账额度"。
- R4：限流与缓存由 PR-3 / Cloudflare 决定；前端每 20 秒轮询一次（只在页面打开时）。

## 5. 错误翻译

`ERROR_KEYS` 覆盖两个桥 ABI 的**全部 58 个自定义错误（去重后）**（含 OZ 框架错误）以及 OZ ERC-20 的 6 个错误；字符串回滚（`ERC20:`/`BEP20:` 余额或授权不足）、gas 不足、用户拒绝、钱包链不对、网络故障、本站目标拦截各有专门提示；其余一律"交易失败，请稍后再试或联系客服"，不显示原始文本。普通用户触发不到的管理类错误合并成 4 个通用提示（无权限 / 管理流程中 / 订单状态已变 / 合约拒绝）。测试 `errors.test.ts` 对 PR1-NOTES §5.11 列出的 44 个错误名和 ABI 中的全部错误名逐个断言有翻译。时间锁 `BridgeTimelock` 的错误不在用户页范围内（用户不会调用时间锁），未翻译。

## 6. 测试（`pnpm --filter @bridge/bridge-web test`）

- unit（node）：配置、目标与函数白名单、精确授权、金额与额度、收款地址、错误翻译（全部错误）、i18n 键集与占位符一致、CSP / `_headers`、状态映射（风控状态不外露）、relayer 响应解析、添加网络、localStorage 订单号、构建检查函数。
- integration（node + 两条 anvil）：PR-1 合约从 `out/*.json` 字节码部署（时间锁 → 实现 → 代理，与 §5.1 nonce 顺序一致），白名单用 EIP-712 批次签名写入。
- component（jsdom + 真实 wagmi，mock 连接器指向 anvil）：从 UI 操作。
- 每个测试前后都对 anvil 做快照 / 回滚。`globalSetup` 在 `out/` 缺失时执行 `forge build`。

## 7. 偏差（均为保守选择，未改 17 条决定）

1. **跨出要求两条链都已开通**：规格只要求"WANTOS 侧未开通时禁用"；BSC 未开通时放款会卡在 WAITING（白名单原因），所以"开通同步中"时也禁用跨出，避免资金卡住。
2. **任一侧暂停时禁用存入**：BSC 暂停，存入会回滚；WANTOS 暂停，入账无法处理。两种情况都禁用，并在存入前预检中重新读取。
3. **存入金额超过 WANTOS 今日剩余入账额度时禁用**（§5.3"B2W 超过当日额度直接走入账退款"）。这个值不含已存入但还没排队的金额，所以只是近似值，界面写明"以到账时为准"。见 R3。
4. **未开通地址允许存入**（合约与 §5.3 都不查 B2W 白名单），但提示"跨回 BSC 需先开通"。
5. **已有授权 ≥ 金额时不再授权**：沿用剩余的精确授权，不会产生无限授权。
6. **WalletConnect 不用托管弹窗**：自己画二维码，CSP 不必放开 WalletConnect 的 API、图片和字体域名。WalletConnect Verify 的 iframe 被 `frame-src 'none'` 拦截，钱包端会显示"无法验证域名"，不影响连接（未用真实 WalletConnect 会话验证，见 §9）。
7. **relayer API 源加入 connect-src**（仅在配置时）：§8.1 只列了 RPC 和 WalletConnect，但订单 API 是规格要求的只读接口。
8. 若两条链 USDT 的 `decimals` 不同，`readBridgeState` 直接报错，页面停用（金额按最小单位 1:1 跨链）。

## 8. 对共享文件的改动（叠在 ts-workspace 上，需总控合并时注意）

- 根 `package.json`：删除 `"packageManager": "pnpm@10"`。它不是合法 semver，本机 pnpm 12.3.4 因此拒绝运行任何命令。其他车道会遇到同样问题。
- `pnpm-workspace.yaml`：`allowBuilds`，只允许 esbuild 的安装脚本（Vite 需要），`@reown/appkit` 的脚本禁止运行。
- `scripts/gen-abi.sh` 与 `packages/abi/src/*.ts`：生成结果原为 `]\n as const`，esbuild / Vite 无法解析。已改成 `] as const` 并重新生成，ABI 内容不变。
- 新增 `pnpm-lock.yaml`，锁定依赖版本（§8.4）。

## 9. 待决与已知风险

- `VITE_WANTOS_NATIVE_SYMBOL`（`wallet_addEthereumChain` 里的原生币符号）需要链方确认，示例里写的 `WANT` 只是占位。
- WANTOS-USDT 如果像以太坊 USDT 那样要求"非零授权必须先清零"，在已有部分授权时直接改授权会失败（会显示错误，资金无风险）。需要确认该代币的 `approve` 行为（PR-0 / 0xc74F 审计）。
- 不配置 relayer API 时，只能看到回看窗口内的订单（默认 5 万块，BSC 约 42 小时）和本浏览器记住的订单。换设备后更早的在途订单看不到。上线前应配置 API（R2），或调大 `VITE_LOG_LOOKBACK_BLOCKS`。
- 没做 Playwright 浏览器 E2E（任务说明里是"如要做"）。用构建产物加真实 `_headers` CSP 在浏览器里手动打开过一次：页面正常渲染，没有任何 CSP 违规（只有 RPC 未启动导致的连接失败）。没有用真实 WalletConnect 会话或真实注入钱包测过。
- 测试里 anvil 用了真实链 ID 13555 / 56，但只监听 127.0.0.1。
- bundle 约 1.1 MB（gzip 约 340 KB），主要是 WalletConnect SignClient 和 wagmi。可在需要 WalletConnect 时再动态加载，作为后续优化。
- 页脚只显示配置里的地址。用户核对这些地址需要官方在独立渠道公布（§8.4）。
