# 部署记录（2026-11-02，试运营）

只记录公开信息（地址、版本、位置）。口令、私钥、令牌不入库。

## 发送钥匙（A2，2026-11-02 已生成，本地加密钥匙文件）

| 名称 | 地址 | 位置 | 用途 |
|---|---|---|---|
| relayer-wantos | 0x82AB70DEC303F16E530B6Ab61CaBD3F44d97C3C1 | ss02 `/var/lib/savebridge/keystore/relayer-wantos.json` | WANTOS 侧放款（RELAYER，待授予） |
| relayer-bsc | 0xbf5c657b891Bc8d0099F8fA24d71280B8b916436 | ss02 `…/relayer-bsc.json` | BSC 金库放款（RELAYER，待授予） |
| submitter | 0x3C26c1A43719225458456Bb7bd05D0Ac7150f7d4 | ss02 `…/submitter.json` | 提交交易的热钥匙，无合约权限，只放 3 天 gas |
| pauser-bsc | 0x4340Ea96e85FE3A439cAC03e7bdc54E066DF3c3d | rpc3 `/var/lib/savebridge-watcher/keystore/pauser-bsc.json` | 监控暂停 BSC（PAUSER，待授予） |
| pauser-wantos | 0x4236630355BDCf5f00373b247C6708cb4efC4FEF | rpc3 `…/pauser-wantos.json` | 监控暂停 WANTOS（PAUSER，待授予） |

口令由负责人亲手输入、离线保存。ss02 为 systemd-creds 加密凭据（0600），rpc3 为 root 0600 明文凭据文件（systemd 249，只含暂停钥匙口令）。

## 已安装（A1，只安装、未启动）

- rpc3（43.128.14.237，Ubuntu 22.04，systemd 249）与 ss02（172.232.246.175，Debian 13）：Node v22.20.0（签名人 Richard Lau，指纹 C82FA3AE…B93C 已核对）、pnpm 10.34.5、发布包 `1ad9662b7b4a`（依赖锁文件校验）。
- rpc3 系统包升级：curl、libcurl4、ca-certificates（apt）；ss02 新装 age/gnupg/gpgv 等。
- 待统一清理：两台机器的 `sb-stage` 与旧发布包、rpc3 的 `sbread` 用户、本机 `rpc3_ro_ed25519`。

## 部署参数（负责人 2026-11-02 回复「冻结」）

- 部署者 `0x480CDAe459876000Cbe16CBd28a96F9416001d1A`（本机加密钥匙文件 `~/.savebridge-deployer/deployer`；两链 nonce 0）。
- 参数文件 `docs/deploy-params/bsc.env`（sha256 `021fa9a76f7ac5846561dc97301a4feb49b4836535277a041b4b2797bf45659f`）、`docs/deploy-params/wantos.env`（sha256 `15da2930c354c61266d08b4813f25eda666a417509c5bcd3f8c7a21a933e3a50`）；冻结后不得原地修改，要改须重新冻结、重算哈希。
- 预测地址（两链相同）：时间锁 `0xf60D6D98E1878c7f499788c19efcD671d00d8aC4`、实现 `0x31BC1C89D0cB80C8f0e1b3d190cf8d096465d765`、桥代理 `0xe2fD0F2Ee8041Ff1bDA023e6Fca65ba889114AD5`。
- 主网模拟（不广播）两链均成功，地址与预测一致：BSC 约 1078 万 gas、需 0.00054 BNB（余额 0.00306）；WANTOS 约 1052 万 gas、需 0.67 WANT（余额 2）。
- WANTOS `supplyCeiling` 在 2026-11-02 读取时 totalSupply = 3000 万，上限 = 3001 万；部署前一刻须重读。
- 误转：部署者地址收到 2 USDT（WANTOS）；部署完成后由负责人用同一钥匙签名退回（完整收款地址待给）。

### 参数修改（负责人 2026-11-02，冻结后、部署前，第二版）

BSC `largeThreshold` 1,000 → 10,000；BSC `maxDepositPerTx` 2,000 → 20,000（合约上限，「入账不限」）；WANTOS `w2bPerAddrDailyCap` 2,000 → 20,000（合约上限）。`releaseDelay` 仍 12h，`minDeposit` / `w2bMinAmount` 仍 10。重新模拟：两链成功，地址与预测一致。上面的哈希已更新为第二版。

### 参数修改（第三版，负责人 2026-11-02）

风控重心 = BSC 金库出金（防被盗）：`dailyCap` 50 万 → **5 万**、`largeThreshold` 1 万 → **2,000**（≤2,000 立即放款，更大排队 12h）、`perAddrDailyCap` 保持 2 万。入金（跨进 WANTOS）不限制：BSC `maxDepositPerTx` 取合约上限 2 万、WANTOS `w2bPerAddrDailyCap` 取合约上限 2 万、WANTOS `b2wDailyCap` 20 万（均为合约允许的最大值，「不限」在合约里只能到此）。`bsc.env` 哈希更新为第三版；`wantos.env` 未变。重新模拟两链成功，地址与预测一致。

### 参数修改（第四版，负责人 2026-11-02：取消入金限制）

入金（BSC 到 WANTOS）上限取消：合约里的范围上限是源码常量，已改源码——BSC `maxDepositPerTx` 上限 2 万 → **1000 万**，WANTOS `b2wDailyCap` 上限 20 万 → **1000 万**（`contracts/src`、`apps/admin-web/src/lib/params.ts`、DESIGN §5.5 同步）；部署初值均取 1000 万。新增 2 个边界测试（1000 万通过、多 1 wei 回滚；改回旧上限时会红）；合约测试 242 个全过，admin-web 85 个全过。出金限制不变（BSC 日额 5 万、单地址 2 万、大额阈值 2,000、延迟 12h）。`w2bPerAddrDailyCap` 2 万不变。哈希更新为第四版；预测地址不变（地址只取决于部署者和 nonce）。**合约字节码有改动，部署前须重新编译；未做外部审计。**

### 参数修改（第五版，负责人 2026-11-02）

WANTOS `b2wDailyCap`（每个 UTC 日的额度，非总额）上限 1000 万 → **1 亿**，部署初值取 1 亿（源码常量、admin-web 范围、DESIGN 表同步）。BSC `maxDepositPerTx` 仍 1000 万。合约测试 242 个全过、admin-web 85 个全过；新边界测试在旧上限下会红。`wantos.env` 哈希更新为第五版，`bsc.env` 不变；主网模拟 WANTOS 通过，地址与预测一致。

### 参数修改（第六版，负责人 2026-11-02）

BSC 全局日额 `dailyCap` 5 万 → **50 万**（合约上限）。大额阈值 2,000（超过排队 12h）、单地址日额 2 万、延迟 12h 不变。`bsc.env` 哈希更新为第六版，`wantos.env` 不变；BSC 主网模拟通过，地址与预测一致。注意：日额大于金库实际资金，真正的敞口封顶仍是注入金库的资金，大额排队与监控暂停是主要拦截手段。

## BSC 主网部署（G2，负责人 2026-11-02 授权并亲自输入钥匙密码）

| nonce | 合约 | 地址 | 交易 |
|---|---|---|---|
| 0 | BridgeTimelock | 0xf60D6D98E1878c7f499788c19efcD671d00d8aC4 | 0x7d246a87961871470ba9f84db5a8bb93ef868619515be9d7efcf8a7d18ab13d2 |
| 1 | BscVaultV2（实现） | 0x31BC1C89D0cB80C8f0e1b3d190cf8d096465d765 | 0x33d7da688dfae191950659fdce4faac82bf0ce0c114030551c5f677aa1012403 |
| 2 | ERC1967Proxy（桥） | 0xe2fD0F2Ee8041Ff1bDA023e6Fca65ba889114AD5 | 0xd4a85fb957df840b63ebd1c1a7ecaeeb7d0ca975f31ed872ee3f2a979995080f |

- 三个地址与预测一致；部署后部署者 nonce = 3；三个地址在 publicnode 与 bsc-dataseed 上都有代码。
- 验收脚本 `Verify.s.sol` 在 BSC 上全部通过（角色、时间锁成员与延迟、参数、空白名单、地址一致）。
- 实现合约链上字节码与本地编译一致，仅有 60 个字节差异，位于 UUPS 的 immutable（合约自身地址）处；广播的 initcode 与本地编译逐字节相同。
- forge 在 `--slow` 过程中打印过「dropped from the mempool」提示，但三笔均已上链确认，该提示无影响。
- BSC 代理部署区块 = 监控 `startBlock` = **131219867**（时间锁在 131219862）。回执中确认已授予：RELAYER 0xbf5c…6436、PAUSER 0x4340…3c3d、白名单钱包 0x8F36…F4A9；时间锁提议人 = 管理钱包 0x860f…5669。

## WANTOS 主网部署（G3，负责人 2026-11-02 授权并亲自输入钥匙密码）

| nonce | 合约 | 地址（与 BSC 相同） | 交易 | 区块 |
|---|---|---|---|---|
| 0 | BridgeTimelock | 0xf60D6D98E1878c7f499788c19efcD671d00d8aC4 | 0x2ca8a807e1ef2508ec3c3423e92ed1a80a5c51d7a739958c76de1f97b2b234f0 | 3458824 |
| 1 | WantosBridgeV2（实现） | 0x31BC1C89D0cB80C8f0e1b3d190cf8d096465d765 | 0x4f9e73df8862113b61b3ce44cb8d66a800bd725fd731981954c04a7ce453cdb3 | 3458825 |
| 2 | ERC1967Proxy（桥） | 0xe2fD0F2Ee8041Ff1bDA023e6Fca65ba889114AD5 | 0xe70af4d9d26d664d5920918b6609f39d2c3858d7547b962629250a4d8e15ea66 | 3458826 |

- WANTOS 监控 `startBlock` = **3458826**（代理部署区块）。
- 三笔均成功，部署者 nonce = 3；实际花费 0.273 WANT，部署者余额剩约 1.727 WANT。
- 验收脚本 `Verify.s.sol` 在 WANTOS 上全部通过（含 `supplyCeiling` 3001 万）；实现合约链上字节码与本地编译仅有 60 字节差异（UUPS immutable），广播 initcode 与本地逐字节相同。
- 两条链的桥地址相同：**0xe2fD0F2Ee8041Ff1bDA023e6Fca65ba889114AD5**。

## 部署后待办（按顺序）

1. 部署者收尾：用同一钥匙把误转的 2 USDT 退回，并退回剩余 BNB / WANT；然后销毁部署者钥匙（需负责人给出完整收款地址）。
2. 开源验证三个合约（BscScan 与 scan.wantos.io）。
3. 写监控 / 付款程序的真实配置（桥、时间锁地址、startBlock、BSC 节点、心跳、Telegram），启动顺序：监控 → 付款程序。
4. 首批白名单（白名单钱包两链各签一次）→ 注资 → 冒烟 → 开放。

## 部署者收尾（负责人亲自签名，2026-11-02）

- 误转的 2 USDT 已退回 `0xf49334e15FDd743ddc0E73FD57561D5E40e40929`：WANTOS 交易 0x2bfd2a36994b88d9a549b7ab58a56cbfe30b6352fbff8742b9686428e7d0905a（区块 3458884）。
- 剩余 WANT（1.72）退回同地址：0x808bdeea91cc2c081ce67df65fbc880b33a7ff1c897b42a2f4cf47faf8c75cc5（区块 3458890）。
- 剩余 BNB（0.00264）退回同地址：BSC 0xb58772ef521cab5709a64ad0446c43f9ce7ec0063886a873c795df4097eebbce（区块 131221256）。
- 部署者现余：WANTOS 约 0.005 WANT、BSC 约 0.0000047 BNB、0 USDT（零头，不再转）。部署者不持有任何合约角色（验收脚本断言）。
- 待办：销毁部署者钥匙文件 `~/.savebridge-deployer/deployer`，并忘掉其密码。

## 部署者钥匙销毁
- 2026-11-02：用户确认已删除 `~/.savebridge-deployer/deployer`（目录已不存在，我核对过）。部署者不持有任何合约角色，后续服务均不使用。

## 监控（rpc3）就绪记录
- 发布 `savebridge-5ece07faf349`（main 5ece07f，含 Node family autoselection 修复）已切为 current；服务未启用未启动。
- 配置：BSC 起点 131237000、WANTOS 起点 3460300（部署后两链桥合约无新事件，已核对）；BSC 节点 publicnode + rpc-bsc.48.club（1rpc 超时已弃用）；`wantosLowBalanceWei`=5000 USDT。
- 凭据（服务器上，值由用户亲手输入）：telegram-bot-token / telegram-chat-id / heartbeat-url / 两个暂停口令。
- 试运行两次：第 2 次无心跳失败；剩余告警均为预期（桥未注资、钥匙无 gas）；对账在落后追赶期被 48.club 拒绝旧区块读取，待实时运行验证。
- 待办：两个暂停钥匙与管理/白名单钱包充 gas；旧 telegram token 备份文件 `/etc/credstore.encrypted/telegram-bot-token.savebridge-bak-*` 清理；rpc3 一次性 SSH 钥 claude-savebridge-rpc3-20261102 清理；试运行状态目录 `/var/lib/savebridge-watcher/dryrun-old*` 清理。
