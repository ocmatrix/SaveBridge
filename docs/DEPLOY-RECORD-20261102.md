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
