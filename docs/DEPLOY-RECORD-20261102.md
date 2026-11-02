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
- 参数文件 `docs/deploy-params/bsc.env`（sha256 `77e79ace5b5aec775e772c88d7cca78dfa9af69c046675e17c237f96e4e2a712`）、`docs/deploy-params/wantos.env`（sha256 `5c597c2ae3ce5f759c0c854783032ab5825bb33a23c77906c038a90619fb4376`）；冻结后不得原地修改，要改须重新冻结、重算哈希。
- 预测地址（两链相同）：时间锁 `0xf60D6D98E1878c7f499788c19efcD671d00d8aC4`、实现 `0x31BC1C89D0cB80C8f0e1b3d190cf8d096465d765`、桥代理 `0xe2fD0F2Ee8041Ff1bDA023e6Fca65ba889114AD5`。
- 主网模拟（不广播）两链均成功，地址与预测一致：BSC 约 1078 万 gas、需 0.00054 BNB（余额 0.00306）；WANTOS 约 1052 万 gas、需 0.67 WANT（余额 2）。
- WANTOS `supplyCeiling` 在 2026-11-02 读取时 totalSupply = 3000 万，上限 = 3001 万；部署前一刻须重读。
- 误转：部署者地址收到 2 USDT（WANTOS）；部署完成后由负责人用同一钥匙签名退回（完整收款地址待给）。

### 参数修改（负责人 2026-11-02，冻结后、部署前，第二版）

BSC `largeThreshold` 1,000 → 10,000；BSC `maxDepositPerTx` 2,000 → 20,000（合约上限，「入账不限」）；WANTOS `w2bPerAddrDailyCap` 2,000 → 20,000（合约上限）。`releaseDelay` 仍 12h，`minDeposit` / `w2bMinAmount` 仍 10。重新模拟：两链成功，地址与预测一致。上面的哈希已更新为第二版。

### 参数修改（第三版，负责人 2026-11-02）

风控重心 = BSC 金库出金（防被盗）：`dailyCap` 50 万 → **5 万**、`largeThreshold` 1 万 → **2,000**（≤2,000 立即放款，更大排队 12h）、`perAddrDailyCap` 保持 2 万。入金（跨进 WANTOS）不限制：BSC `maxDepositPerTx` 取合约上限 2 万、WANTOS `w2bPerAddrDailyCap` 取合约上限 2 万、WANTOS `b2wDailyCap` 20 万（均为合约允许的最大值，「不限」在合约里只能到此）。`bsc.env` 哈希更新为第三版；`wantos.env` 未变。重新模拟两链成功，地址与预测一致。
