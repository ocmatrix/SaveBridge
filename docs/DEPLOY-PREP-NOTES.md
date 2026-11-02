# deploy-prep 灰度上线部署准备：实现说明、威胁说明、偏差与待确认

> 分支 `deploy-prep`（基于 main：PR-1/3/5/6/7/8）。范围：本地加密签名器、生产入口接线、部署脚本与说明。**未登录 / 修改任何服务器，未向任何真实链发交易，未访问 rpc1 / rpc2**；测试只用本机 anvil（127.0.0.1 随机端口）与把生产主机名路由到本机 anvil 的记录型 transport。17 条决定未改；风控仍只靠白名单。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `packages/ops/`（新包 `@bridge/ops`） | `keystore.ts`（scrypt + AES-256-GCM keystore、权限检查、加载并钉住地址）、`keygen.ts` + `keygenCli.ts`（`savebridge-keygen create / verify`）、`credentials.ts`（systemd 凭据读取）、`telegram.ts`（Telegram 通知：去重、限流、脱敏）、`heartbeat.ts`（外部心跳 ping）、`rpcPolicy.ts`（独立性、读写分离、rpc1/rpc2 只读守卫、预算与退避）、`redact.ts` |
| `packages/relayer/src/keystoreSigner.ts` | `LocalKeystoreSigner implements TxSigner`（接口不变） |
| `packages/relayer/src/telegramSink.ts` | `TelegramAlertSink implements AlertSink`（本地日志 + 有界重发队列 + 一级卡住检测） |
| `packages/relayer/src/bootstrap.ts` | 生产接线：端点策略 → 守卫后的 client → 签名器工厂（`local-keystore` / `kms`）→ 告警 → `RelayerDeps`；`gatedHeartbeat` |
| `packages/relayer/src/config.ts` | 新增可选字段：`signer.kind = "local-keystore"`、`submitter` 同、`wantos/bsc.writeRpcUrlEnv`、`rpcNodes`、`externalRpc`、`alerts`、`heartbeat.urlCredential`；新校验：API 只能回环、三把发送钥匙两两不同、keystore 路径不同、凭据名合法、`poll.intervalMs ≥ 1000` |
| `packages/relayer/src/main.ts` | 用 bootstrap 启动；配置 / 钥匙 / RPC 策略错误 → 一级 `STARTUP_FAILED`（新告警码）+ exit 78 |
| `packages/watcher/src/deploy.ts` | 部署配置（RPC 由环境变量注入、`runtime` 段）、独立性、只读守卫、keystore PAUSER（`keystoreRawTxSender`，只经 `PauseOnlySigner`）、`TelegramChannel`、`gatedHeartbeat`、ack 收件箱 |
| `packages/watcher/src/main.ts` | 用 deploy.ts 启动；tick 间隔来自配置（≥ 5 s） |
| `deploy/` | 见 `deploy/README.md` §10 |
| `docs/SIGNER-MIGRATION.md` | 换 AWS KMS 的步骤与工厂约定 |
| `scripts/mutation-deploy-prep.py` | 变异测试（在独立副本上跑） |

## 2. 签名器加密方案与威胁说明

**方案**（不自造加密，只组合 Node / OpenSSL 标准原语）：`key = scrypt(口令, salt 32B, N=2^17, r=8, p=1)` → `AES-256-GCM(key, iv 12B)` 加密 32 字节私钥，**AAD 绑定全部头字段**（格式、版本、标签、地址、公钥、创建时间、KDF 参数、salt、算法、iv）。读入时：结构严格校验、`N ≥ 2^17`（防降级）、`N ≤ 2^20`（防内存炸弹）、GCM 校验、解出的私钥在曲线阶内、由私钥推出的地址 = 头地址 = 配置地址，否则拒启动。错误口令与篡改都只报 `DECRYPT_FAILED`（不区分）。

**口令与密钥的生命周期**
- 生成：在目标服务器本机，`deploy.sh keys`：负责人在终端输入两次（`read -s`，不回显、不进 argv / 环境 / shell 历史）→ `systemd-creds encrypt` 存为加密凭据 → 同一口令经管道交给以服务用户运行的 `savebridge-keygen`（拒绝 `--passphrase` 类参数，拒绝从交互终端读）→ keystore 以 `O_EXCL`、`0600` 写入 `0700` 目录，**从不覆盖**；写完立即回读解密自检，失败则删除自己刚建的文件；只输出地址与公钥。
- 运行：systemd `LoadCredentialEncrypted=` 把口令解密到该服务私有的内存文件系统（`$CREDENTIALS_DIRECTORY`，0400）；进程启动读一次，派生密钥与口令 Buffer 立即清零；私钥只在 viem 账户对象里（JS 字符串**无法清零**，只在本进程内存）；`MemorySwapMax=0` 防止换出到 swap，`LimitCORE=0` 禁 core dump，`ProtectProc=invisible` 隐藏他人进程。
- 签名守卫：只签 EIP-155 legacy（拒绝 1559 / accessList / 无 chainId），每把钥匙只签配置的链（付款钥匙各一条链，提交服务两条链），nonce / gas / gasPrice 必须显式；任何失败由 sender 既有路径变成 `KMS_FAILURE` 告警且不发送（fail-closed）。
- 日志 / 告警：错误只带固定代码与路径；Telegram 文本与本地日志统一脱敏（URL 路径 / 查询 / userinfo、Authorization、token=…、64 位 hex、已注册的令牌 / chat id / 心跳 URL）；测试断言日志与错误中不含私钥和口令。

**威胁说明（如实）**
| 威胁 | 本方案 | 剩余风险 / 兜底 |
|---|---|---|
| keystore 文件或备份被拷走 | scrypt + GCM，需口令；备份另用 age 加密到负责人公钥 | 弱口令可被离线爆破 → 口令 ≥ 16 字符、建议随机生成 |
| 服务器磁盘镜像被拿走（云快照等） | 口令凭据由主机凭据密钥加密（`/var/lib/systemd/credential.secret`，Linode 无 TPM） | **该主机密钥也在同一磁盘上** → 镜像同时拿到二者即可解出私钥；快照访问权要收紧 |
| ss02 被拿到 root / 服务用户 | 无防护（可读内存、凭据） | **本地签名的本质局限**：钥匙可被直接使用 → 损失上限 = 金库注资量（每日额度已按决定放宽）+ 白名单约束（只能付给白名单地址）+ 监控 §9.1 核对自动暂停 + 负责人可随时暂停 / 吊销 |
| 同机其他服务（nginx / coturn）被攻破 | 独立系统用户；keystore 目录 0700；单元里其他服务配置不可见、本服务 `NoNewPrivileges`、`ProtectSystem=strict` 等 | 本地提权漏洞 → 同上一行 |
| 日志 / 告警泄露 | 统一脱敏、错误不含秘密、Telegram 只发纯文本 | Telegram 服务器能看到告警内容（不含秘密） |
| 配置被改成攻击者地址 | 地址在配置里、启动时与 keystore 双重比对 | 能改配置者通常已有 root（同上） |

结论：本地 keystore 防的是「文件被拷走」，**防不住主机被控制**；与 DESIGN §6.1「KMS 只防钥匙被拷走，真正的防线是链上白名单和额度」一致。今天的敞口上限 = 注资量，明天换 KMS（`docs/SIGNER-MIGRATION.md`）。

## 3. 生产入口接线

**付款程序**：`RELAYER_CONFIG` → `parseConfig` → 告警（stderr / journald + `alerts.logFile` + Telegram，外层 15 分钟去重）→ `resolveEndpoints`（读写分离、独立性、rpc1/rpc2 只读、轮询 ≥ 5 s）→ `buildClients`（守卫 transport）→ 逐端点 `eth_chainId` 核对 → `buildSigners`（工厂，三把两两不同）→ PostgreSQL（unix socket + peer，无密码）→ `Relayer`（`wantos.client` / `bsc.client` = **写端点 rpc3 / BSC_RPC_1**，主读取与交叉核对是只读 client）→ 时间锁执行器（提交服务钥匙，走写端点）→ API 只在 `127.0.0.1`（`parseConfig` 强制回环）→ 主循环。心跳：`HttpHeartbeat`（60 s 节流）包在 `gatedHeartbeat` 里。

**监控**：`--config` → `resolveDeployConfig`（`chains.X.rpc: [{env, node}]` 从环境变量取 URL，配置里出现 URL 即拒绝）→ `startupGuard`（无签名器只能 `--dry-run`）→ 告警通道 [stdout, alerts.jsonl, Telegram]（`AlertManager` 逐通道持久化重试）→ `buildGuardedRpc`（全部为只读 client）→ `buildPauseSenders`（keystore 解密、地址钉住、写端点 chainId 核对、两链钥匙不同）→ `PauseOnlySigner`（只能 `pause()`）→ `Watcher`；每轮先处理 ack 收件箱。

**ack 入口（临时形态）**：`deploy/rpc3-watcher/deploy.sh ack <确认键>` 在 `/var/lib/savebridge-watcher/ack/` 放一个 `.ack` 文件，下一轮生效并删除；未知键会把当前打开的一级键列表写进日志。Telegram 一级告警文案带「确认键」。

## 4. RPC 约束（2026-11-02 用户授权 rpc1 / rpc2 只读交叉核对）

设计要求每链 ≥ 3 个独立 RPC、`minAgree = 2`；授权后 WANTOS 侧 = rpc3（主读取 + **唯一写入**）+ rpc1 + rpc2（只读），满足要求，**无偏差**。实现与约束细节、请求预算（稳态约 75 次/分钟/外部主机）、撤销授权后的处理见 `deploy/README.md` §7。要点：
- 配置模型里读、写端点分开（付款程序 `writeRpcUrlEnv`，监控 `pauseWriteRpcEnv`）；写端点指向 rpc1 / rpc2 → 拒启动；传输层再挡一次（只读方法白名单，写方法本地拒绝、零网络请求）。测试：`packages/ops/test/rpcPolicy.test.ts`（fake transport 记录主机与方法）、`packages/relayer/test/keystoreE2E.test.ts`（生产接线跑完 W2B + B2W，断言写方法只发往 rpc3 / BSC 写端点、rpc1 / rpc2 只收到只读方法）、`packages/watcher/test/integration/deploy-keystore-pause.test.ts`（pause() 只发往本机 rpc3）。
- 同主机或同 `node` 标签 = 一个来源；回环 URL 必须标注 node；独立来源不足 → 拒启动，不降低 minAgree。
- rpc1 / rpc2 挂掉或落后 = 少一票，走既有 `RPC_UNREACHABLE` / `RPC_LAGGING` / `RPC_UNAVAILABLE` 告警。

## 5. 测试

- 新增：`@bridge/ops` 53 例（keystore 往返 / 错误口令 / 10 种头字段篡改 / 弱 KDF / 权限位 / 符号链接 / 不覆盖 / 地址钉住 / 口令清零；CLI 用生产 scrypt 参数实跑；Telegram 去重 / 限流 / 脱敏 / 失败不含令牌；心跳；RPC 策略）；relayer 新增 21 例（签名器、配置、端点策略、告警降级、模板解析、anvil E2E）；watcher 新增 11 例（部署配置、Telegram 通道、心跳门控、ack、anvil 集成）。
- 既有测试未改弱：唯一改动是 `EXAMPLE_CONFIG` 里三把发送钥匙的占位地址由同一个 `0x…dEaD` 改为三个不同占位（新校验要求两两不同）。
- 变异：`scripts/mutation-deploy-prep.py`，在临时独立副本上逐个注入、跑对应测试（结果见 GATE2 报告）。
- 脚本：`shellcheck` 全部通过；`deploy/test/dry-run-sim.sh` 用记录桩替换所有系统命令，断言 dry-run 不执行任何改动命令、各守卫生效（28 项）。**未在 Debian 13 / Ubuntu 实机或容器里以 `--apply` 运行**（本机 Docker 未运行，且本轮禁止登录服务器）。

## 6. 偏差（均为保守选择）

| # | 内容 | 依据 | 说明 |
|---|---|---|---|
| D1 | 付款钥匙今天是本地加密 keystore，不是 KMS | DESIGN §6.1 | 用户决定；明天换 KMS；威胁见 §2 |
| D2 | 告警只有 Telegram（即时消息）+ 外部心跳服务（电话 / 短信由该服务提供），没有直接的电话 / 短信通道 | §9.3 一级「电话 + 短信」 | 一级告警发不出去超过 10 分钟 → 停发心跳 → 外部服务打电话；外部服务需配置电话 / 短信通知（待确认 Q2） |
| D3 | 付款程序的一级告警没有 24h 重复（沿用 15 分钟去重）；监控侧有 | §9.3 | 付款程序侧的一级告警（重组、重复放款、心跳中断）同时会被监控以自己的码报告 |
| D4 | ack 入口是服务器上的文件收件箱（`deploy.sh ack`），不是后台按钮 / Telegram 命令 | PR7 运维 3 | 不让 Telegram 机器人反向控制监控（攻击面）；待确认 Q3 |
| D5 | PostgreSQL 监听 `localhost`（127.0.0.1 + ::1），付款程序用 unix socket + peer 认证（无密码） | 任务「仅监听 127.0.0.1」 | 比密码更少秘密；`::1` 也是回环 |
| D6 | 运行时用 `node --import tsx` 直接跑 TypeScript（与仓库 `start` 脚本一致），服务器上 `pnpm install --frozen-lockfile --ignore-scripts --filter <包>...` | — | 锁文件含完整性哈希；未做打包产物 |

## 7. 待确认

| # | 事项 | 当前保守处理 |
|---|---|---|
| Q1 | ss02 访问 rpc3 的写入路径：`https://rpc3.wantos.io` 是否经 shim（是否需要 `X-Wantos-Key` 车道令牌）？付款程序的发送 client 不带自定义头 | 模板写 `WANTOS_RPC3=https://rpc3.wantos.io`；若需要令牌，需在 viem http transport 加 header（令牌走凭据），上线前确认 |
| Q2 | 外部心跳服务选型（healthchecks.io 类）及其电话 / 短信通知；超时阈值（建议监控 10 min、付款程序 5 min） | 只需一个 HTTPS ping URL（凭据 `heartbeat-url`） |
| Q3 | ack 入口形态（文件收件箱是否足够） | 文件收件箱 |
| Q4 | rpc3 本机 WANTOS RPC 端口（模板 `127.0.0.1:8545`）与 pause() 是否应走 shim 的车道 | 直连本机节点（单笔 pause，非并发） |
| Q5 | 监控与付款程序的 BSC 服务商是否互不相同（PR7：监控不与付款程序共用数据源） | 模板分别占位，部署时由负责人选定 |
| Q6 | rpc3 的 Ubuntu / systemd 版本：< 250 时无 `LoadCredentialEncrypted`，凭据退化为 root 0600 明文文件 + `LoadCredential=` | 脚本自动退化并警告；单元需手工改一行 |
| Q7 | `vm.swappiness=10`（全局）与新增 2 GB swap 是否可接受（ss02 是 SynStar 流量节点） | 仅在无 swap 时添加；可回退 |
| Q8 | 每日额度「合约允许的较高值」的具体数：BSC `dailyCap` 上限 50 万、`perAddrDailyCap` 2 万；WANTOS `b2wDailyCap` 20 万、`w2bPerAddrDailyCap` 2 万（DESIGN §5.5 范围） | 不在本分支内设定（合约参数属部署步骤 A3） |
| Q9 | Node 22 补丁版本（脚本默认 22.20.0）与发布钥匙指纹人工核对 | 部署时核对最新 22.x LTS，`NODE_SHA256` 可钉住 |
| Q10 | 撤销 rpc1/rpc2 授权时是否接受「停服 / 暂停」而非单源运行 | 代码不提供单源模式；见 README §7 |
