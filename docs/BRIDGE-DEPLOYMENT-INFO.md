# SaveBridge 部署信息（整理，2026-11-03）

只记录公开信息：合约地址、交易哈希、链、源码位置。不含任何口令、私钥或凭据。

> ⚠️ **先看「三、需要确认的问题」**：BSC 上存在两套已部署的桥（2026-11-02 与 2026-11-03），两套都未暂停，需要负责人确认哪一套是正式的。

## 一、结论速览

| 项目 | 内容 |
|---|---|
| 跨链方式 | **锁定 + 释放**（lock / release）。两侧都不铸造、不销毁。桥合约用 `transferFrom` 收进代币，用 `transfer` 付出代币。 |
| 合约地址 | 两条链上桥代理地址**相同**（同一个地址，两链各一份代码）。 |
| 链 | WANTOS 主网（chainId **13555**）；BNB Smart Chain 主网（chainId **56**） |
| 合约组成 | 每条链 3 个合约：`BridgeTimelock`（时间锁）、实现合约（BSC 为 `BscVaultV2`，WANTOS 为 `WantosBridgeV2`）、`ERC1967Proxy`（桥代理，用户交互的地址） |
| 代币 | BSC 侧 USDT `0x55d398326f99059fF775485246999027B3197955`；WANTOS 侧 WUSDT `0xc74F2e7fBdA2af9D1fc26b85E341229063Dc0873` |
| 源码 | `contracts/src/`（`BridgeBase.sol`、`BscVaultV2.sol`、`WantosBridgeV2.sol`、`BridgeTimelock.sol`） |
| ABI | `packages/abi/src/`（`bscVaultV2.ts`、`wantosBridgeV2.ts`、`bridgeTimelock.ts`）；编译产物需要在 `contracts/` 下运行 `forge build` 生成 |
| 验收脚本 | `contracts/script/Verify.s.sol` |

## 二、跨链机制

**BSC → WANTOS（入金）**
1. 用户调用 `BscVaultV2.deposit(amount, wantosRecipient)`：金库用 `transferFrom` 收下 USDT（锁定），登记一笔存款。
2. 付款程序在 WANTOS 侧调用 `executeRelease`：WANTOS 桥用 `transfer` 把 WUSDT 付给收款人（释放）。付款前有 `b2wDelay` 排队和 `b2wDailyCap` 日额度。

**WANTOS → BSC（出金）**
1. 白名单地址调用 `WantosBridgeV2.bridgeOut(amount)`：桥用 `transferFrom` 收下 WUSDT（锁定），生成一笔订单。
2. 付款程序在 BSC 侧调用 `executeRelease`：金库用 `transfer` 付出 USDT（释放）。大额超过 `largeThreshold` 时延迟 `releaseDelay`。

**关于总量**：WANTOS 侧有 `supplyCeiling` 检查（`bridgeOut` 时检查 WUSDT 的 `totalSupply` 是否超过上限），桥本身不增发代币。

**防重放**：每条跨链事件的 `eventKey` 由源链序号推导，已处理的不能重复付款。

## 三、需要确认的问题（重要）

### 1. BSC 上有两套已部署的桥，两套都未暂停

BSC 链上（只读查询，publicnode 节点）：

| 套次 | 代理地址 | 实现地址 | 时间锁 | 代理部署交易 / 区块 | `paused()` | 代理持有的 USDT |
|---|---|---|---|---|---|---|
| A：2026-11-02 | `0xe2fD0F2Ee8041Ff1bDA023e6Fca65ba889114AD5` | `0x31BC1C89D0cB80C8f0e1b3d190cf8d096465d765` | `0xf60D6D98E1878c7f499788c19efcD671d00d8aC4` | `0xd4a85fb9…080f` / 131219867 | **false（未暂停）** | 14 USDT |
| B：2026-11-03 | `0x41e9900BF09553C46b6b3F267626FDa2b4711E44` | `0x668698E8683167F412550aEA9D72537435176297` | `0xE962600e3F9c608Cf7E0e80aB450ffE63b563618` | `0xdc30bcbd…dd8` / 131289654 | **false（未暂停）** | 12 USDT |

- 两套的代理、实现、时间锁地址在链上都有代码，并且 EIP-1967 实现槽与记录一致。
- 设计文档要求部署后两侧为 `paused=true`，实际两套都是未暂停状态。原因未知，需要负责人确认是谁、何时执行了 `unpause`，或者两套的部署记录有误。
- 两套合计只有 26 USDT，不影响资金安全，但"未暂停"本身需要处理。

### 2. 文档之间的矛盾

- `docs/DEPLOY-RECORD-20261102.md` 记录的是套次 A（2026-11-02，部署者 `0x480C…1d1A`，已说明部署者钥匙已删除）。
- `docs/REDEPLOY-PLAN-20261103.md` 的文件头写的是"方案定稿待确认，未执行"，但第 12 节又记录了套次 B 的部署（部署者 `0x5AEB…7ABC`），并写明源码改动"尚未提交"，在分支 `redeploy-20261103` 上。
- 负责人此前明确"不需要重新部署"。套次 B 是否为正式部署，需要负责人确认。

### 3. WANTOS 侧未做链上核对

我没有可用的 WANTOS 只读节点（rpc3 只能本机隧道访问，rpc1/rpc2 不作为查询用途）。WANTOS 侧的地址和交易哈希只能按文档记录，没有链上核对。

### 4. 白名单状态未核对

文档记录白名单为空（两链 `whitelistNonce = 0`），我尚未在链上读取确认。

## 四、两套部署的参数与角色（按部署记录）

| 角色 | 地址 | 说明 |
|---|---|---|
| 管理钱包（时间锁提议人） | `0x860f5B29f60F86c82b18f789E0219Cf966375669` | 负责人硬件钱包 |
| 白名单钱包 | `0x8F36C2b951ff9Cc752844d50460e1e3D51EaF4A9` | 负责人钱包 |
| 放款钥匙（BSC） | `0xbf5c657b891Bc8d0099F8fA24d71280B8b916436` | RELAYER |
| 放款钥匙（WANTOS） | `0x82AB70DEC303F16E530B6Ab61CaBD3F44d97C3C1` | RELAYER |
| 暂停钥匙（BSC） | `0x4340Ea96e85FE3A439cAC03e7bdc54E066DF3c3d` | PAUSER |
| 暂停钥匙（WANTOS） | `0x4236630355BDCf5f00373b247C6708cb4efC4FEF` | PAUSER |

BSC 参数以 `docs/deploy-params/bsc.env` 为准（第六版）：全局日额 50 万 USDT，单地址日额 2 万，大额阈值 2,000，放款延迟 12 小时，单笔存款上限 1000 万，最小存款 10 USDT。

WANTOS 参数以 `docs/deploy-params/wantos.env` 为准：出金最小 10 USDT，单地址日额 2 万，`b2wDailyCap`（WANTOS 付给用户的每日释放总量上限）1 亿，`b2wDelay` 900 秒，`supplyCeiling` 3001 万。

注意：`REDEPLOY-PLAN` 里 `B2W_DELAY` 写的是 0，`wantos.env` 写的是 900，两者需要统一。

## 五、部署交易记录

**套次 A（2026-11-02）**

| 链 | 合约 | 地址 | 交易 | 区块 |
|---|---|---|---|---|
| BSC | BridgeTimelock | `0xf60D6D98E1878c7f499788c19efcD671d00d8aC4` | `0x7d246a87961871470ba9f84db5a8bb93ef868619515be9d7efcf8a7d18ab13d2` | — |
| BSC | BscVaultV2 实现 | `0x31BC1C89D0cB80C8f0e1b3d190cf8d096465d765` | `0x33d7da688dfae191950659fdce4faac82bf0ce0c114030551c5f677aa1012403` | — |
| BSC | ERC1967Proxy 桥 | `0xe2fD0F2Ee8041Ff1bDA023e6Fca65ba889114AD5` | `0xd4a85fb957df840b63ebd1c1a7ecaeeb7d0ca975f31ed872ee3f2a979995080f` | 131219867 |
| WANTOS | BridgeTimelock | `0xf60D6D98E1878c7f499788c19efcD671d00d8aC4` | `0x2ca8a807e1ef2508ec3c3423e92ed1a80a5c51d7a739958c76de1f97b2b234f0` | 3458824 |
| WANTOS | WantosBridgeV2 实现 | `0x31BC1C89D0cB80C8f0e1b3d190cf8d096465d765` | `0x4f9e73df8862113b61b3ce44cb8d66a800bd725fd731981954c04a7ce453cdb3` | 3458825 |
| WANTOS | ERC1967Proxy 桥 | `0xe2fD0F2Ee8041Ff1bDA023e6Fca65ba889114AD5` | `0xe70af4d9d26d664d5920918b6609f39d2c3858d7547b962629250a4d8e15ea66` | 3458826 |

监控起点：BSC `131237000`（记录中的配置值），WANTOS `3460300`。

**套次 B（2026-11-03）**

| 链 | 合约 | 地址 | 交易 | 区块 |
|---|---|---|---|---|
| BSC | BridgeTimelock | `0xE962600e3F9c608Cf7E0e80aB450ffE63b563618` | `0xf4c455bb157cf290b365dee805e4cda8986dfb58bf4a1ca07280d9c95ca0d4c3` | 131289649 |
| BSC | 实现 | `0x668698E8683167F412550aEA9D72537435176297` | `0x032023b4bb2b6b72b7104e28f14a0a033545f0cbc69d71221d555186d275495d` | 131289652 |
| BSC | ERC1967Proxy 桥 | `0x41e9900BF09553C46b6b3F267626FDa2b4711E44` | `0xdc30bcbd8f017f89a995d1c9e71d96b61edcd834e0b718477526889fe4497dd8` | 131289654 |
| WANTOS | 时间锁 / 实现 / 代理 | 同上三个地址 | 见 `REDEPLOY-PLAN-20261103.md` §12 | 3465057 / 3465058 / 3465059 |

注：套次 B 的三个 BSC 交易已在链上核对：时间锁 `0xf4c455…` 的回执 `contractAddress` 与记录一致，区块 131289649；代理 `0xdc30…` 的 `contractAddress` 为 `0x41e9…`，区块 131289654。实现合约的交易哈希未单独核对。套次 A：时间锁交易 `0x7d246a…` 的回执 `contractAddress` 与记录一致（区块 131219862）；代理交易 `0xd4a85f…` 与实现交易 `0x33d7da…` 未单独核对，但代理地址和实现槽已在链上核对。

## 六、源码位置与核对方法

- 源码：`contracts/src/`，编译版本 `^0.8.26`。
- 验收：`contracts/script/Verify.s.sol`（部署后检查角色、时间锁、参数、白名单、地址和 nonce）。
- 地址预测：`contracts/script/PredictAddresses.s.sol`（两链地址由部署者 nonce 决定，所以两链地址相同）。
- 链上核对示例（BSC，只读）：`eth_getCode`、`eth_getTransactionReceipt`、EIP-1967 实现槽 `0x3608…2bbc`、`paused()` 选择器 `0x5c975abb`。

## 七、业务规则（白名单、限额、延迟、退款）

本节按 `redeploy-20261103`（`85186fe`）的源码整理，即 0x41e9… 对应版本。参数数值以第四节的部署参数文件为准。

### 7.1 白名单

- **存放位置**：两条链各自的桥合约里保存一份白名单，两份用同一个白名单钱包的签名写入。
- **写入方式**：白名单钱包签 EIP-712 批次（`WhitelistBatch`，含 `listHash`、`count`、`allowed`、`nonce`、`deadline`），每批最多 500 个地址。签名域名为 `SaveBridgeWhitelist`，不含 chainId，所以同一份签名在两条链上都有效。
- **谁能改**：
  - 白名单钱包签名写入或移除地址。
  - 白名单管理员（whitelistManager）可以失效 nonce（`invalidateWhitelistNonce`）、紧急移除地址。
  - 管理钱包（admin）可以冻结白名单（`freezeWhitelist`，冻结后不能再写入），也能紧急移除地址。
- **交接与恢复**：白名单管理员的交接分两步，先发起、再接受，有效期内可以取消。恢复流程有冷却期。
- **受限的环节**：
  - WANTOS 侧 `bridgeOut`：发起人必须在白名单内，且不能是合约地址。
  - BSC 侧 `release`、`queueRelease`、`executeRelease`：收款地址必须在白名单内。
- **不受限的环节**：BSC 入金（`deposit`）、WANTOS 侧付给用户的入金释放（`queueRelease`）、退款（`executeRefund`、存款退款）。

### 7.2 限额

限额分两个方向。"出金"指从 WANTOS 到 BSC，"入金"指从 BSC 到 WANTOS。

**出金（WANTOS → BSC）**

| 限额 | 位置 | 含义 |
|---|---|---|
| `w2bMinAmount` | WANTOS | 单笔最小金额（10 USDT） |
| `w2bPerAddrDailyCap` | WANTOS | 每地址每个 UTC 日的上限，也是单笔上限（2 万） |
| `supplyCeiling` | WANTOS | `bridgeOut` 时检查 WUSDT 的总供应量是否超过上限（3001 万） |
| `dailyCap` | BSC | 全局每个 UTC 日的付款上限，排队中和存款退款也计入（50 万） |
| `perAddrDailyCap` | BSC | 每地址每个 UTC 日的上限，也是单笔上限（2 万） |
| `largeThreshold` | BSC | `release` 立即付款的上限（2,000）；超过的必须排队 |

**入金（BSC → WANTOS）**

| 限额 | 位置 | 含义 |
|---|---|---|
| `minDeposit` | BSC | 单笔最小存款（10 USDT） |
| `maxDepositPerTx` | BSC | 单笔最大存款（1000 万） |
| `b2wDailyCap` | WANTOS | 全局每个 UTC 日的释放上限，入金释放和退款执行都计入（1 亿） |

注意：`b2wDailyCap` 是 WANTOS 付给用户的每日总量上限，不是入金额限制，也不限制存款金额。

**限额的计算方式**：所有"每日"限额都按 UTC 自然日计算，每天 0 点重置。

### 7.3 延迟

| 延迟 | 位置 | 说明 |
|---|---|---|
| `releaseDelay` = 12 小时 | BSC | 超过 `largeThreshold` 的付款先排队，到期后才能执行。`queueRelease` 时就计入 `dailyCap`。 |
| `b2wDelay` = 900 秒 | WANTOS | 入金释放先排队，到期后才能执行。合约要求不超过 24 小时。`wantos.env` 为 900，重新部署方案为 0，需统一。 |
| `REFUND_DELAY` = 24 小时 | WANTOS、BSC | 退款发起后，到期才能执行。 |

### 7.4 退款

**WANTOS 订单退款**（针对出金订单）：
1. 管理员（admin）发起退款，订单状态变为 `Refunding`，记录发起时间。
2. 等待 24 小时。期间管理员或白名单管理员可以取消退款（取消后订单回到原状态）。
3. 24 小时后任何人都可以执行退款，把原金额退给原用户。执行时计入 `b2wDailyCap`。

**BSC 存款退款**（针对入金存款）：
1. 管理员发起，但 WANTOS 侧必须先作废对应的事件（eventKey）。
2. 等待 24 小时，期间可以取消。
3. 执行时把 USDT 退给存款人，计入 `dailyCap`。

### 7.5 暂停

两条链的桥都支持暂停（`pause`/`unpause`）。暂停时，`bridgeOut`、`deposit`、`release`、`executeRelease`、`executeRefund` 等会被拒绝。

### 7.6 参数修改

- **时间锁路径（48 小时）**：可以改任意参数，只要通过合约内的取值范围检查。
- **管理钱包直接修改**：只能收紧，不能放宽。
  - WANTOS 侧：`w2bMinAmount` 不能调低，`w2bPerAddrDailyCap` 和 `b2wDailyCap` 不能调高，`b2wDelay` 不能调低。
  - 这个约束针对管理钱包的直接调用，时间锁路径不受限。

### 7.7 数据来源

- 业务规则来自 `contracts/src/BridgeBase.sol`、`BscVaultV2.sol`、`WantosBridgeV2.sol`。
- 参数数值来自 `docs/deploy-params/bsc.env`（第六版）和 `wantos.env`。

## 八、监控配置（只监控新桥 0x41e9…）

负责人 2026-11-03 决定：监控只盯最新的桥 `0x41e9900BF09553C46b6b3F267626FDa2b4711E44`，旧桥相关监听全部去掉。

主机上 watcher 配置需要对应修改（本地模板只改了 `legacyAddresses`，其他字段仍是占位）：

| 配置项 | 值 |
|---|---|
| `chains.bsc.bridge` / `chains.wantos.bridge` | `0x41e9900BF09553C46b6b3F267626FDa2b4711E44` |
| `chains.bsc.timelock` / `chains.wantos.timelock` | `0xE962600e3F9c608Cf7E0e80aB450ffE63b563618` |
| `chains.bsc.startBlock` | `131289654` |
| `chains.wantos.startBlock` | `3465059` |
| `legacyAddresses` | `[]`（去掉旧 WANTOS 金库 `0x8dFd`、旧付款程序 `0x9dab`、旧 BSC 金库 `0xec6e`） |

说明：
- 监控除了桥代理，还读取该桥自己的时间锁（`0xE962…3618`）的事件，升级、提取、参数修改都从时间锁看到，建议保留。如果只想监控代理地址，需要另外确认，会少掉这些告警。
- 11-02 那套（`0xe2fD…4AD5`，时间锁 `0xf60D…8aC4`）不再监控。
- 如果主机监控此前配置的是 11-02 那套，切换后要注意游标：状态目录里的游标已经越过 11-03 的部署区块，直接换地址会漏掉新桥部署以来的事件。要么把游标重置到上面的 `startBlock`（可能重复告警），要么先确认新桥部署以来没有事件。
- 改完需要重启 watcher 服务，这一步属于生产操作，需要负责人确认后执行。

## 九、异常出金告警（本地已实现，未部署）

监控对 WANTOS 桥的 `BridgeOut`（用户发起出金订单）增加两条二级告警，只告警，不会自动暂停：

| 告警 | 触发条件 | 默认值 | 去重 |
|---|---|---|---|
| `LARGE_WITHDRAWAL` | 单笔订单金额**大于**阈值 | 2,000 USDT | 每个订单一条 |
| `FREQUENT_WITHDRAWALS` | 同一地址在时间窗口内的订单数达到次数（不论金额大小，小额多次也算） | 1 小时内 5 次 | 每个地址每个窗口最多一条 |

配置项（可选，缺省用上面的默认值）：

```json
"withdrawalAlerts": { "largeWei": "2000000000000000000000", "frequent": { "count": 5, "windowSeconds": 3600 } }
```

说明：
- 单笔大额告警对未确认的订单也会触发（尽早发现）；频繁出金只统计已确认的订单。
- 窗口数据存在 watcher 的状态文件里，旧状态文件兼容，不需要清理。
- 只监控 WANTOS → BSC 出金订单。入金（BSC → WANTOS）、BSC 侧放款不在这两条告警范围内；BSC 侧超过 `largeThreshold` 的排队放款仍然进每日汇总。
- 不包含"同一地址 24 小时累计金额"告警；需要的话可以再加。
- 代码与测试已在本地（`packages/watcher`），`withdrawal-alerts.test.ts` 在去掉实现后会变红。要生效需要部署 watcher 代码，不涉及合约。
