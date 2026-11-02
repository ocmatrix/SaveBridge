# SaveBridge 灰度上线部署（ss02 付款程序 + rpc3 监控）

> 本目录只有脚本与说明，**本仓库内不执行任何部署**。所有脚本默认 **dry-run**（只打印将做什么），加 `--apply` 才改动；每一步幂等、可单独重跑、可在任一步停下。覆盖已有文件需要 `--apply --allow-overwrite`，且先显示 diff 并备份为 `*.savebridge-bak-<时间>`。
> 依据：DESIGN v0.9.5 §4 / §6 / §9；PR3-NOTES、PR7-NOTES、PR10-MAINNET-RUNBOOK；`docs/DEPLOY-PREP-NOTES.md`（实现说明、偏差、待确认）；`docs/SIGNER-MIGRATION.md`（明天换 AWS KMS）。

## 0. 总览

| 主机 | 角色 | 运行内容 | 同机已有服务（不得影响） |
|---|---|---|---|
| **ss02**（Linode 172.232.246.175，Debian 13，1 核 2 GB） | 服务器 A | `savebridge-relayer`（付款程序 + 提交服务）、PostgreSQL（仅本机）、`savebridge-cloudflared`（API 回源） | 对公网的 nginx、coturn（SynStar 流量节点） |
| **rpc3**（腾讯云香港 43.128.14.237，Ubuntu） | 服务器 B | `savebridge-watcher`（独立监控 + 暂停钥匙） | 41 GB 全归档节点、Blockscout 及其数据库、写入代理（shim）、nginx |

钥匙（全部在目标服务器本机生成，本地加密 keystore，明天起付款钥匙换 AWS KMS）：

| 钥匙 | 位置 | 权限 | gas |
|---|---|---|---|
| `relayer-wantos` / `relayer-bsc` | ss02 `/var/lib/savebridge/keystore/` | RELAYER_ROLE（各一条链） | 两链各自 |
| `submitter` | ss02 同上 | **无任何合约权限**，只发交易（白名单批次提交、到期时间锁执行） | 只放 3 天用量 |
| `pauser-wantos` / `pauser-bsc` | rpc3 `/var/lib/savebridge-watcher/keystore/` | PAUSER_ROLE，代码层只能发 `pause()` | 两链各自 |

**敞口**：每日额度按用户决定设为合约允许的较高值，真正的上限是**金库注资量**（BSC 储备 + WANTOS 启动资金）。注资量由负责人决定（授权节点 G7 / G8）。

## 1. 需要负责人在场授权的节点（逐项、不外推）

| # | 动作 | 谁执行 | 何时 |
|---|---|---|---|
| A1 | 登录 ss02 / rpc3 并以 `--apply` 运行任何步骤 | 总控（经用户授权） | 第 3 / 4 节每个 `--apply` 前 |
| A2 | 在服务器上生成钥匙（`keys`），负责人亲自输入口令并离线保存 | 负责人在场 | §3.5 / §4.4 |
| A3 | 主网合约部署（地址需要上面生成的付款 / 暂停钥匙地址） | 负责人 | PR10-RUNBOOK §3【G1–G3】 |
| A4 | 首批白名单（灰度名单） | 负责人用白名单钱包签名 | RUNBOOK §8【G6】 |
| A5 | 注资（BSC 储备、WANTOS 启动资金；金额 = 敞口上限） | 负责人 | RUNBOOK §9【G7/G8】 |
| A6 | 启动服务（`start --apply`）：先监控、再付款程序、最后 tunnel | 总控（经用户授权） | §3.11 / §4.8 |
| A7 | 解除暂停（`unpause`） | 负责人（管理钱包） | 任何自动 / 手动暂停之后，按 RUNBOOK §12.3 |
| — | 暂停、冻结白名单、吊销钥匙 | 负责人随时可做（防守动作） | 任意时刻 |

## 2. 部署前检查表（两台机器都做；`preflight` 只读并保存基线）

- [ ] **账号**：不存在 `savebridge` / `savebridge-tunnel`（ss02）、`savebridge-watcher`（rpc3）；脚本发现同名但带登录 shell 的用户会直接停止。不复用任何既有账号。
- [ ] **端口**：ss02 本机 5432、8080 空闲；部署后**不得出现任何新的非回环监听**（`verify` 自动对比 `ss -ltnup` 基线，新增监听只能在 127.0.0.1 / ::1）。
- [ ] **磁盘**：ss02 `/` ≥ 5 GB 可用（Node + 依赖 ~400 MB、PostgreSQL、备份、2 GB swap 文件）；rpc3 `/` ≥ 2 GB。
- [ ] **内存**：ss02 可用 ≥ 700 MB（付款程序上限 600 MB、PostgreSQL ~300 MB；无 swap 时脚本加 2 GB swap）；rpc3 可用 ≥ 500 MB（监控上限 400 MB）。记录部署前后 `free -m` 与 nginx / coturn / 节点进程 RSS 对比。
- [ ] **邻居服务**：ss02 nginx、coturn `active`；rpc3 节点块高在涨、Blockscout / shim / nginx `active`（`SB_NEIGHBOURS` 可改服务名）。
- [ ] **出站**：443 到 nodejs.org、registry.npmjs.org、pkg.cloudflare.com、api.telegram.org、心跳服务、BSC RPC 提供商、rpc.wantos.io / rpc2.wantos.io（只读）；cloudflared 7844。
- [ ] **时间同步**（`timedatectl`）：监控有 `CLOCK_SKEW` 告警。
- [ ] **systemd ≥ 250**（`LoadCredentialEncrypted`）：Debian 13 是 257；**rpc3 若为 Ubuntu 22.04（249）需改用 `LoadCredential=` + root-only 文件**（见 §4 注）。
- [ ] 负责人的 **age 公钥**（备份收件人）已准备；Telegram 机器人与 chat id、外部心跳服务（电话 / 短信）已开通。

## 3. ss02（付款程序）步骤

以下均为 `sudo deploy/ss02-payout/deploy.sh <step>`，先不加参数看 dry-run，再加 `--apply`。

| 步 | 命令 | 做什么 | 验证 | 回退 |
|---|---|---|---|---|
| 3.1 | `preflight --apply` | 只读：打印检查表，保存基线到 `/root/savebridge-baseline/before.txt` | 检查表逐项为「是」 | 无改动 |
| 3.2 | `system` | 建 `savebridge`、`savebridge-tunnel`（nologin）；目录 `/etc/savebridge`(0750)、`/var/lib/savebridge`(0700)、`keystore`(0700)、`/var/log/savebridge`、`/var/backups/savebridge`(0700)、`/etc/credstore.encrypted`(0700)；logrotate；**无 swap 时**加 `/swapfile.savebridge` 2 GB + `vm.swappiness=10`；装 age / curl / gnupg | `getent passwd savebridge`、`swapon --show`、`free -m` | `userdel savebridge`；`swapoff /swapfile.savebridge` 并删 fstab 行（有备份）；删 `/etc/sysctl.d/90-savebridge-swappiness.conf` |
| 3.3 | `postgres` | 装 PostgreSQL（Debian 13 = 17），`conf.d/90-savebridge.conf`（`listen_addresses=localhost`，`shared_buffers=128MB`，`max_connections=20`，`work_mem=4MB` 等），集群单元 drop-in（Nice 5、权重 50、`MemoryHigh=500M`）；建角色 `savebridge`（非超级用户）与库 `savebridge`；**unix socket + peer 认证，无密码** | `ss -ltnp \| grep 5432` 只有 127.0.0.1 / ::1；`runuser -u savebridge -- psql savebridge -c 'select 1'` | 删 conf.d 文件与 drop-in → `systemctl restart postgresql@17-main`；`apt purge postgresql*`（无其他用户时） |
| 3.4 | `node` | Node 22 官方 tarball：Node 发布钥匙 GPG 验签 SHASUMS256 + tarball sha256（可用 `NODE_SHA256=` 钉住）；装到 `/opt/node-v22.x`，`/opt/node` 链接；corepack 准备 pnpm 10.34.5 | `/opt/node/bin/node --version`；gpgv 打印的指纹与 Node README 发布钥匙表一致 | 改回旧链接或删 `/opt/node*` |
| 3.5 | 本机：`deploy/common/build-release.sh` → 拷到 ss02；`release <tar> <sha256>` | 校验 sha256（第二渠道传达）→ 解到 `/opt/savebridge/releases/<commit>` → `pnpm install --frozen-lockfile --ignore-scripts --filter @bridge/relayer...` → 原子切换 `current` | `readlink /opt/savebridge/current` | `ln -sfn <上一个 release> /opt/savebridge/current` |
| 3.6 | **`keys`【A2】** | 三把钥匙各：负责人输入口令两次（不回显、≥16 字符、**离线保存**）→ 口令经 `systemd-creds encrypt` 存为凭据 `<name>-pass` → 以 `savebridge` 身份运行 `savebridge-keygen` 生成 0600 keystore，**只打印地址与公钥** | `ls -l /var/lib/savebridge/keystore`（0600，属主 savebridge）；`savebridge-keygen verify`（见 NOTES）；地址记入部署记录 | 钥匙尚未上链前可删除重来；上链后只能经时间锁换钥匙 |
| 3.7 | `backup-keystore` | keystore 目录 `tar \| age -R 负责人公钥` → `/var/backups/savebridge/keystore-<ts>.tar.age`；随后拷离主机 | 负责人用离线 age 私钥试解一次 | — |
| 3.8 | `credentials` | 交互输入 Telegram 令牌、chat id、心跳 URL（不回显，加密存储） | `ls /etc/credstore.encrypted` | `--allow-overwrite` 重输 |
| 3.9 | `config <relayer.json>` | 安装配置（拒绝含 64 位 hex 或 corsOrigins 以外的 URL）；首次放 `rpc.env` 模板（root 0600）→ **手工填 RPC URL**；提醒放 `backup-recipients.txt`（负责人 age 公钥） | `jq . /etc/savebridge/relayer.json`；`stat -c %a /etc/savebridge/rpc.env` = 600 | 有备份 |
| 3.10 | `systemd` | 安装 `savebridge-relayer.service`、备份 timer（**不启动**）；打印 `systemd-analyze security` 分数 | `systemctl cat savebridge-relayer` | 删单元 + daemon-reload |
| 3.11 | `cloudflared` | Cloudflare 官方 apt 源（核对密钥指纹）装 cloudflared；`savebridge-cloudflared.service`（独立用户，令牌走凭据文件 / 环境变量，**不进命令行**）；然后 `credential cf-tunnel-token` | `cloudflared --version` | 删单元 / 源 |
| 3.12 | `firewall` | **入站规则一律不动**；只检查出站是否受限，受限（ufw 默认拒绝出站）才加出站 443 / 7844 / 53 / 123；nftables 出站 drop 时只打印建议不改 | 前后 `ufw status verbose` / `nft list ruleset` 对比 | `ufw delete allow out …` |
| 3.13 | **`start`【A6】** | `enable --now` 付款程序、备份 timer、tunnel | 见 3.14 | `systemctl disable --now savebridge-relayer savebridge-cloudflared` |
| 3.14 | `verify` | 服务状态、nginx / coturn 状态、8080 只在回环、`/v1/quota` 有应答、日志里 `signers_loaded` / `started` 无 `fatal`、内存 / CPU 占用；与基线对比监听（**消失的监听或新增非回环监听 → 立即停下**） | 输出无 WARNING | — |

**Cloudflare 侧（负责人在 Qbit 账户）**：Zero Trust → Networks → Tunnels 新建 tunnel（remotely-managed），拿 token（只交给 `credential cf-tunnel-token`）；Public Hostname 例如 `api.bridge.wanto.pro` → `http://127.0.0.1:8080`；只放行 `/v1/*`（WAF 规则拦 `/admin/*`，API 本身 `DenyAllAdminSessions`）；加速率限制规则（每 IP 每分钟约 60）；CORS 由程序按 `corsOrigins` 控制。ss02 无需开任何入站端口。

## 4. rpc3（监控）步骤

`sudo deploy/rpc3-watcher/deploy.sh <step>`；同样默认 dry-run。**不碰节点、Blockscout、shim、nginx、防火墙**，不与它们共用账号。

| 步 | 命令 | 说明 / 验证 / 回退 |
|---|---|---|
| 4.1 | `preflight --apply` | 列运行中的服务、邻居状态、内存 / 磁盘、本机 8545 `eth_chainId`、systemd 版本；保存基线 |
| 4.2 | `system` | 用户 `savebridge-watcher`（nologin）；`/var/lib/savebridge-watcher/{state,keystore,ack}`（0700）；回退：`userdel` + 删目录 |
| 4.3 | `node`、`release <tar> <sha256>` | 同 ss02（`--filter @bridge/watcher...`） |
| 4.4 | **`keys`【A2】**、`backup-keystore` | `pauser-bsc`、`pauser-wantos` 两把；地址进合约部署参数与 `gasWatch` |
| 4.5 | `credentials`、`config <watcher.json>` | Telegram / 心跳凭据；配置来自 `deploy/watcher.config.example.json`；`rpc.env` 填 BSC 三家（**尽量与付款程序不同的服务商**，监控不得与付款程序共用数据源）与本机 WANTOS 端口 |
| 4.6 | `systemd`、`dry-run-service` | 装单元（`MemoryMax=400M`、`CPUQuota=50%`、`Nice=15`、`IOWeight=10`、`MemorySwapMax=0`；节点数据 / Blockscout / postgres / docker 目录不可见）；`dry-run-service` 以服务用户跑一轮 `--dry-run --once` 验证配置与 RPC（不暂停） |
| 4.7 | 合约部署、白名单、注资之后 | 配置里填真实桥 / 时间锁地址与 `startBlock` |
| 4.8 | **`start`【A6】**、`verify` | 先于付款程序启动；确认**零一级告警**；邻居服务与节点块高不受影响 |
| — | `ack <key>` | 负责人确认一级告警（Telegram 消息里的「确认键」）后停止 24h 重复 |

注：rpc3 若是 Ubuntu 22.04（systemd 249），`LoadCredentialEncrypted=` 不可用：`put_credential` / `keys` 会自动改存为 `/etc/credstore.encrypted/<name>`（root 0600 明文文件），需把单元里的 `LoadCredentialEncrypted=` 改为 `LoadCredential=`（待确认项 Q6）。

## 5. 启动顺序与灰度（与 RUNBOOK §6 / §10 一致）

1. 两台机器 1–3 步完成（只读与安装，不启动）→ 生成钥匙【A2】→ 主网合约部署【A3】（用这些地址）→ 验收脚本 V1–V14。
2. **监控先启动**【A6】→ 零一级告警 → 心跳演练：停监控，确认外部心跳服务按时电话 / 短信负责人，再启动。
3. **付款程序**【A6】（此时白名单为空，不处理任何订单）→ `verify`。
4. tunnel → 前端 → 首批（灰度）白名单【A4】→ 注资【A5】（金额即敞口上限）→ 阶段 A 冒烟（RUNBOOK §10）。

## 6. 告警与心跳（Telegram + 外部心跳）

- 一级 / 二级 / 三级告警都发 Telegram（纯文本，带级别、服务、代码、链、UTC 时间、**确认键**、处置提示；脱敏：RPC 密钥、令牌、64 位 hex 不出现）。同一告警 10 分钟内去重；二 / 三级每分钟最多 15 条，一级不限流；超长截断。
- **Telegram 不可达**：每条告警仍写本机日志（journald + `/var/log/savebridge/alerts.jsonl` / 监控 `state/alerts.jsonl`）；付款程序把失败的告警留在内存队列（上限 200，满时先丢二级），恢复后补发（>3 条合并为一条）；监控由 `AlertManager` 持久化逐通道重试。**一级告警超过 10 分钟发不出去时，两边都停发外部心跳** → 外部服务按超时电话 / 短信负责人（这是第二通道）。
- 外部心跳：付款程序每 60 s、监控每 5 min；外部服务超时建议 10 min（监控）/ 5 min（付款程序）。
- 一级告警的 24h 重复：监控在 `ack` 前重复；付款程序侧沿用 15 分钟去重。

## 7. RPC：每链 ≥3 个、rpc1 / rpc2 只读授权（2026-11-02 用户授权）

| 链 | 付款程序（ss02） | 监控（rpc3） |
|---|---|---|
| WANTOS | 主读取 + **唯一写入** = rpc3（`https://rpc3.wantos.io`）；交叉核对 = rpc1、rpc2（只读） | 本机 rpc3（`127.0.0.1`，读 + **唯一 pause() 写入**）+ rpc1 + rpc2（只读）；`minRpcAgreement = 2` |
| BSC | 三家服务商，`BSC_RPC_1` 兼广播 | 三家服务商（尽量与付款程序不同），`BSC_RPC_1` 兼 pause() 广播 |

**授权范围与限制**：rpc.wantos.io（rpc1）与 rpc2.wantos.io **只作为 WANTOS 只读交叉核对节点**：只读、低频、不压测、不 SSH、不触碰它们的服务与配置。代码强制：
- 写端点（付款程序 `writeRpcUrlEnv`、监控 `pauseWriteRpcEnv`）指向 rpc1 / rpc2 → **拒绝启动**；rpc1 / rpc2 也不能当付款程序的 WANTOS 主读取或 BSC 源。
- 传输层守卫：对 rpc1 / rpc2 只放行只读 JSON-RPC 方法白名单，`eth_sendRawTransaction` 等写方法在本地即被拒绝（不发网络请求，测试用记录主机与方法的 fake transport 断言）；`eth_getLogs` 区间 ≤ 200 块（且必须是数字区间）；不做传输层重试。
- 低频：付款程序轮询 ≥ 5 s（有 rpc1 / rpc2 时配置校验强制）、监控 tick ≥ 5 s（强制）；每主机令牌桶（付款程序 60 次/分钟、突发 10；监控 120 次/分钟、突发 20）；失败 / 限流后指数退避 2 s → 4 s → … 封顶 5 min，冷却期内本地快速失败（= 少一票），**不重试风暴**。
- **请求预算估算**（每个外部主机）：监控稳态实测每 tick 5 次（`eth_blockNumber`×1、`eth_getBlockByNumber`×2、`eth_getLogs`×2）→ 5 s tick ≈ **60 次/分钟**，加每小时对账与逐事件核对的少量 `eth_call` / 回执；付款程序每轮 1 次 `eth_getBlockByNumber`（有新块时）+ 每个新 WANTOS 事件 1 次回执 → 稳态 **≤ 15 次/分钟**。合计约 **75 次/分钟 ≈ 1.3 次/秒**；硬上限 = 两个令牌桶之和 180 次/分钟。
- rpc1 / rpc2 不可用或落后：只是「少一票」，照常发既有的 `RPC_UNREACHABLE` / `RPC_LAGGING` / `RPC_UNAVAILABLE`（付款程序）告警；**minAgree 不放松**。
- 独立性校验：同一主机（含不同端口 / 路径）或同一 `node` 标签的多个 URL 只算一个来源；回环地址必须标注 node（如 rpc3）。少于 minAgree（监控）/ 2（付款程序 WANTOS 主 + 交叉、BSC）个独立来源 → 拒绝启动；少于 3 个 → 启动日志警告。

**若用户撤销 rpc1 / rpc2 只读授权**：从两份 `rpc.env` 与配置里删除这两项。此时 WANTOS 只剩 rpc3 一个独立来源：
- 监控（minAgree = 2）与付款程序（需要 ≥1 个独立交叉核对）都会**拒绝启动**——这是有意的（不得静默降低 minAgree，同节点两个 URL 不能冒充两个来源）。
- 建议：① 另起一台独立的 WANTOS 非验证全节点（不同机器、不同网络）作为第二来源；② 在此之前**暂停桥**（或保持服务停止、不开白名单），而不是带着失效的交叉核对运行；③ 若负责人仍要求单源运行，属于对 DESIGN §6.2 / §9.1 的显式偏差，须负责人书面决定并另行改码（本次未实现单源模式）。单源的后果：rpc3 被攻破或分叉时，付款程序会按假的 `BridgeOut` 在 BSC 放款（损失上限 = BSC 储备），监控也无法发现（它读同一个节点）。

## 8. 备份

- **数据库**：`savebridge-backup.timer` 每日 03:17 UTC `pg_dump -Fc | age -R 负责人公钥`，保留 14 天，`/var/backups/savebridge/`；负责人定期拉到离线位置并试恢复（`age -d -i 私钥 … | pg_restore -d savebridge_restore`）。
- **keystore**：生成后立即 `backup-keystore`（age 加密，**再加一层**——keystore 本身已用口令加密）；**口令与 age 私钥分开保存**（例如口令在负责人的密码管理器，age 私钥在离线 U 盘），任何一处都不放在服务器上。
- 凭据（`/etc/credstore.encrypted/*`）绑定主机密钥，**不备份**；换机时重新输入。

## 9. 对同机现有服务的影响评估

| 资源 | ss02（nginx + coturn） | rpc3（节点 + Blockscout + shim） |
|---|---|---|
| CPU | 付款程序 `CPUQuota=60%`、`CPUWeight=30`、`Nice=10`；PostgreSQL `Nice=5`、权重 50；稳态 5 s 一轮，CPU 很低 | 监控 `CPUQuota=50%`、`CPUWeight=20`、`Nice=15` |
| 内存 | 付款程序 `MemoryMax=600M`（V8 堆 320 MB）、PostgreSQL ~150–300 MB（`shared_buffers=128MB`）；无 swap 时加 2 GB swap 兜底（付款程序与 tunnel 自身 `MemorySwapMax=0`，钥匙不进 swap） | `MemoryMax=400M`（堆 256 MB），节点 / Blockscout 不受 cgroup 影响 |
| 磁盘 IO | `IOWeight=30`；备份 `IOSchedulingClass=idle` | `IOWeight=10`（节点优先） |
| 网络 | 只出站；API 只在 127.0.0.1:8080，经 tunnel 回源；**不新增入站端口** | 只出站 + 本机 8545；rpc1 / rpc2 低频只读 |
| 配置 | 不改 nginx / coturn / sshd / journald / 入站防火墙；只新增自己的文件（`/etc/savebridge*`、`/opt/savebridge`、`/var/lib/savebridge`、单元、logrotate、sysctl swappiness） | 不改任何既有服务；单元里节点 / Blockscout / postgres / docker 目录对监控不可见 |
| 风险 | PostgreSQL 新增常驻 ~150 MB；`vm.swappiness=10` 为全局设置（影响很小，可回退） | 若 rpc3 本身内存紧张，监控 OOM 只会杀监控自身（cgroup 上限） |

验证方法：部署前后 `verify` 自动比较 `ss -ltnup`（监听）、邻居服务 `is-active`；另手工比较 `free -m`、`systemctl show nginx coturn -p MemoryCurrent`（rpc3：节点进程 RSS 与块高）。

## 10. 脚本清单

| 文件 | 用途 |
|---|---|
| `lib/common.sh` | dry-run / 幂等 / 覆盖保护 / 基线快照与监听对比 |
| `lib/app.sh` | Node 安装与验签、release 安装与原子切换、凭据输入、钥匙生成、age 加密备份 |
| `common/build-release.sh` | 本机打包 HEAD（要求工作区干净）并输出 sha256 |
| `ss02-payout/deploy.sh` + `files/` | 付款程序：用户、目录、swap、PostgreSQL、单元、cloudflared、防火墙检查、启动、验证、备份 |
| `rpc3-watcher/deploy.sh` + `files/` | 监控：用户、目录、单元、试运行、启动、验证、ack |
| `relayer.config.example.json` / `watcher.config.example.json` | 配置模板（无密钥 / 令牌 / URL；地址为占位） |
| `test/dry-run-sim.sh` | 本地模拟：所有系统命令替换为记录桩，断言 dry-run 不执行任何改动命令、各项守卫生效 |
