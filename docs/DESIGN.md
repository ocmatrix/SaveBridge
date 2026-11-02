# SaveBridge（白名单跨链桥 v2，WANTOS ↔ BSC USDT）设计开发文档

> **SaveBridge** = 跨链桥 + 白名单管理（项目正式名；仓库目录名暂不改）。
>
> 版本 **v0.9.5**（2026-11-02，按负责人最新决定精简：**风控只靠白名单**，删除资金来源检查与受控来源集合；部署形态改为 Cloudflare Workers 静态资源；见文末「v0.9.5 同步说明」；17 条决定未变；v0.9.4 全文备份在 `docs/archive/`）｜状态：待确认，**未开工**（负责人指示：先不开工）
>
> v0.9.3 按"**简洁、安全、壮硕**"三原则复审后修订：安全上补了 3 处漏洞；简洁上砍掉了旧单 Merkle 机制、CancelProxy 合约、小时桶额度、多余参数和重复状态；壮硕上堵住了监控误暂停、暂停期间无法修复升级、链回滚等故障点。旧版本存档在 `docs/archive/`（v0.7～v0.9.2、v0.9.4）。
>
> **负责人已拍板的决定（本版据此设计，不再讨论）：**
> 1. 严格白名单、默认拒绝；合约部署时白名单**为空**；只有负责人能添加和移除，在管理后台的同一个页面操作；网体关系只作参考。
> 2. 白名单**两条链都写**。
> 3. 合约**可升级**、管理员**可更换**，都要经过 48 小时时间锁。
> 4. 管理员现阶段由负责人一人担任（**管理钱包**），以后交接给团队多签。
> 5. 管理钱包和白名单钱包是**两个不同的钱包**。两者的交接都由负责人发起，负责人提供指定的新地址，新持有人通过交接链接签名接收。
> 6. **白名单钱包同时是"取消"钥匙**：可以取消任何待执行的升级、参数放宽、储备提取、管理员变更。不设第三个钱包。
> 7. 增加**只能暂停**的服务器钥匙（PAUSER）。
> 8. 用户跨链页 `bridge.wanto.pro`；管理后台 `admin.wanto.pro`（暂定名），**交接页并入管理后台的 `/handover` 路径**（v0.9.3 修改）；均部署在负责人的 Cloudflare 账户（Qbit）。
> 9. WANTOS 侧启动资金由负责人直接转入 WANTOS 桥合约。
> 10. 白名单钱包泄露时，管理钱包可以紧急介入：否决白名单钱包交接、冻结白名单写入、移除地址（只能收紧）。
> 11. 每批白名单不需要管理钱包额外签名；每批变更实时推送给负责人，并生成每日变更报告，由负责人定期巡查。
> 12. 告警由负责人一人接收。
> 13. 两种恢复机制对称：任一恢复的现任持有人可以取消它；恢复进行期间白名单自动禁止写入。钥匙真丢失时无人取消，恢复照常完成。
> 14. **WANTOS-USDT 被增发时只告警，不自动暂停**（v0.9.3 修改）；增发上限由合约 `supplyCeiling` 兜底。
> 15. 接受"钥匙被盗且双方互相取消"时可能长期僵持，不设链上"最后手段"出口。
> 16. 精简原则：不为极端场景叠加额外的签名、限额、冷却、名单审批；运营日常操作尽量不超过"一批白名单 = 两次签名"。
> 17. （v0.9.3）**两个钱包都可以解除暂停**。

---

## 0. 目标

1. 原技术人员手里可能残留的任何旧私钥，都**拿不走新桥里的钱**。
2. 他控制的 WANTOS 资产所在地址不在白名单里，**无法直接跨出**；转给白名单用户代跨，则不做来源判断：白名单地址基本是提前报备、公司实名登记的，由白名单 + 每地址额度 + 暂停兜底。
3. **任何一把新钥匙单独泄露，资金都不会被直接拿走**，损失有链上上限，并且会被发现、可以止损。**前提是负责人在恢复窗口内（白名单钱包恢复 7 天、管理钱包恢复 14 天）响应告警**；两个钱包同时失守时，损失上限是整个储备。钥匙丢失可以按期恢复；钥匙被盗且真主仍握有副本时可能僵持（桥受限、资金不被拿走），见 §11。
4. 团队照常发展：新用户的地址由负责人分批录入白名单即可跨链。

---

## 1. 背景

### 1.1 旧桥现状（链上只读核实）

| 角色 | 地址 | 现状 |
|---|---|---|
| WANTOS 旧金库（可升级代理） | `0x8dFd39E98f478688A41Cdbe40bc544d672F0A9E3` | 锁着约 94.9 万 WANTOS-USDT；**没有暂停**；owner `0x7afc…c3ad`；升级权属于 `0x9272` |
| BSC 旧金库（可升级代理） | `0xeC6E356a2E986D6A9b103217B9d215c8a6F37139` | owner 和升级权都是 `0x9272…9502` |
| 旧付款程序 | `0x9dAb17a9Ad061cbDA2BeF607A6A330EE74076E90` | 2026-11-01 13:04 仍在两条链上发交易，位置不明 |
| BSC 旧储备 | 4 个普通钱包（Stargate LP）+ 补水钱包 `0xe1e8…ff10` | 已枯竭 |
| WANTOS-USDT | `0xc74F2e7fBdA2af9D1fc26b85E341229063Dc0873` | owner `0xc081…f003` 可增发；04-15 发行 3,000 万后未再增发 |
| 旧前端 | `mgfound.online`（原技术人员的 Cloudflare 账户） | 公司无法下线 |

### 1.2 旧桥失控的根因与新桥对策

| 问题 | 对策 |
|---|---|
| 一个钱包一笔交易就能升级 | 升级只经 48h 时间锁，白名单钱包可取消（§4） |
| 付款钥匙能付给任意地址，额度只在链下 | 链上只付白名单地址；全局 + 每地址每日额度写在合约里（§5） |
| 储备放在普通钱包 | 储备只存在合约里；提取只经时间锁 |
| 放款不检查来源 | 链上只付白名单地址（提前报备、实名登记）+ 额度 + 暂停（§7）；不做资金来源判断 |
| 私钥硬编码在代码里 | 付款钥匙进 KMS；任何钥匙不进代码和配置（§6） |

### 1.3 需要防住的资产

`0xf974`（2,531 万 WANTOS-USDT）、MG 池 LP `0xcca4`、`0xeabd`（9,880 万 MG）、合约 `0x778b`/`0x7fd9`（96.5 万 MG）、合约 `0xb7f4`（14.8 万 USDT）、旧金库 `0x8dFd`（94.9 万）、`0xc081` 增发权等。这些地址不会被录入白名单，自己无法跨出；风险在于"转给白名单用户代跨"，v0.9.5 起不再做来源判断，靠白名单实名登记 + 每地址日额度 + 暂停兜底（§7）。

---

## 2. 设计原则

**简洁、安全、壮硕**：

1. **简洁**：能不要的机制就不要；一个机制能解决的，不用两个；日常操作越少越好。
2. **安全**：放宽要等（48h 时间锁，白名单钱包可取消），收紧立即；钥匙全新、权力拆开、互斥；风控只靠白名单、额度和暂停，不叠加其他规则。
3. **壮硕**：最坏情况宁可桥暂停，也不能被提走；监控不能误停桥；重启、重组、断网、钥匙丢失、操作失误都不应让资金卡死或让负责人疲于奔命。
4. **监控只能暂停，不能取消**：取消订单、作废来源只能由负责人的两个钱包执行。

---

## 3. 总体架构

```
 ┌──────────── WANTOS 链 ─────────────┐                  ┌────────────── BSC 链 ───────────────┐
 │ WantosBridgeV2 (UUPS)              │                  │ BscVaultV2 (UUPS，持有 USDT)         │
 │  bridgeOut(查白名单) / 订单存档    │                  │  release / queue / execute（只付白名单）│
 │  B2W 入账（短排队）/ 退款          │                  │  deposit / 入账退款                  │
 │ BridgeTimelock (48h)               │                  │ BridgeTimelock (48h)                 │
 └──────────────▲─────────────────────┘                  └───────────────▲──────────────────────┘
     付款程序 Relayer v2（服务器 A）：自建节点 → 链上检查 → 放款 / 排队 / 审核；另含只发交易的提交服务
     独立监控 Watcher（服务器 B）：多 RPC 实时核对 → 告警（负责人）→ PAUSER 暂停受影响的链
   bridge.wanto.pro（用户）                 admin.wanto.pro（管理后台，含 /handover 交接页）
```

---

## 4. 钥匙、角色与权力

### 4.1 钥匙

| 钥匙 | 持有者 | 形态 | 能否是合约 |
|---|---|---|---|
| **管理钱包** | 负责人（交接后为团队多签） | 硬件钱包 | 可以（多签直接作为 `msg.sender` 调用） |
| **白名单钱包（WL）** | 负责人 | 硬件钱包，与管理钱包不同 | 必须是普通地址（EOA） |
| **付款钥匙（RELAYER）** | 服务器 A，两条链各一把 | KMS | 必须是普通地址 |
| **暂停钥匙（PAUSER）** | 服务器 B，每条链一把 | 热钥匙，只能暂停 | 必须是普通地址 |

- 两个钱包都需要在两条链上备少量 gas（WANT、BNB），监控也监控这两个钱包的 gas 余额。
- 白名单批次是纯签名，由**任意账户**提交；到期时间锁提议也由**任意账户**执行。这两类交易由服务器 A 上的**提交服务**（一把只发交易、不拥有任何权限的热钥匙）代发。
- 暂停钥匙被吊销后，管理钱包或白名单钱包仍可手动暂停；补发新暂停钥匙走 48h 时间锁。

### 4.2 合约结构

每条链部署：桥合约（UUPS 代理）、`BridgeTimelock`、一个一次性的部署者 EOA。（**没有 CancelProxy**）

**桥合约**：最高管理权 `DEFAULT_ADMIN_ROLE` 只授给本链时间锁；四类钥匙（管理钱包、白名单钱包、付款钥匙、暂停钥匙）两两不同，在授予、交接时检查，**并在桥合约 `initialize` 里通过 `timelock.adminWallet()` 检查一次**；白名单钱包不是普通角色，`grantRole/revokeRole/renounceRole` 对它无效。

**`BridgeTimelock`**（继承 OZ v5 `TimelockController`，不可升级）规格：

1. 延迟 48h，`MIN_DELAY = 48h` 为 immutable，`updateDelay` 的新值必须在 48h ～ 7 天之间（防止误填超大延迟冻结治理）。
2. `admin = address(0)`。构造函数里一次性完成全部授权（提议人 = 管理钱包，执行人 = 任何人），并记下桥地址（预计算，immutable）；**构造期间跳过互斥检查**。
3. **提议人恰好一个**：覆盖 `_grantRole/_revokeRole/renounceRole`，禁止直接增删；换管理钱包时提议权一起迁移。
4. **`cancel` 覆盖为直接判断**：允许 `msg.sender == adminWallet()` 或 `msg.sender == bridge.whitelistManager()`（运行时读取）。白名单钱包交接或恢复后，取消权自动跟随，不需要任何额外合约或角色变更。
5. 管理钱包只能通过 `transferAdmin`（经时间锁 → `pendingAdmin`，7 天有效 → 新地址在链上 `acceptAdmin()`）或恢复流程更换。
6. 提议到期后 14 天内必须执行，过期作废：OZ 枚举无法新增 `Expired`，所以过期操作按"已失效"处理，另提供 `isOperationExpired(id)`；过期后换 salt 重新提议。
7. 每个提议记录所属 `epoch`；管理钱包恢复完成时 `epoch += 1`，旧提议作废。
8. 对外提供 `adminWallet()`；桥合约所有"管理钱包直接可调"的函数都检查它，交接后自动跟随。
9. （v0.9.4）**执行后自检，约束今后所有升级**：时间锁在每次执行（含升级）后检查桥的 `paused()`、恢复标志、白名单钱包（非零且 `isKeyHolder`）、`timelock()` 视图；新实现必须保留这些视图且语义不变，否则整笔执行回滚。

### 4.3 权力矩阵（两条链相同；仅单边的函数已注明）

**A. 放宽类：必须经 48h 时间锁**（管理钱包提议；管理钱包或白名单钱包可取消）

| 操作 | 暂停期间能否执行 | 恢复期间能否执行 |
|---|---|---|
| 升级桥合约 `upgradeToAndCall`（新实现须先开源验证、存储布局检查通过） | **能**（出 bug 时要修） | 否 |
| 授予 / 吊销付款钥匙、暂停钥匙（互斥检查） | **能** | 否 |
| 提取储备 `withdraw(to, amount)` | 否 | 否 |
| 放宽额度和延迟 `setParams`（§5.5） | 否 | 否 |
| 提高 `supplyCeiling`（仅 WANTOS） | 否 | 否 |
| 旧单补付 `payLegacyBatch`（仅 BSC，§10） | 否 | 否 |
| 解除白名单写入冻结 | 否 | 否 |
| 更换管理钱包 `transferAdmin` | 否 | 否 |

**B. 收紧类：管理钱包立即执行**

| 操作 | 约束 |
|---|---|
| 收紧参数 `setParams`（一笔交易完成全部收紧；其中任何一项是放宽就整笔回滚） | 参数间约束必须成立 |
| 吊销付款钥匙 / 暂停钥匙 | 立即生效 |
| 撤销排队放款 `cancelRelease`、作废 `voidSource`（含批量 `voidSourceBatch`） | 白名单钱包也可调用；暂停期间仍可用 |
| 否决白名单钱包交接、冻结白名单写入、移除白名单地址 | 决定 10；两条链各调用一次 |
| 启动白名单钱包恢复 | §4.5 |

**C. 暂停与解除**

| 操作 | 谁 |
|---|---|
| 暂停 `pause` | 暂停钥匙、管理钱包、白名单钱包；立即 |
| 解除暂停 `unpause` | **管理钱包或白名单钱包**（任一个即可，决定 17） |

暂停期间不可用：放款、排队、执行、跨出、存入、退款执行，以及 A 类中标"否"的操作。暂停期间仍可用：取消、作废、撤销、吊销、冻结、移除白名单、升级、换钥匙。

**D. 白名单钱包**

| 操作 | 约束 |
|---|---|
| 添加 / 移除白名单（EIP-712 签名批次） | §4.4 |
| 作废已签未提交的批次 `invalidateWhitelistNonce` | 只有白名单钱包可调 |
| 发起 / 取消白名单钱包交接 | §4.5 |
| 取消任何时间锁提议；取消管理钱包发起的白名单钱包恢复 | — |
| 暂停；解除暂停；撤销排队放款；作废来源 | — |
| 发起管理钱包恢复（管理钱包丢失时） | §4.6 |

**E. 付款钥匙**

| 操作 | 约束 |
|---|---|
| `release` / `queueRelease` / `executeRelease`（BSC） | 只付白名单地址；扣额度 |
| `queueRelease` / `executeRelease`（WANTOS，B2W 入账） | 一律排队 `b2wDelay`；单独的 `b2wDailyCap` |

`executeRelease`（两条链）**只限付款钥匙**调用，不是任何人。

**F. 任何人**

| 操作 | 约束 |
|---|---|
| `bridgeOut(amount)`（WANTOS）、`deposit(amount, wantosRecipient)`（BSC） | §5 |
| `fund(amount)`（两条链） | 补水，发 `Funded` 事件 |
| `executeRefund` / `executeDepositRefund` | 只能退给原地址、原金额；计入本链已有日额度；暂停时不可用 |

### 4.4 白名单写入：EIP-712 签名批次

```solidity
// domain: name="WantosBridgeV2" | "BscVaultV2", version="1", chainId, verifyingContract
struct WhitelistBatch {
    bytes32 listHash;   // keccak256(abi.encode(sortedAddrs))，地址严格递增
    uint32  count;      // 地址个数
    bool    allowed;    // true=添加，false=移除
    uint256 nonce;      // 等于合约当前批次 nonce
    uint256 deadline;   // 签名后 24 小时内有效
}
function applyWhitelistBatch(address[] calldata sortedAddrs, bool allowed, uint256 nonce,
                             uint256 deadline, bytes calldata wlSignature) external;
//   合约重算 listHash 与 count；校验签名者 == 当前白名单钱包；地址严格递增；零地址拒绝；
//   单批 ≤ 500 个（PR-0 确认硬件钱包显示后定稿）；恢复进行期间或冻结时拒绝添加
function invalidateWhitelistNonce() external;   // 只有白名单钱包
event WhitelistBatchApplied(bytes32 indexed listHash, bool allowed, uint256 nonce, uint256 count);
event WhitelistUpdated(address indexed addr, bool allowed, bytes32 indexed listHash);
```

- **不在合约里检查地址是否为合约**：地址可能在签名后变成委托地址、或在两条链上一边有代码一边没有，链上检查会让整批回滚或造成两链不一致。合约地址只在管理后台提示；WANTOS 侧 `bridgeOut` 自己拒绝合约调用者。
- 负责人签名前，用**离线核对工具**（§8.3）算出 `listHash`、`count`，以及最终的 EIP-712 domain hash 和 message hash，无论硬件钱包显示什么，都能比对。
- 每批在两条链上各签一次。**写入顺序**：添加先 BSC 后 WANTOS；移除先 WANTOS 后 BSC。
- 每批变更实时推送给负责人，另有每日变更报告（含管理钱包的紧急移除），由负责人定期巡查。
- **地址被移除时的在途订单**：订单创建之后出现过移除事件、且当前仍不在白名单 → 先进入 REVIEW（`whitelist_removed`，审核级），由负责人签名拒绝后才 REJECTED（走退款）（用户 2026-11-02 确认：以 PR-3 实现为准；多一道人工确认，防止误移除导致在途订单被自动退回）；只是另一条链还没写入 → WAITING，30 分钟未一致告警。

### 4.5 白名单钱包交接与恢复

**正常交接**（负责人发起）：
1. （建议）新持有人在交接页做一次 `personal_sign`，提前发现地址填错。
2. 当前白名单钱包调用 `beginWhitelistManagerTransfer(新地址)`，两条链各一次。
3. 等满 48 小时；期间白名单钱包可取消，管理钱包也可否决。
4. 新持有人调用 `acceptWhitelistManagerTransfer()`，两条链各一次，旧地址立即失效；取消权自动跟随。
5. 7 天未接收自动作废。

**白名单钱包丢失或泄露时的恢复**（管理钱包发起）：
1. 管理钱包 `startWhitelistRecovery(新地址)`，两条链各一次。**恢复进行期间白名单自动禁止写入**；待接收的普通交接作废；A 类时间锁操作暂停执行。
2. 等满 7 天；期间**现任白名单钱包可以取消**，管理钱包也可以取消。被取消后，发起方 3 天内不得再次启动。同一时刻只允许一个恢复。
3. 新地址 `acceptWhitelistRecovery()` 接收；**恢复完成或被取消后，白名单自动恢复可写**（不需要再走 48h 解冻）。决定 10 的手动冻结仍然走时间锁解除。

### 4.6 管理钱包交接与恢复

**正常交接**（负责人发起）：
1. （建议）新持有人在交接页证明地址。
2. 管理钱包向时间锁提议 `transferAdmin(新地址)`，两条链各一次；等满 48h，管理钱包或白名单钱包可取消。
3. 执行后新地址成为 `pendingAdmin`（7 天有效）；新持有人调用 `acceptAdmin()`，提议权一起迁移，桥合约上的管理钱包直接权限自动转移。多签作为新地址时，由多签成员完成调用。

**管理钱包丢失或泄露时的恢复**（白名单钱包发起）：
1. 白名单钱包 `startAdminRecovery(新地址)`，两条链各一次。**恢复进行期间白名单自动禁止写入**；`pendingAdmin` 作废；A 类时间锁操作暂停执行。
2. 等满 14 天；期间**现任管理钱包可以取消**，白名单钱包也可以取消。被取消后，发起方 3 天内不得再次启动。
3. 新地址 `acceptAdmin()` 接收；`epoch += 1`，旧提议作废。

> **钥匙真丢失**：无人取消，恢复照常完成。**钥匙被盗、真主仍握有副本**：真主取消攻击者发起的恢复即可；但攻击者作为现任持有人也可以取消真主发起的恢复，可能僵持（决定 15，§11）。**这两种恢复的启动都会触发电话告警，负责人必须及时响应。**

---

## 5. 桥合约

基于 OpenZeppelin Contracts Upgradeable v5：`AccessControl` + `Pausable` + `ReentrancyGuard` + `UUPS` + `EIP712` + `SafeERC20`；存储用 ERC-7201 命名空间。`evm_version` 按 PR-0 确认的 WANTOS EVM 版本设置（`cancun`）；编译器 solc 0.8.28，optimizer **runs = 1**（为字节码上限留余量，CI 要求每个核心合约余量 ≥ 1,500 B）。合约不做 ERC-1271 验证（链上唯一的签名者白名单钱包是 EOA）。

### 5.1 部署与初始化

**确定性部署（CREATE + 全新部署者 EOA）**：两条链用同一个全新 EOA，按下表 nonce 顺序部署，各合约在两条链上地址完全相同：

| nonce | 合约 |
|---|---|
| n | `BridgeTimelock(proposer = 管理钱包, bridge = n+2 的地址)` |
| n+1 | 桥实现合约（构造函数 `_disableInitializers()`） |
| n+2 | `ERC1967Proxy(实现, initData)`，**部署和初始化同一笔交易**；`initData` 含时间锁（n 的地址）、对端链 ID、对端桥地址（= 自身地址） |

- 部署者密钥在**干净设备上离线生成**，不经过任何旧工具；部署前核对两链部署者 nonce 为 0、预测地址无代码；每笔交易先模拟再广播，使用 EIP-155 签名。
- **失败规程**：任何一笔失败（失败也会耗掉 nonce）→ 两条链一起作废，换新的部署者 EOA 从头来；作废的合约公告为非桥地址。
- 部署者 EOA 部署完成后不保留任何角色，私钥销毁。
- 部署后运行**验收脚本**：逐项检查角色、时间锁成员与延迟、实现合约 codehash、参数、白名单为空、地址一致，结果存档。

### 5.2 BscVaultV2（BSC）

- 直接持有 BSC-USDT（`0x55d398326f99059fF775485246999027B3197955`），不用 Stargate LP，不用 EOA 储备钱包。

**放款记录与状态**

```solidity
// eventKey = keccak256(abi.encode("WANTOS-BSC-BRIDGE-V2", srcChainId, srcBridge, srcEventNonce))
//   同一事件只有一个 key，金额和收款人不参与计算
struct Payout { address to; uint128 amount; uint64 queuedAt; uint8 status; } // None / Queued / Released / Voided
mapping(bytes32 => Payout) public payouts;
```

```
None ──release()────────▶ Released             （amount ≤ largeThreshold）
None ──queueRelease()───▶ Queued ──executeRelease()（≥ releaseDelay）──▶ Released
None/Queued ──voidSource() / cancelRelease()──▶ Voided   （永久不能放款；退款前提）
```

- `release`、`queueRelease` 要求状态 `None`，先写状态再转账；`to` 在白名单；`amount ≤ perAddrDailyCap`。
- **额度在 `release`/`queueRelease` 时扣除，按 UTC 自然日计数**；`Voided` 时退还当日已扣额度（跨日不退）。
- `executeRelease`：状态 `Queued`、满 `releaseDelay`、未暂停、`to` 仍在白名单。
- 合约无法验证源链事件真实存在；付款钥匙被攻破时只能付给白名单地址并受额度约束，监控逐笔核对并暂停（§9）。

**入账（BSC → WANTOS）**：`deposit(amount, wantosRecipient)`，`minDeposit ≤ amount ≤ maxDepositPerTx`，`wantosRecipient ≠ 0`，按余额差额记账，发 `Deposited(nonce, from, wantosRecipient, amount)`。

**入账退款（极少用）**：WANTOS 侧先对该 `eventKey` 作废 → 管理钱包 `requestDepositRefund(nonce)`（合约按 `nonce` 自己推导 `eventKey`）→ 等 24h（期间管理钱包或白名单钱包可取消）→ 任何人 `executeDepositRefund(nonce)`，只退给原存款地址、原金额，**计入 BSC 的 `dailyCap`**。

### 5.3 WantosBridgeV2（WANTOS）

**跨出** `bridgeOut(amount)`，链上检查：`whitelisted[msg.sender]`；`msg.sender.code.length == 0`（不支持合约钱包和 EIP-7702 委托地址）；`w2bMinAmount ≤ amount`；该地址当日额度（`w2bPerAddrDailyCap`，同时也是单笔上限）；`totalSupply ≤ supplyCeiling`；按余额差额记账。收款地址固定为 `msg.sender`。

```solidity
struct Order { address user; uint128 amount; uint64 createdAt; uint8 status; uint64 refundRequestedAt; }
// status: None=0（不存在）/ Locked=1 / Refunding=2 / Refunded=3
mapping(uint256 => Order) public orders;   // orderId = 合约递增 nonce，从 1 开始
event BridgeOut(uint256 indexed orderId, address indexed user, uint256 amount);
```

**退款**（只用于被拒绝的订单）：
1. BSC 上 `voidSource` / `cancelRelease`，等 BSC `finalized`。
2. 管理钱包 `requestRefund(orderId)`（**没有 `bscEventKey` 参数**，合约和监控都由 `orderId` 推导 `eventKey`）→ 状态 Refunding；批量版 `requestRefundBatch`。
3. 等 24h；期间管理钱包或白名单钱包可取消，取消后回到 Locked。
4. 到期后任何人 `executeRefund(orderId)`（暂停时不可用）：只退给 `orders[orderId].user`、原金额，**计入 WANTOS 的 `b2wDailyCap`**，给双花封顶。

**跨链信任假设（写明）**：WANTOS 合约无法读取 BSC 状态，"BSC 已作废"由三道防线保证：①管理钱包发起、白名单钱包可在 24h 内取消；②监控在 `RefundRequested` 出现后、可执行时间前 2 小时核对 BSC 上该 `eventKey` 是否已 finalized 为 `Voided`，不符则暂停；③付款程序在每次 BSC 放款前重读 WANTOS 上 `orders[id].status == Locked`。

**B2W 入账**：WANTOS 付款钥匙 `queueRelease(srcEventNonce, to, amount)` → 满 `b2wDelay`（15 分钟）→ `executeRelease`；记录结构与 BSC 相同（Queued / Released / Voided）；不查白名单（用户存的是真钱）；`eventKey` 的 `srcChainId` 取对端链 ID（`peerChainId`）。排队期内监控核对 BSC 上是否有对应的、**编号、收款人、金额三项一致**的已 finalized `Deposited`，找不到则暂停 WANTOS 侧，由负责人取消该笔。B2W 超过当日额度时直接走入账退款。

### 5.4 状态取值

BSC 放款：`None / Queued / Released / Voided`（撤销排队 = 作废）。WANTOS 订单：`None / Locked / Refunding / Refunded` = 0/1/2/3（`None` 表示订单不存在）。orderId 与 BSC 存款 nonce 都从 1 开始。B2W 记录同 BSC 放款。BSC 存款退款：`None / Refunding / Refunded`。

### 5.5 参数（两条链各一套；额度均按 UTC 自然日）

| 链 | 参数 | 初值建议 | 范围 |
|---|---|---|---|
| BSC | `dailyCap`（全局） | 5,000 | 1,000 ～ 50 万 |
| BSC | `perAddrDailyCap`（也是单笔上限） | 2,000 | 100 ～ 2 万 |
| BSC | `largeThreshold`（超过走排队） | 1,000 | ≤ `perAddrDailyCap` |
| BSC | `releaseDelay` | 12h | 6h ～ 7 天 |
| BSC | `minDeposit` / `maxDepositPerTx` | 10 / 2,000 | ≤ 2 万 |
| WANTOS | `w2bMinAmount` / `w2bPerAddrDailyCap`（也是单笔上限） | 10 / 2,000 | 10 ～ 2 万 |
| WANTOS | `b2wDailyCap` | 3,000 | 500 ～ 20 万 |
| WANTOS | `b2wDelay` | 15 分钟 | 10 分钟 ～ 24h |
| WANTOS | `supplyCeiling` | 部署时 `totalSupply` + 1 万 | 降低不得低于当前 `totalSupply` |

- **常量**：退款等待 24h；`mintAlertThreshold` 仅用于告警分级（1 万）。
- **参数间约束（合约强制）**：BSC `largeThreshold ≤ perAddrDailyCap ≤ dailyCap`；WANTOS `w2bMinAmount ≤ w2bPerAddrDailyCap`。
- **`setParams(struct)`**：收紧走管理钱包立即执行（一笔交易，任何一项放宽整笔回滚）；放宽走时间锁。
- **跨链一致性（由监控检查并告警）**：BSC `perAddrDailyCap ≥` WANTOS `w2bPerAddrDailyCap`；BSC `maxDepositPerTx ≤` WANTOS `b2wDailyCap`。**收紧顺序**：先收紧 WANTOS，再收紧 BSC；放宽反过来。
- **储备口径**："1 天用量" = `dailyCap`（初值 5,000）；首批 BSC 储备 ≥ 3 天用量（≥ 1.5 万），**另加**旧单补付总额（§10）。补水后提额是例行操作（时间锁提议，48h）。

### 5.6 不变量（PR-1 每条都要有测试）

1. 白名单为空时，任何地址都无法 `bridgeOut`，BSC 也无法向任何地址放款。
2. 同一个 `eventKey`，只能发生"放款一次"或"作废一次"中的一个；`Voided` 之后不能放款。
3. 每个 UTC 自然日内，BSC 侧总放款（含已排队、含入账退款）≤ `dailyCap`，任一地址 ≤ `perAddrDailyCap`；WANTOS 侧 B2W 入账（含退款执行）≤ `b2wDailyCap`。（跨零点最坏情况是单日上限的 2 倍，文档照实写明。）
4. 升级、提取、放宽参数、授予钥匙、更换管理钱包只能经时间锁；不满 48h 不能执行；过期 14 天作废；**暂停期间不能执行提取和放宽参数；恢复期间不能执行任何 A 类操作**；交接或恢复后，旧地址的 cancel 被拒绝。
5. 四类钥匙两两不同；提议人恰好一个；白名单钱包只能经交接或恢复更换；`DEFAULT_ADMIN_ROLE` 只能是时间锁。
6. 升级后白名单、订单、额度、储备数据不变；存储布局检查通过。
7. 暂停时放款、排队、执行、跨出、存入、退款执行全部不可用；取消、作废、吊销、冻结、移除、升级、换钥匙仍可用。
8. 白名单批次只接受当前白名单钱包签名；nonce 不能重放；不能跨链；超过 24h 无效；冻结或恢复进行期间不能添加；地址严格递增。
9. 交接 / 恢复：等待期、指定地址、过期、零地址、钥匙重复、否决、对称取消、一次只允许一个恢复，全部生效；恢复完成或取消后白名单自动恢复可写。
10. `totalSupply > supplyCeiling` 时 `bridgeOut` 被拒绝；`supplyCeiling` 不能降到 `totalSupply` 以下。
11. 退款只能退给原地址、原金额，且 `eventKey` 由 `orderId` 推导。
12. 收紧不能突破下限；`setParams` 里夹带放宽会整笔回滚；参数间约束始终成立。
13. 崩溃后重放 `queueRelease`，合约返回已 `Queued`，不重复扣额度。
14. 旧单补付：同一个 `oldKey` 只能付一次。

跨链不变量"同一订单 BSC 放款与 WANTOS 退款最多一个"放在 PR-9 端到端测试中验证。

---

## 6. 付款程序 Relayer v2（服务器 A）

### 6.1 运行与密钥

- 服务器 A 由负责人指定；旧 relayer 的服务器和代码一律不复用。
- 两条链各一把付款钥匙，放在云 KMS（KMS 只防钥匙被拷走；**真正的防线是链上白名单和额度**）。云账户或 KMS 丢失时，只能经 48h 时间锁补发钥匙，桥只停不丢钱（写进应急手册）。
- 提交服务的热钥匙：只发交易，没有任何合约权限，gas 只放 3 天用量。
- 订单审核（通过 / 拒绝）由负责人用**管理钱包**签名，**由付款程序验签**（不在 Cloudflare Worker 里验证，Worker 视为不可信）。

### 6.2 数据来源

- **WANTOS**：自建非验证全节点为主，另用 rpc / rpc2 / rpc3 中至少一个交叉核对；每笔订单的 receipt 两个来源一致才处理。**为防链回滚，WANTOS 事件再等 6 个块确认才处理**。
- **BSC**：至少两个独立 RPC；**只处理 `finalized` 区块**，取不到时等待并告警；BSC 放款也要等 `finalized` 才记为 RELEASED。
- **WANTOS 回滚防护**：`chain_cursor` 记录已处理区块的 hash，付款程序和监控发现 hash 变了就自动暂停；**任何 WANTOS 链维护（升级、rollback、换二进制）之前先暂停桥**，写进运维手册。
- 只处理 `log.address == 本链桥合约` 的事件。

### 6.3 订单状态机（按方向）

**W2B（WANTOS → BSC）**

| 状态 | 说明 / 出口 |
|---|---|
| DETECTED | 看到 `BridgeOut`；链上检查（暂停、两链白名单、额度、储备、源订单仍为 Locked 且金额地址一致）→ 下列之一 |
| WAITING（`reason`：白名单、额度、储备、暂停；金额超限不停在此，直接转 REVIEW） | 条件满足后继续；节点 / RPC 不可用或落后 > 10 分钟、白名单不一致 > 30 分钟、储备不足立即告警；暂停中解除后继续（上链前先读 `paused()`） |
| REVIEW（`level`：审核 / 冻结） | **来源只有付款程序自己的安全检查，不来自风控规则**：金额超限（`amount_limit`）；放款前重读源订单不再 Locked 或金额 / 地址不一致（`onchain_mismatch`，冻结级）；订单创建后地址被移出白名单（`whitelist_removed`，PR-3 偏差 D2：由负责人签名拒绝后才 REJECTED）。负责人通过 → 继续（仍走排队）；拒绝 → REJECTED；审核 > 72h、冻结 > 7 天告警。保留审核签名（一次性、限定 level + reason）与广播前复核 |
| SUBMITTED | finalized → RELEASED 或 QUEUED；回滚 → 按原因分类 |
| QUEUED | 到期执行 → SUBMITTED；被撤销 / 地址被移出白名单 → REJECTED |
| REJECTED | BSC 上作废 finalized → REFUNDING |
| REFUNDING | 负责人发起退款 → 等 24h → REFUNDED；退款被取消 → 回到 REFUNDING 待重新申请 |
| RELEASED / REFUNDED | 终态 |
| FAILED | 只能人工处理：重试或 REJECTED |

**B2W（BSC → WANTOS）**：DETECTED → WAITING（储备、额度、暂停；**没有白名单原因**）→ QUEUED（15 分钟）→ RELEASED。被拒绝（极少）→ WANTOS 上作废 → BSC 存款退款 → REFUNDED。

**回滚原因分类**：读 `payouts[eventKey].status`：Released → RELEASED；Queued → QUEUED；Voided → REJECTED；额度不足 / 余额不足 / 合约暂停 / 不在白名单 → WAITING（对应 reason）；金额超过当前上限 → REVIEW；其他 → FAILED。

### 6.4 可靠性

- `tx_attempts`：签名后、广播前先落库；加价替换的多个哈希全部记录。
- `chain_cursor`：区块游标（含 hash）；启动时对齐 nonce，已签名未广播的交易原样重播，从游标回扫 100 块。
- 单进程串行发送；卡住时同 nonce 加价替换。**PR-0 实测 WANTOS 是否支持同 nonce 替换，不通过就不能上线**；另加"nonce 卡住"告警和手动处理流程。
- BSC 放款前重读 WANTOS 上 `orders[id].status == Locked`。
- 到期的时间锁提议由提交服务自动执行（未被取消的），到期前 24h 和 6h 各提醒负责人一次。

### 6.5 数据库（PostgreSQL）

```sql
create table orders (
  event_key bytea primary key, direction text not null,            -- W2B | B2W
  src_chain int not null, src_event_nonce numeric not null, src_tx_hash bytea not null,
  user_addr bytea not null, to_addr bytea not null, amount_wei numeric(78,0) not null,
  status text not null, reason text, reasons jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table tx_attempts (id bigserial primary key, event_key bytea, chain_id int, nonce bigint,
  tx_hash bytea, gas_price numeric, raw_tx bytea, state text, created_at timestamptz default now());
create table chain_cursor (chain_id int primary key, last_processed_block bigint, last_block_hash bytea);
create table audit_log (id bigserial primary key, actor text, action text, payload jsonb, at timestamptz default now());
```

白名单以链上为准。付款程序自己发心跳和告警给负责人。

---

## 7. 风控：白名单 + 额度 + 暂停

**风控只靠白名单**，不叠加其他规则（简洁、安全、壮硕）：

- 非白名单地址交易再多也出不了金；白名单地址基本是提前报备、公司实名登记的。
- 兜底是链上的全局 / 每地址日额度（§5.5）和随时可用的暂停（§9）。
- **不做资金来源判断**（v0.9.5 起删除原「资金来源检查」：受控来源集合、追溯与占比阈值、行为规则）。付款程序里仍保留的 REVIEW 属于 PR-3 的安全机制（源订单链上一致性、金额超限），见 §6.3，不是风控规则。
- 局限：白名单用户把自己的额度用于代他人跨链，只能由每地址额度限制损失，由负责人在录入白名单时把关。

---

## 8. 站点

两个独立的 **Cloudflare Workers 静态资源**站点（Workers Static Assets，不是 Pages 项目），全部在 Qbit 账户。`bridge.wanto.pro` 与 `admin.wanto.pro` 已绑定到对应 Worker 并显示占位页；`workers.dev` 访问已关闭。

### 8.1 用户跨链页 `bridge.wanto.pro`

- 功能：连接钱包、开通状态、两个方向跨链、订单状态、今日剩余额度。不含任何管理功能。
- 钱包：TP / MetaMask / OKX 的 DApp 浏览器；电脑用插件或 WalletConnect v2。缺 WANTOS 网络时一键添加（chainId 13555，RPC `https://rpc.wantos.io`，浏览器 `https://scan.wantos.io`）。
- 未开通："跨链未开通，请联系客服"；待人工审核的订单统一显示"处理中"。
- 交易目标只能是两个桥合约和 USDT；授权用精确金额；页脚固定显示两条链的桥合约地址。
- 技术栈：Vite + React + viem + wagmi。

### 8.2 管理后台 `admin.wanto.pro`（暂定名）

| 页面 | 功能 | 操作者 |
|---|---|---|
| 白名单管理 | 上传（CSV / TXT / 粘贴）→ 校验、去重、排序 → 逐行参考信息（网体、上级、风险标记、是否合约地址、历史跨出、余额）→ 选择**添加或移除** → 显示 `listHash` 与 `count` → 白名单钱包签名 → 交给提交服务按顺序提交两条链；当前白名单、批次记录、两链不一致补齐；作废已签批次 | 白名单钱包 |
| 紧急 | 冻结白名单写入、移除地址、否决交接、暂停 / 解除暂停、吊销付款钥匙 / 暂停钥匙 | 管理钱包（暂停和解除暂停也可用白名单钱包） |
| 时间锁面板 | 两条链所有待执行提议：内容解码、倒计时、取消、执行 | 管理钱包、白名单钱包 |
| 参数 | 收紧（一笔）；放宽（生成时间锁提议） | 管理钱包 |
| 交接与恢复（`/handover`） | 发起 / 取消 / 否决；启动或取消恢复；新持有人证明地址 → 等待倒计时 → 接收（两条链各一次）；显示两条链合约地址供核对；"只完成一条链"时引导补签 | 两个钱包 / 被指定的新地址 |
| 订单审核与退款 | REVIEW 订单：审核原因（金额超限 / 链上不一致 / 地址被移出白名单）；通过或拒绝（管理钱包签名，付款程序验签）；批量作废、批量退款申请 | 负责人 |
| 储备与对账 | 两条链余额、额度使用、对账结果、告警记录、每日白名单变更报告 | 只读 |

风险标记只是录入白名单时的提示，不参与风控：🟡 不在网体内；⚪ 合约地址。

管理后台读取付款程序数据的接口：经 Cloudflare Worker 转发，请求需带负责人钱包签名的短期会话（SIWE）。

### 8.3 离线核对工具

单文件开源工具，在**另一台设备**离线运行：读原始地址文件 → 校验、排序 → 输出 `listHash`、`count`，以及 EIP-712 **domain hash 和 message hash**（无论硬件钱包显示什么，都可比对）。同一工具也可解码时间锁提议。

### 8.4 Cloudflare 与供应链

Qbit 账户启用硬件安全密钥两步验证；`admin.wanto.pro` 加 Cloudflare Access（防窥视，不是安全边界），**`/handover` 路径放开**（新持有人可能在钱包 DApp 浏览器里打开，页面只读链上数据）；强制 HTTPS、HSTS、严格 CSP；Workers 部署令牌最小权限（只限这两个 Worker）；依赖锁定；发布产物哈希在两个独立渠道公布。

---

## 9. 独立监控 Watcher（服务器 B）

- 与付款程序**不同服务器、不同钥匙、不读付款程序的数据库**；用至少两个 RPC 订阅两条链事件，逐事件实时核对，断线后按游标补扫。
- 持有暂停钥匙（**只能暂停，没有取消权**）。
- **告警只发负责人**，分三级（见 §9.3）。**监控自身存活**：每 5 分钟向外部心跳服务报到，超时由外部服务直接打电话或发短信给负责人。

### 9.1 实时核对（防误暂停的三个条件）

判定"不符"之前必须同时满足：①监控自己的源链区块高度已经越过目标交易；②至少两个 RPC 结果一致；③已过宽限期（W2B 5 分钟；B2W 到 eta 前 3 分钟；退款到可执行时间前 2 小时）。**暂停只停受影响的那条链**。负责人解除暂停后，监控把链上的 `Unpaused` 事件当作"之前的全部事件已确认"，**只对解除之后的新事件再暂停**，旧事件只告警，不循环暂停。

| 核对 | 不符时 |
|---|---|
| BSC 每笔 `Released` / `ReleaseQueued` 都对应 WANTOS 上一个 `BridgeOut`（同 orderId、同地址、同金额），或属于旧单补付批次 | 暂停 BSC |
| WANTOS 每笔 B2W `ReleaseQueued` 都对应 BSC 上一个已 finalized 的 `Deposited`（**编号、收款人、金额三项一致**） | 暂停 WANTOS；负责人先取消可疑项 |
| WANTOS 每笔 `RefundRequested` 对应的 BSC `eventKey`（由 `orderId` 推导）已 finalized 为 `Voided` | 暂停 WANTOS |
| BSC 每笔 `DepositRefundRequested` 对应的 WANTOS `eventKey` 已是 `Voided` | 暂停 BSC |
| WANTOS 区块 hash 变化（链回滚） | 暂停两条链 |
| WANTOS-USDT 出现增发 | **只告警**（按 Mint 事件毛额累计，不看净供应）；不暂停，由 `supplyCeiling` 兜底 |

**处置顺序**：先吊销被怀疑的付款钥匙 → 取消可疑的排队项 → 再解除暂停。

### 9.2 余额对账（每小时，不等式加容差）

```
WANTOS 桥余额 ≥ ΣFunded + ΣBridgeOut − Σrelease(B2W) − ΣexecuteRefund − Σwithdraw − 容差
BSC 金库余额  ≥ ΣFunded + ΣDeposited − ΣReleased − ΣexecuteDepositRefund − Σwithdraw − ΣLegacyPaid − 容差
```

多出的部分列为"未登记入账"，不触发暂停；少了就告警。

### 9.3 告警三级

| 级别 | 方式 | 事件 |
|---|---|---|
| **一级（电话 + 短信，24h 后重复）** | 立即 | 自动暂停；新的时间锁提议；任何角色或交接 / 恢复变化（**含启动恢复**）；储备不足 0.5 天；监控或付款程序失联；WANTOS 回滚 |
| **二级** | 即时消息 | 暂停 / 解除暂停；吊销暂停钥匙；合约升级已执行；增发；跨链参数不一致；储备不足 1 天；WANTOS 桥余额偏低；节点落后、WANTOS 出块停滞、BSC 取不到 finalized；对账失败；两个钱包或暂停钥匙 gas 不足；旧金库 `0x8dFd` 或旧付款程序 `0x9dab` 有动作 |
| **三级** | 日报 | 每批白名单变更（地址数、`listHash`、交易哈希）；管理钱包紧急移除；当日放款达 `dailyCap` 的 70%；排队放款、退款申请、作废来源汇总 |

付款程序自身的告警（等待超时、nonce 不一致、KMS 失败、gas 不足、心跳中断）由付款程序直接发给负责人，短信为第二通道。

---

## 10. 旧桥处置与迁移

**Phase 0（现在就做，不依赖新桥）**
1. 旧 BSC 金库 `0xec6e`、旧储备钱包、补水钱包 `0xe1e8` **不再注入任何资金**。
2. 公告旧桥停用、旧网址作废。旧前端在原技术人员手里，公司下线不了；同时向 Cloudflare 举报滥用，并向主流钱包的钓鱼黑名单提交旧网址。
3. 旧 WANTOS 金库 `0x8dFd` 没有暂停：有 owner `0x7afc` 私钥就暂停；没有的话明确记为"旧金库无法暂停"，靠公告和监控。
4. 确定**切换时刻 T** 并公告：T 之前未放款的旧订单列入补付清单；**T 之后存进 `0x8dFd` 的资金，只在 T+14 天内受理**，由负责人人工核对后列入补付清单，只补付给存款人本人。
5. 尽量查清 `0x9dab` 旧付款程序的位置并停掉；**T 之前确认旧 BSC 金库余额为 0**。

**旧订单补付（简化为时间锁批量支付）**
- 补付清单（旧交易哈希、logIndex、地址、金额）由负责人整理并**公开发布**。
- 经时间锁调用 `payLegacyBatch(oldKeys[], to[], amounts[])`（每批 ≤ 100 条）：calldata 在 48h 内公开，白名单钱包据此对照已发布清单核对，**提议时收不到清单就取消**；执行时合约记录 `paid[oldKey] = true`（`oldKey = keccak256(abi.encode(bytes32 txHash, uint256 logIndex))`，**PR-8 暂定**，见 PR1-NOTES Q2，最终编码由 PR-8 定稿并随补付清单公布），同一旧单只能付一次；收款地址不要求在白名单（风险与 `withdraw` 相同，同样受时间锁和取消保护）。
- 每批放款前再查一次旧 BSC 金库 `0xec6e` 的放款记录，确认旧桥没有付过。
- 补付金额不占用日额度，首批储备要另外备足。

**第一批白名单**：合约部署时为空。我提供参考名单（Magellan 网体 3,927 个地址，附风险标记），由负责人筛选后在管理后台上传、签名写入。每批 500 个，约 8 批 × 2 条链 = 16 次签名。

---

## 11. 应急手册

| 场景 | 攻击者能做什么 | 应对 | 结果 |
|---|---|---|---|
| **BSC 付款钥匙泄露** | 只能付给白名单地址；当日全局 ≤ `dailyCap`，单地址 ≤ `perAddrDailyCap`（跨零点最坏 2 倍） | 监控发现"找不到源链事件"→ 暂停 BSC；管理钱包吊销该钥匙 → 取消排队项 → 解除暂停；经时间锁授予新钥匙（48h） | 损失约 `dailyCap`（初值 5,000） |
| **WANTOS 付款钥匙泄露** | B2W 入账一律排队 15 分钟，当日 ≤ `b2wDailyCap` | 监控在排队期内发现找不到对应 BSC 存款 → 暂停 WANTOS；吊销钥匙 → 取消可疑项 → 解除暂停 | 正常情况下零损失 |
| **暂停钥匙泄露** | 只能暂停 | 任一钱包解除暂停；吊销；经时间锁授予新的 | 无资金损失 |
| **管理钱包丢失** | — | 白名单钱包发起恢复（14 天，无人取消） | 14 天后恢复；期间白名单禁止写入，放宽类操作暂停执行；暂停可由白名单钱包解除 |
| **白名单钱包丢失** | — | 管理钱包发起恢复（7 天，无人取消） | 7 天后恢复；期间白名单禁止写入 |
| **管理钱包被盗** | 收紧类操作（只会更严）；提议放宽 / 升级 / 提取要等 48h；发起白名单钱包恢复 | 白名单钱包逐条取消恶意提议和恢复；**负责人必须在 7 天内响应恢复告警** | **资金不会被拿走**；可能僵持：储备和 Locked 订单暂时无法动用。被盗者还可以移除白名单，使在途订单进入退款流程而他拒绝配合，订单会一直冻结（不丢失） |
| **白名单钱包被盗** | 往白名单加地址（仍受额度约束）；取消正常提议；暂停 / 解除暂停；发起交接给自己 | 管理钱包立即冻结白名单、移除可疑地址、否决交接；启动白名单钱包恢复（7 天），攻击者作为现任持有人可以取消它 | **资金不会被拿走**；可能僵持：白名单冻结（只能移除），Locked 订单同样僵持 |
| **两个钱包同时被盗** | 全部权力 | 无法阻止 | **损失上限是整个储备**；两个钱包必须分设备、分地点保管，助记词分开备份 |
| **管理后台被篡改** | 诱导签错的批次或交易 | 离线核对 `listHash` 与 message hash；每批变更实时推送 | 不签就没有损失 |
| **付款程序服务器被攻破** | 等同付款钥匙泄露，并能改自己的数据库 | 监控在另一台服务器、读链上事件，不受影响 | 同第一行 |
| **有人增发 WANTOS-USDT** | 接收地址不在白名单，无法直接跨出；超过 `supplyCeiling` 后新的跨出被合约拒绝 | 只告警；若增发超过上限导致跨出停摆，负责人经时间锁提高上限（48h）；PR-0 争取让该 owner 放弃增发权 | 小额增发不影响业务；大额增发会让跨出暂停至负责人处理 |
| **云账户 / KMS 丢失** | — | 经时间锁补发付款钥匙（48h） | 桥只停不丢钱 |

**合约实现带来的三条处置注意事项（v0.9.4 补充）**

1. **紧急移除前先冻结**：`emergencyRemove` 不推进白名单批次 nonce，已签名未提交的「添加」批次之后仍能把地址加回来。紧急处置顺序必须是**先 `freezeWhitelist`，再移除**（冻结后添加批次一律被拒）。
2. **被盗的白名单钱包能作废未来的 orderId**：`voidSource` 可作用于还没出现的 orderId，这些订单在 BSC 上永久无法放款，只能在 WANTOS 走退款；资金不丢，但要人工处理退款。
3. **重复暂停会回滚**：对已暂停的桥再次 `pause()` 会以 `EnforcedPause` 回滚，监控（PR-7）必须把它当作"已处于暂停"的成功结果处理，不能当成暂停失败而反复重试或告警升级。

**无链上"最后手段"（决定 15）**：钥匙被盗且双方互相取消时，只能靠链下处理（沟通、部署新桥另行安排用户资金）。预防靠钥匙保管：两个钱包助记词分开、离线、异地备份，每季度演练一次恢复。

---

## 12. 日常操作的签名次数

| 操作 | 签名 |
|---|---|
| 一批白名单（≤ 500 个） | 白名单钱包 2 次（两条链）+ 离线核对 1 次（**现状**：PR-3 提交服务接口未实现前，页面由白名单钱包直接提交，每批每链「签名 + 发交易」两次确认，见 PR-6 偏差 D1；接口就绪后回到一批 = 两次签名） |
| 移除一批有在途订单的地址 | 批量作废 1 次（BSC）+ 批量退款申请 1 次（WANTOS）；24h 后任何人执行 |
| 补水后提额 | 管理钱包每条链提议 1 次；48h 后由提交服务自动执行 |
| 误暂停后恢复 | 一个钱包 `unpause`，每条链 1 次 |
| 订单审核 | 每单 1 次 |
| 审阅时间锁提议 | 确认"这是不是我提的"，不是就取消 |

---

## 13. 开发计划（PR 拆分）

| PR | 内容 | 依赖 | 验收 |
|---|---|---|---|
| PR-0 准备 | ①`0xc74F` owner 权限逐函数审计，争取其放弃增发权；②验证者信任假设；③钥匙仪式文档；④硬件钱包对 EIP-712 的显示能力；⑤WANTOS 支持的 EVM 版本；⑥WANTOS app mempool 同 nonce 替换行为（不通过则不能上线）；⑦WANTON 1345 与主网二进制、mempool 是否一致；⑧两条链用全新部署者 EOA 按 nonce 部署的 fork 演练，含失败规程 | — | 结论写进本文档 |
| PR-1 合约 | 两个桥合约、`BridgeTimelock`、地址预测与部署脚本、验收脚本 | PR-0 | §5.6 十四条不变量全部有测试；交接、恢复（对称取消、恢复期间禁写）、退款、额度、批次签名、紧急权力、参数约束、过期换 salt、暂停期间升级可执行的正反用例；覆盖率 ≥ 95%；`slither` 无高危 |
| PR-2 外部审计 | 合约冻结后送审，与 PR-3～PR-7 并行 | PR-1 | 高危、中危全部修复；修复后 PR-9 重跑 |
| PR-3 付款程序 | 自建节点、状态机、`tx_attempts`、游标（含 hash）、回滚分类、多 RPC、提交服务 | PR-1 接口 | 故障注入：断网、重启、签名后广播前崩溃、BSC 重组、WANTOS 回滚、重复事件、交易卡住、额度不足、余额不足、两链白名单不一致、暂停中提交、崩溃后重放 `queueRelease` |
| PR-4 风控 | **已取消**（用户决定：风控只靠白名单） | — | — |
| PR-5 用户页 | `bridge.wanto.pro` | PR-1 接口 | 未开通被拒；两个方向；订单状态 |
| PR-6 管理后台 + 离线工具 | `admin.wanto.pro`（含 `/handover`）、离线核对工具 | PR-1、PR-3 | 篡改页面后签名的批次被离线核对拦下；非白名单钱包无法写入；两链部分成功可补齐；紧急操作和批量作废可用 |
| PR-7 监控 | 服务器 B、实时核对（三条件防误暂停）、余额对账、三级告警、暂停、外部心跳 | PR-1 事件 | §9 每条核对和告警在测试网演练一次；解除暂停后不循环暂停 |
| PR-8 迁移与旧单 | 切换时刻 T、补付清单与公告、`payLegacyBatch` 演练 | PR-1 | 补付不重复（与旧桥放款记录核对） |
| PR-9 测试网联调 | WANTON 1345 + BSC 测试网全链路 | PR-3、PR-5～PR-8 | 端到端 100 笔；§11 每个场景演练；跨链不变量"放款与退款最多一个" |
| PR-10 主网上线 | 部署（白名单为空）→ 验收脚本 → 负责人导入第一批白名单 → 两侧注资 → 灰度 | PR-2、PR-9 | 72h 内 §9.1 实时核对零告警，§9.2 对账无短缺 |

各 PR 先落规划文档再实施；合并需负责人明确批准。

---

## 14. 待决事项

1. 公司现在实际掌握哪些旧私钥：`0x9272`、`0x9dab`、`0x7afc`、`0xf974`、`0xc081`、`0xcca4`、`0xe1e8`、4 个储备钱包。
2. PR-0 各项结论。
3. 付款程序服务器 A、监控服务器 B 放在哪里；电话 / 短信告警服务选型。
4. 额度初值（§5.5）。
5. WANTOS 侧启动资金金额。
6. 管理后台域名是否就用 `admin.wanto.pro`。

---

## 附录 B：参考材料

> 原「附录 A：受控来源集合」已于 v0.9.5 删除，附录编号保留。

- `Magellan网体推荐关系.csv`：3,927 个地址，已叠加 10-01 换根改挂（ReferralRegistry `0x082b…a544` + ParentOverride `0x2da8…eefb`）
- `孤立跨出账户_候选清单.csv`：252 个
- `10月MG卖出套现明细_含可疑标注.csv`：1,284 个
- `10月直接跨出超1000_孤立地址.csv`：3 个
- `WANTOS_USDT_散户持仓_ge1.csv`

---

## v0.9.4 同步说明（2026-11-02，PR-1 合约实现后同步）

只改与合约实现不一致的描述，**17 条已拍板的决定未改**：

1. §5.3 / §5.4：WANTOS 订单状态为 `None / Locked / Refunding / Refunded` = 0/1/2/3（加 `None` 以区分"不存在的订单"）；`Order` 为 5 个字段，增加 `refundRequestedAt`（24h 退款计时）。
2. §5.2 / §5.3：`orderId` 与 BSC 存款 `nonce` 都从 1 开始。
3. §4.3 E：`executeRelease`（两条链）只限付款钥匙调用。
4. §4.2 规格 1：`updateDelay` 新值上限 7 天（区间 48h ～ 7 天）。
5. §5：optimizer runs 由 200 改为 1，CI 要求核心合约字节码余量 ≥ 1,500 B。
6. §11：补充三条处置注意事项（先冻结再紧急移除；被盗白名单钱包可作废未来 orderId；重复 `pause()` 回滚 `EnforcedPause` 应视为成功）。
7. §4.2 规格 9：时间锁执行后自检桥的 `paused()` / 恢复标志 / 白名单钱包 / `timelock()` 视图，今后升级的新实现必须保留这些视图且语义不变，否则整笔执行回滚。

合约细节、偏差与待决以 `docs/PR1-NOTES.md` 为准。

---

## v0.9.5 同步说明（2026-11-02，负责人最新决定）

**17 条已拍板的决定未改，不新增机制。** 新决定：项目名 SaveBridge；风控只靠白名单；Workers 静态资源部署；oldKey 编码对齐 PR-8；白名单批次签名次数补现状。

删除：
1. §7 整节「资金来源检查」（受控来源集合、追溯与占比阈值、行为规则、降级、局限）；原位改为简短的「白名单 + 额度 + 暂停」说明（局限一条重写）。
2. 附录 A「受控来源集合」及其后「网体内需特别注意」段；附录 B 编号保留。
3. §6.5 数据库 `controlled_set` 表；§6.2「自建交易索引」条（唯一消费者是 PR-4）。
4. §8.2「受控集合」页；风险标记 🔴、🟠（依赖受控来源）；保留 🟡、⚪ 并注明不参与风控。
5. §9.3 二级告警「受控集合变更」「受控地址有资金动作」；§11「管理后台被篡改」行中「受控集合被清空」。
6. §13 PR-4 改为「已取消」；PR-6 依赖去掉 PR-4；PR-9 依赖改为 PR-3、PR-5～PR-8；PR-3 去掉「索引」。
7. §6.3：DETECTED「风控」改为链上检查；删 WAITING 原因「索引」（PR-3 未产生，改为节点 / RPC 告警）。

修改：
1. 标题与首段：SaveBridge；§0 第 2 条、§1.2、§1.3、§2 第 2 条、§3 架构图措辞，去掉对风控 / 附录 A 的引用。
2. §6.3 REVIEW 行如实描述保留的来源：金额超限、`onchain_mismatch`（冻结级）、`whitelist_removed`（PR-3 偏差 D2）；审核签名（一次性、限定 level + reason）、广播前复核、负责人手动审核通道保留；只删「资金来源风控产生 REVIEW」。§8.1、§8.2 订单审核行相应改字。
3. §8 开头、§8.4：Cloudflare Workers 静态资源（非 Pages），两域名已在 Qbit 绑定并显示占位页，workers.dev 关闭。
4. §10：切换时刻 T 之后转入 `0x8dFd` 的资金不再「通过来源检查」，改为负责人人工核对后列入补付清单（保守处理，待确认）；旧金库 T 后转出不再归入受控集合；`oldKey = keccak256(abi.encode(bytes32 txHash, uint256 logIndex))`（PR-8 暂定，PR1-NOTES Q2）。
5. §12：补一句现状（PR-6 偏差 D1：每批每链「签名 + 发交易」两次确认，PR-3 提交服务接口就绪后回到一批 = 两次签名）。

§14 待决事项中没有依赖受控集合的条目，未改。
