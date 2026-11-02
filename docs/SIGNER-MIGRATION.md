# 签名器迁移：本地 keystore → AWS KMS

> 今天灰度用 `local-keystore`（ss02 本机加密 keystore）；明天付款钥匙换 AWS KMS。本文是步骤与代码约定，不执行任何东西。依据 DESIGN §4.1 / §6.1、PR10-RUNBOOK §12.4。

## 1. 签名器工厂（代码现状）

- 接口不变：`TxSigner { address; signTransaction(tx: TransactionSerializableLegacy): Promise<Hex> }`（`packages/relayer/src/signer.ts`）。
- 实现：`LocalKeystoreSigner`（`src/keystoreSigner.ts`，今天用）、`KmsSigner`（`src/signer.ts`，**占位，仍拒绝签名**，实现步骤写在注释里）、`LocalTestSigner`（仅测试）。
- 工厂：`createSigner(ref, allowedChainIds)`（`src/bootstrap.ts`）按配置里每把钥匙的 `kind` 选择：

```jsonc
// 今天
"signer": { "kind": "local-keystore",
  "wantos": { "keystorePath": "/var/lib/savebridge/keystore/relayer-wantos.json", "passphraseCredential": "relayer-wantos-pass", "address": "0x…" },
  "bsc":    { "keystorePath": "/var/lib/savebridge/keystore/relayer-bsc.json",    "passphraseCredential": "relayer-bsc-pass",    "address": "0x…" } }
// 明天（KmsSigner 实现并通过测试之后）
"signer": { "kind": "kms", "wantosKeyId": "arn:aws:kms:…:key/…", "wantosAddress": "0x新", "bscKeyId": "arn:aws:kms:…", "bscAddress": "0x新" }
```

- `submitter` 独立选择（`kind: "local-keystore"` 或 `"kms"`）；提交服务热钥匙没有任何合约权限，**可以继续留在本地 keystore**（gas 只放 3 天用量），不必上 KMS。
- 启动时：三把发送钥匙两两不同；每把钥匙的地址与配置一致，否则拒启动（exit 78 + 一级 `STARTUP_FAILED`）。
- 监控的暂停钥匙不在本次迁移范围（DESIGN §4.1：热钥匙、只能暂停）；如以后也上 KMS，在 `runtime.pauser.kind` 增加 `kms` 实现即可（当前为占位、拒绝）。

## 2. KmsSigner 待实现要点（明天开工前的代码任务）

1. KMS 钥匙规格 `ECC_SECG_P256K1`，用途 `SIGN_VERIFY`；地址 = keccak256(公钥未压缩 64 字节)[12:]，`GetPublicKey` 取一次，与配置地址比对（不一致拒启动）。
2. `signTransaction`：序列化未签名 EIP-155 legacy 交易 → keccak256 → `Sign(MessageType=DIGEST, ECDSA_SHA_256)` → 解析 DER (r,s) → s 规范到低半区 → 两个 v 各试一次恢复出配置地址 → 序列化。与 `LocalKeystoreSigner` 相同的守卫：只签 legacy、chainId 必须在本钥匙允许的链。
3. 认证：ss02 上**不放长期 AWS 访问密钥**；用 IAM Roles Anywhere（X.509）或至少一个只允许 `kms:Sign`、`kms:GetPublicKey` 且只限这两把钥匙 ARN、只限 ss02 出口 IP（`aws:SourceIp`）的 IAM 用户，凭据走 systemd 凭据。KMS 钥匙策略禁止 `ScheduleKeyDeletion` 以外的管理操作给该身份。
4. 测试：用本地 KMS 模拟（固定 DER 向量 + 高 s 值 + 两个 v）单测；anvil E2E 换用 KmsSigner 跑一笔 W2B（与 `test/keystoreE2E.test.ts` 同形）。变异 ≥ 15。

## 3. 换钥匙步骤（付款钥匙，每条链分别做；先 WANTOS 后 BSC 或按负责人决定）

| 步 | 动作 | 谁 | 说明 |
|---|---|---|---|
| 1 | 在 AWS KMS 创建新钥匙（每条链一把），记录 ARN 与派生地址；给新地址转少量 gas | 负责人 / 总控 | 新地址与管理钱包、白名单钱包、暂停钥匙、提交服务**两两不同** |
| 2 | 管理钱包经**时间锁**提议 `grantRole(RELAYER_ROLE, 新地址)`（48h） | 负责人签名 | 监控会发一级 `TIMELOCK_PROPOSED`，属预期 |
| 3 | 48h 内：KmsSigner 上线前的验证（单测 + anvil E2E + 一次只读 `GetPublicKey` 比对） | 开发 | 旧钥匙继续放款 |
| 4 | 到期后提交服务自动执行提议（或任何人执行）→ 新钥匙生效 | 自动 | 核对链上 `hasRole(RELAYER_ROLE, 新地址)` |
| 5 | 改配置 `signer.kind = "kms"` + 新 ARN / 地址 → 重启付款程序 | 总控（经授权） | 启动自检通过、`signers_loaded` 显示新地址；先确认旧钥匙**没有在途交易**（`tx_attempts` 无 `signed` / `broadcast` 未决行，必要时等待或暂停该链后切换） |
| 6 | **立即吊销旧钥匙**：管理钱包 `revokeKey(RELAYER_ROLE, 旧地址)`（立即生效，不走时间锁） | 负责人签名 | 监控发角色变化告警，属预期 |
| 7 | 旧服务器清理：`shred -u` 旧 keystore、删除对应凭据 `/etc/credstore.encrypted/relayer-*-pass`、离线备份标记作废；旧地址剩余 gas 由负责人决定是否转回（需旧钥匙签名，在第 6 步前做） | 总控 / 负责人 | 在部署记录里登记作废时间 |

注意：
- 第 2 步之前不要删除本地 keystore；第 6 步之后旧钥匙无权限，即使泄露也只剩 gas 余额风险。
- 若切换中出现异常：暂停受影响的链 → 吊销可疑钥匙 → 取消可疑排队项 → 解除暂停（DESIGN §9.1 处置顺序）。
- 敞口：迁移期间两把钥匙同时有效（48h 等待期 + 切换窗口），损失上限仍由**金库注资量**与日额度决定。

## 4. 回退

- KMS 不可用：付款程序发送时报 `KMS_FAILURE`（二级）并 fail-closed，不会改用别的钥匙。临时回到本地 keystore 需要：本地钥匙**仍持有** `RELAYER_ROLE`（即第 6 步之前）；之后只能重新走 48h 时间锁授予一把新的本地钥匙。
- 配置回退 = 改回 `kind: "local-keystore"` 并重启；keystore 文件和凭据在第 7 步之前保留。
