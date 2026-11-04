# SaveBridge 节点服务商与账号清单

整理日期：2026-11-04。信息来源：rpc3、ss02 上的服务配置（只取了域名，没读密钥）、Cloudflare Pages 项目设置（只看 secret 名字）、仓库代码与部署记录。

**本文不含任何密钥、口令、完整接口地址。** 带密钥的地址只放在下表「密钥存放位置」列出的地方。换节点或查 429 前先读这份。

## 1. BSC 节点（5 家）

| 服务商 | 域名 | 谁在用 | 密钥存放位置 | 限制与已知问题 |
|---|---|---|---|---|
| publicnode | `bsc-rpc.publicnode.com` | 监控（rpc3）；管理页 `admin.wanto.pro` 提交服务的主地址；用户页 `savebridge.wanto.pro` | 无密钥（公共节点）。管理页地址在 `apps/admin-web/wrangler.toml` 的 `BSC_RPC_URL` | 免费公共节点。Cloudflare 共享出口 IP 会被限流（2026-11-03 管理页批量加白名单 BSC 报 429）；多后端链头偶尔不一致，监控偶发 `RPC_UNREACHABLE` |
| 48.club | `rpc-bsc.48.club` | 监控（rpc3） | 无密钥 | 不支持历史块 `eth_call` → 监控对账报 `RECONCILE_FAILED`（已知） |
| NodeReal | `bsc-mainnet.nodereal.io` | 付款程序（ss02） | ss02 `/etc/savebridge/rpc.env`（专用 Key） | — |
| Ankr | `rpc.ankr.com` | 付款程序（ss02） | ss02 `/etc/savebridge/rpc.env`（免费档 Key） | 免费档，有额度限制 |
| Alchemy | `bnb-mainnet.g.alchemy.com`（带密钥的完整地址） | 管理页的白名单提交服务，只用于提交白名单，与付款程序无关 | Cloudflare Pages 项目 `safebridge-admin` 的 secret `BSC_RPC_KEYED` | 排在 publicnode 和备用节点之前。值必须是完整的 https 地址；不是 https 开头的值会被代码直接忽略，此时实际走 publicnode |

### 独立性硬约束

- 监控用 publicnode + 48.club，付款用 NodeReal + Ankr，两边不重叠。
- 付款端的 `PEER_BSC_RPC_HOSTS` 填的是监控那两家。
- gas 补给程序（gasfeeder，ss02）的节点通过 `rpcEnv` 读取与付款程序相同的环境文件，不自带地址。

### 测过不能用（2026-11-03）

| 节点 | 原因 |
|---|---|
| `bsc.drpc.org` | 免费版不支持批量请求，单请求也限流 |
| bnbchain dataseed（`bsc-dataseed.bnbchain.org`） | 不支持 `getLogs`，不能给监控用 |
| `1rpc.io` | 限 25 块且会限流 |

同日测试：publicnode、48.club、`bsc-dataseed1.bnbchain.org` 对 16 个批量 `eth_call` 都返回 200。

## 2. WANTOS 节点（链 ID 13555）

| 域名 | 谁在用 | 备注 |
|---|---|---|
| `rpc3.wantos.io` | 管理页和用户页的 WANTOS 读写；付款程序（relayer-wantos）；监控的主节点（rpc3 本机 `127.0.0.1:8545`） | 自有节点。限制：`block-range-cap = 100`，nginx 对并发单请求限流（429），`batch-request-limit = 50`，JSON-RPC 批量可通过；跨链桥不被限流是待办 |
| `rpc.wantos.io` | 监控对账时的对照节点 | 自有节点（rpc1），禁止触碰 |
| `rpc2.wantos.io` | 监控对账时的对照节点 | 自有节点（rpc2），禁止触碰 |

## 3. 其他会注册账号的服务

| 服务 | 用途 | 账号/位置 |
|---|---|---|
| Cloudflare Pages | 管理页 `admin.wanto.pro`（项目 `safebridge-admin`）、用户页 `savebridge.wanto.pro`（项目 `safebridge`） | Qbit 账户；secret：`SUBMITTER_KEY`、`BSC_RPC_KEYED` |
| Telegram 机器人 | 监控和付款程序的告警通知 | 令牌和聊天号在 rpc3、ss02 的 systemd 加密凭据里 |
| Healthchecks（外部心跳） | 监控和付款程序的存活检查 | 心跳地址在 rpc3、ss02 的加密凭据 `heartbeat-url` |
| 服务器 | rpc3（监控）、ss02（付款、gasfeeder） | 登录方式见各自运维记录，不在本文 |

## 4. 谁注册了哪个账号

记录里没有逐家登记。**以下待负责人确认后填写：**

| 服务商 | 注册人 | 注册邮箱/登录方式 |
|---|---|---|
| NodeReal | 待填 | 待填 |
| Ankr | 待填 | 待填 |
| Alchemy | 待填 | 待填 |

## 5. 待办

1. 监控补第三家 BSC 节点，修对账（48.club 不支持历史块）。
2. 管理页和用户页的 BSC 节点换成自有或付费节点（用户页正式上线前必须换）。
3. 确认 `BSC_RPC_KEYED` 存的是完整 https 地址，而不是单独的密钥。
4. 填第 4 节的注册人。
