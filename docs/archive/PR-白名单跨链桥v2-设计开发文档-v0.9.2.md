# PR 规划：白名单跨链桥 v2（WANTOS ↔ BSC USDT）设计开发文档

> 版本 **v0.9.2（精简版）**（2026-11-02）｜状态：待确认，**未开工**（负责人指示：先不开工）
>
> v0.9.2 是**做减法**的一版：吸收 v0.9.1 复核意见的同时，按负责人"不要过度设计、过度封控，给运营带来压力"的要求，砍掉所有靠"多签几次名、多盯几处"才成立的控制。旧版本存档在 `docs/archive/`（v0.7～v0.9.1）。
>
> **负责人已拍板的决定（本版据此设计，不再讨论）：**
> 1. 严格白名单、默认拒绝；合约部署时白名单**为空**；只有负责人能添加和移除，在管理后台的同一个页面操作；网体关系只作参考。
> 2. 白名单**两条链都写**。
> 3. 合约**可升级**、管理员**可更换**，都要经过 48 小时时间锁。
> 4. 管理员现阶段由负责人一人担任（**管理钱包**），以后交接给团队多签。
> 5. 管理钱包和白名单钱包是**两个不同的钱包**。两者的交接都由负责人发起，负责人提供指定的新地址，新持有人通过交接链接签名接收。
> 6. **白名单钱包同时是"取消"钥匙**：可以取消任何待执行的升级、参数放宽、储备提取、管理员变更。不设第三个钱包。
> 7. 增加**只能暂停**的服务器钥匙（PAUSER）。
> 8. 用户跨链页 `bridge.wanto.pro`；管理后台独立站点（暂定 `admin.wanto.pro`）；交接页 `handover.wanto.pro`；均部署在负责人的 Cloudflare 账户（Qbit）。
> 9. WANTOS 侧启动资金由负责人直接转入 WANTOS 桥合约。
> 10. 白名单钱包泄露时，管理钱包可以紧急介入：否决白名单钱包交接、冻结白名单写入、移除地址（只能收紧）。
> 11. 每批白名单不需要管理钱包额外签名；每批变更实时推送给负责人，并生成每日变更报告，由负责人定期巡查。
> 12. 告警由负责人一人接收。
> 13. 两种恢复机制对称：任一恢复的目标钥匙（现任持有人）可以取消它；恢复一启动，白名单写入自动冻结。钥匙真丢失时无人取消，恢复照常完成。
> 14. WANTOS-USDT 被增发时只告警；累计增发超过 `mintAlertThreshold`（1 万）才自动暂停。
> 15. （v0.9.2）**接受"钥匙被盗且双方互相取消"时可能长期僵持，不设链上"最后手段"出口**（出口对攻击者同样有效）。钥匙分设备、分地点保管是主要防线。
> 16. （v0.9.2）**精简原则**：不为极端场景叠加额外的签名、限额、冷却、名单审批；运营日常操作尽量不超过"一批白名单 = 两次签名"。

---

## 0. 目标

1. 原技术人员手里可能残留的任何旧私钥，都**拿不走新桥里的钱**。
2. 他控制的 WANTOS 资产所在地址不在白名单里，**无法直接跨出**；转给白名单用户代跨，由资金来源检查拦截，并由每地址额度兜底。
3. **任何一把新钥匙单独泄露，资金都不会被直接拿走**，损失有链上上限，并且会被发现、可以止损。钥匙丢失可以按期恢复；钥匙被盗且真主仍握有副本时可能僵持（桥受限，资金不被拿走），见 §11。
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
| 付款钥匙能付给任意地址，额度只在链下 | 链上只付白名单地址；全局 + 每地址滚动额度写在合约里（§5） |
| 储备放在普通钱包 | 储备只存在合约里；提取只经时间锁 |
| 放款不检查来源 | 白名单 + 资金来源检查（§7） |
| 私钥硬编码在代码里 | 付款钥匙进 KMS；任何钥匙不进代码和配置（§6） |

### 1.3 需要防住的资产

`0xf974`（2,531 万 WANTOS-USDT）、MG 池 LP `0xcca4`、`0xeabd`（9,880 万 MG）、合约 `0x778b`/`0x7fd9`（96.5 万 MG）、合约 `0xb7f4`（14.8 万 USDT）、旧金库 `0x8dFd`（94.9 万）、`0xc081` 增发权，以及附录 A 的其他地址。这些地址不会被录入白名单；风险在于"转给白名单用户代跨"。

---

## 2. 设计原则

1. **钥匙全新，权力拆开**：放款、改白名单、提议升级、暂停分属不同钥匙，合约里强制互斥。
2. **放宽要等、收紧立即**：让资金更容易流出的操作一律经 48h 时间锁，白名单钱包可取消；让资金更难流出的操作立即生效。
3. **链上兜底、链下精细**：白名单、额度、延迟写在合约里；资金来源检查、行为规则在付款程序里。
4. **安全优先于可用，但不叠加运营负担**：最坏情况宁可桥暂停，也不能被提走；但不为极端场景增加日常操作成本。
5. **看得见**：关键操作都有链上事件，由独立监控实时推送给负责人。
6. **监控只能暂停，不能取消**：取消订单、作废来源只能由负责人的两个钱包执行。

---

## 3. 总体架构

```
 ┌──────────── WANTOS 链 ─────────────┐                  ┌────────────── BSC 链 ───────────────┐
 │ WantosBridgeV2 (UUPS)              │                  │ BscVaultV2 (UUPS，持有 USDT)         │
 │  bridgeOut(查白名单) / 订单存档    │                  │  release / queue / execute（只付白名单）│
 │  B2W 入账（短排队）/ 退款          │                  │  deposit / 入账退款                  │
 │ BridgeTimelock (48h) + CancelProxy │                  │ BridgeTimelock (48h) + CancelProxy   │
 └──────────────▲─────────────────────┘                  └───────────────▲──────────────────────┘
     付款程序 Relayer v2（服务器 A）：自建节点与索引 → 风控 → 放款 / 排队 / 审核
     独立监控 Watcher（服务器 B）：多 RPC 实时核对 → 告警（负责人）→ PAUSER 自动暂停
   bridge.wanto.pro（用户）      admin.wanto.pro（管理后台）      handover.wanto.pro（交接链接）
```

---

## 4. 钥匙、角色与权力

### 4.1 钥匙

| 钥匙 | 持有者 | 形态 | 能否是合约 |
|---|---|---|---|
| **管理钱包** | 负责人（交接后为团队多签） | 硬件钱包 | 可以（多签时按 ERC-1271 验证） |
| **白名单钱包（WL）** | 负责人 | 硬件钱包，与管理钱包不同 | 必须是普通地址 |
| **付款钥匙（RELAYER）** | 服务器 A，两条链各一把 | KMS | 必须是普通地址 |
| **暂停钥匙（PAUSER）** | 服务器 B，每条链一把 | 热钥匙，只能暂停 | 必须是普通地址 |

- 两个钱包都需要在两条链上备少量 gas（WANT、BNB）。
- 白名单批次是纯签名，由**任意账户**提交（管理后台的热账户出 gas），提交账户不拥有任何权限。
- 暂停钥匙被吊销后，管理钱包或白名单钱包仍可手动暂停；补发新暂停钥匙走 48h 时间锁。

### 4.2 合约结构

每条链部署：桥合约（UUPS 代理）、`BridgeTimelock`、`CancelProxy`，由一个一次性的部署者 EOA 创建。

**桥合约**：最高管理权 `DEFAULT_ADMIN_ROLE` 只授给本链时间锁；四类钥匙（管理钱包、白名单钱包、付款钥匙、暂停钥匙）两两不同，在授予和交接时检查；`grantRole/revokeRole/renounceRole` 不能用于白名单钱包。

**`BridgeTimelock`**（继承 OZ v5 `TimelockController`，不可升级）规格：

1. 延迟 48h，`MIN_DELAY = 48h` 为 immutable，`updateDelay` 不得低于它。
2. `admin = address(0)`。构造函数里一次性完成全部授权（提议人 = 管理钱包，取消人 = 管理钱包 + CancelProxy，执行人 = 任何人）；**构造期间跳过互斥检查**（那时桥合约尚未部署）。
3. **提议人恰好一个**：覆盖 `_grantRole/_revokeRole/renounceRole`，禁止直接增删；提议权和取消权（管理钱包那份）同时迁移。
4. 管理钱包只能通过 `transferAdmin`（经时间锁 → `pendingAdmin`，7 天有效 → 新地址在链上 `acceptAdmin()`）或恢复流程更换。
5. 提议到期后 14 天内必须执行，过期作废：OZ 的状态枚举无法新增 `Expired`，所以过期操作按"已失效"处理，另提供 `isOperationExpired(id)`；过期后换 salt 重新提议。
6. 每个提议记录所属 `epoch`；管理钱包恢复完成时 `epoch += 1`，旧提议作废。
7. 对外提供 `adminWallet()`；桥合约里所有"管理钱包直接可调"的函数都检查它，交接后自动跟随。

**`CancelProxy`**（不可升级）：持有时间锁的取消人角色；`cancel(id)` 只允许 `msg.sender == bridge.whitelistManager()`。白名单钱包交接或恢复后，时间锁角色**不用改**。构造参数含桥地址和时间锁地址（均为预计算地址）。

### 4.3 权力矩阵（两条链相同；仅单边的函数已注明）

**A. 放宽类：必须经 48h 时间锁**（管理钱包提议；管理钱包或白名单钱包可取消；**暂停期间和恢复期间不能执行**）

| 操作 | 约束 |
|---|---|
| 升级桥合约 `upgradeToAndCall` | 新实现须先开源验证；存储布局检查通过 |
| 提取储备 `withdraw(to, amount)` | 合约内没有其他提取路径 |
| 提高额度、缩短延迟（§5.5 的参数） | 在硬编码范围内，且参数间约束成立 |
| 提高 `supplyCeiling`（仅 WANTOS） | — |
| 授予新的付款钥匙 / 暂停钥匙 | 互斥检查 |
| 解除白名单写入冻结 | — |
| 追加旧单补付清单的 Merkle 根 `addLegacyRoot`（仅 BSC） | §10 |
| 更换管理钱包 `transferAdmin` | §4.6 |

**B. 收紧类：管理钱包立即执行**

| 操作 | 约束 |
|---|---|
| 降低额度、延长延迟、降低 `supplyCeiling` | 有下限；参数间约束必须成立（按顺序逐个调） |
| 吊销付款钥匙 / 暂停钥匙 | 立即生效 |
| 撤销排队放款 `cancelRelease`、作废 `voidSource` | 白名单钱包也可调用；暂停期间仍可用 |
| 否决白名单钱包交接、冻结白名单写入、移除白名单地址 | 决定 10；两条链各调用一次 |
| 启动白名单钱包恢复 | §4.5 |

**C. 暂停与解除**

| 操作 | 谁 |
|---|---|
| 暂停 `pause` | 暂停钥匙、管理钱包、白名单钱包；立即 |
| 解除暂停 `unpause` | **管理钱包**（一个人即可） |

暂停期间不可用：放款、排队、执行、跨出、存入、退款执行，以及 A 类时间锁操作的执行。暂停期间仍可用：取消、作废、撤销、吊销、冻结、移除白名单。

**D. 白名单钱包**

| 操作 | 约束 |
|---|---|
| 添加 / 移除白名单（EIP-712 签名批次） | §4.4 |
| 发起 / 取消白名单钱包交接 | §4.5 |
| 经 CancelProxy 取消任何时间锁提议；取消管理钱包发起的白名单钱包恢复 | — |
| 暂停；撤销排队放款；作废来源 | — |
| 发起管理钱包恢复（管理钱包丢失时） | §4.6 |

**E. 付款钥匙**

| 操作 | 约束 |
|---|---|
| `release` / `queueRelease` / `executeRelease`（BSC） | 只付白名单地址；扣额度 |
| `queueRelease` / `executeRelease`（WANTOS，B2W 入账） | 一律排队 `b2wDelay`；单独的 `b2wDailyCap` |
| `releaseLegacy`（BSC） | §10；一律排队 |

**F. 用户与任何人**

| 操作 | 约束 |
|---|---|
| `bridgeOut(amount)`（WANTOS） | §5.3 |
| `deposit(amount, wantosRecipient)`（BSC） | 不查白名单 |
| `fund(amount)`（两条链） | 补水，发 `Funded` 事件 |
| `executeRefund` / `executeDepositRefund` | 只能退给原地址、原金额；暂停时不可用 |

### 4.4 白名单写入：EIP-712 签名批次

```solidity
// domain: name="WantosBridgeV2" | "BscVaultV2", version="1", chainId, verifyingContract
struct WhitelistBatch {
    bytes32 listHash;   // keccak256(abi.encode(sortedAddrs))，地址严格递增
    uint32  count;      // 地址个数，便于在硬件钱包上核对
    bool    allowed;    // true=添加，false=移除
    uint256 nonce;      // 等于合约当前批次 nonce
    uint256 deadline;   // 签名后 2 小时内有效
}
function applyWhitelistBatch(address[] calldata sortedAddrs, bool allowed, uint256 nonce,
                             uint256 deadline, bytes calldata wlSignature) external;
//   合约重算 listHash 与 count；校验签名者 == 当前白名单钱包；地址严格递增；
//   单批 ≤ 500 个（PR-0 确认硬件钱包显示后定稿）；拒绝零地址与合约地址；冻结时拒绝添加
function invalidateWhitelistNonce() external;   // 作废已签未提交的批次
event WhitelistBatchApplied(bytes32 indexed listHash, bool allowed, uint256 nonce, uint256 count);
event WhitelistUpdated(address indexed addr, bool allowed, bytes32 indexed listHash);
```

- 负责人签名前，用**离线核对工具**（§8.3）对原始地址文件算出 `listHash` 和 `count`，与钱包显示一致才签。
- 每批在两条链上各签一次（签名含 chainId 和合约地址）。
- **写入顺序**：添加先 BSC 后 WANTOS；移除先 WANTOS 后 BSC。
- 每批变更实时推送给负责人，另有每日变更报告（含管理钱包的紧急移除），由负责人定期巡查。
- **地址被移除时的在途订单**：订单创建之后出现过移除事件、且当前仍不在白名单 → REJECTED（走退款）；只是另一条链还没写入 → WAIT_WHITELIST，30 分钟未一致告警。

### 4.5 白名单钱包交接与恢复

**正常交接**（负责人发起）：
1. （建议）新持有人在交接页做一次 `personal_sign`（合约钱包用 ERC-1271），提前发现地址填错。
2. 当前白名单钱包调用 `beginWhitelistManagerTransfer(新地址)`，两条链各一次。
3. 等满 48 小时；期间白名单钱包可取消，管理钱包也可否决。
4. 新持有人调用 `acceptWhitelistManagerTransfer()`，两条链各一次，旧地址立即失效；CancelProxy 自动认新地址。
5. 7 天未接收自动作废。

**白名单钱包丢失或泄露时的恢复**（管理钱包发起）：
1. 管理钱包 `startWhitelistRecovery(新地址)`，两条链各一次。**一启动：白名单写入自动冻结；待接收的普通交接作废；放宽类时间锁操作暂停执行。**
2. 等满 7 天；期间**现任白名单钱包可以取消**，管理钱包也可以取消。被取消后，发起方 3 天内不得再次启动。同一时刻只允许一个恢复在进行。
3. 新地址调用 `acceptWhitelistRecovery()` 接收。冻结保持，管理钱包经时间锁（48h）解除。

### 4.6 管理钱包交接与恢复

**正常交接**（负责人发起）：
1. （建议）新持有人在交接页证明地址。
2. 管理钱包向时间锁提议 `transferAdmin(新地址)`，两条链各一次；等满 48h，管理钱包或白名单钱包可取消。
3. 执行后新地址成为 `pendingAdmin`（7 天有效）；新持有人调用 `acceptAdmin()`，提议权与取消权一起迁移，桥合约上的管理钱包直接权限自动转移。
4. 交接给团队多签时，新地址就是多签地址，由多签成员完成 `acceptAdmin()`。

**管理钱包丢失或泄露时的恢复**（白名单钱包发起）：
1. 白名单钱包 `startAdminRecovery(新地址)`，两条链各一次。**一启动：白名单写入自动冻结；待接收的 `pendingAdmin` 作废；放宽类时间锁操作暂停执行。**
2. 等满 14 天；期间**现任管理钱包可以取消**，白名单钱包也可以取消。被取消后，发起方 3 天内不得再次启动。
3. 新地址 `acceptAdmin()` 接收；`epoch += 1`，旧管理钱包排队的提议作废。

> **钥匙真丢失**：无人取消，恢复照常完成。**钥匙被盗、真主仍握有副本**：真主取消攻击者发起的恢复即可；但攻击者作为现任持有人也可以取消真主发起的恢复，可能僵持（决定 15，§11）。

---

## 5. 桥合约

基于 OpenZeppelin Contracts Upgradeable v5：`AccessControl` + `Pausable` + `ReentrancyGuard` + `UUPS` + `EIP712` + `SafeERC20`；存储用 ERC-7201 命名空间。`evm_version` 按 PR-0 确认的 WANTOS EVM 版本设置。所有 EIP-712 签名验证支持 ERC-1271。

### 5.1 部署与初始化

**确定性部署（CREATE + 全新部署者 EOA）**：两条链用同一个全新 EOA，按下表 nonce 顺序部署，各合约在两条链上地址完全相同，互相依赖的地址部署前都能算出：

| nonce | 合约 |
|---|---|
| n | `CancelProxy(bridge = n+3 的地址, timelock = n+1 的地址)` |
| n+1 | `BridgeTimelock(proposer = 管理钱包, cancelProxy = n 的地址, bridge = n+3 的地址)` |
| n+2 | 桥实现合约（构造函数 `_disableInitializers()`） |
| n+3 | `ERC1967Proxy(实现, initData)`，**部署和初始化同一笔交易**，`initData` 含时间锁、对端链 ID、对端桥地址（= 自身地址） |

- 部署前运行地址预测脚本，并核对两链部署者 nonce 为 0、预测地址无代码；每笔交易先模拟再广播，使用 EIP-155 签名。
- **失败规程**：任何一笔失败（失败也会耗掉 nonce）→ 两条链一起作废，换新的部署者 EOA 从头来；作废的合约公告为非桥地址。
- 部署者 EOA 部署完成后不保留任何角色，私钥销毁。
- `initialize(timelock, wlWallet, relayer, pauser, usdt, peerChainId, peerBridge, params)`：白名单为空；钥匙互斥；`DEFAULT_ADMIN_ROLE` 只授给时间锁。
- 部署后运行**验收脚本**：逐项检查角色、时间锁成员与延迟、CancelProxy 绑定、参数、白名单为空、地址一致，结果存档。

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

- `release`、`queueRelease` 要求状态 `None`，先写状态再转账；`to` 在白名单；`amount ≤ maxPerTx`。
- **额度在 `release`/`queueRelease` 时扣除**；`Voided` 时退还到仍在窗口内的小时桶，已过期的不退。
- `executeRelease`：状态 `Queued`、满 `releaseDelay`、未暂停、`to` 仍在白名单。
- 合约无法验证源链事件真实存在；付款钥匙被攻破时只能付给白名单地址并受额度约束，监控逐笔核对并暂停（§9）。

**入账（BSC → WANTOS）**：`deposit(amount, wantosRecipient)`，`minDeposit ≤ amount ≤ maxDepositPerTx`，`wantosRecipient ≠ 0`，按余额差额记账，发 `Deposited(nonce, from, wantosRecipient, amount)`。

**入账退款（极少用）**：WANTOS 侧先对该 `eventKey` 作废 → 管理钱包 `requestDepositRefund(nonce)` → 等 `refundDelay`（期间管理钱包或白名单钱包可取消）→ 任何人 `executeDepositRefund(nonce)`，只退给原存款地址、原金额。

### 5.3 WantosBridgeV2（WANTOS）

**跨出** `bridgeOut(amount)`，链上检查：`whitelisted[msg.sender]`；`msg.sender.code.length == 0`（不支持合约钱包和 EIP-7702 委托地址）；`w2bMinAmount ≤ amount ≤ w2bMaxPerTx`；该地址滚动 24h 额度（`w2bPerAddrDailyCap`）；`totalSupply ≤ supplyCeiling`；按余额差额记账。收款地址固定为 `msg.sender`。

```solidity
struct Order { address user; uint128 amount; uint64 createdAt; uint8 status; } // Locked / Refunding / Refunded
mapping(uint256 => Order) public orders;   // orderId = 合约递增 nonce
event BridgeOut(uint256 indexed orderId, address indexed user, uint256 amount);
```

**退款**（只用于被拒绝的订单）：
1. BSC 上 `voidSource` 或 `cancelRelease`，等 BSC `finalized`。
2. 管理钱包 `requestRefund(orderId, bscEventKey)` → 状态 Refunding。
3. 等 `refundDelay`（24h）；期间管理钱包或白名单钱包可取消，取消后回到 Locked。
4. 到期后任何人 `executeRefund(orderId)`（暂停时不可用）：只退给 `orders[orderId].user`、原金额。

**跨链信任假设（写明）**：WANTOS 合约无法读取 BSC 状态，"BSC 已作废"由三道防线保证：①管理钱包发起、白名单钱包可在 24h 内取消；②监控在 `RefundRequested` 出现时自动核对 BSC 上该 `eventKey` 是否已 finalized 为 `Voided`，不是就**自动暂停**（同时挡住退款执行）；③付款程序在每次 BSC 放款前重读 WANTOS 上 `orders[id].status == Locked`。

**B2W 入账**：WANTOS 付款钥匙 `queueRelease(srcEventNonce, to, amount)` → 满 `b2wDelay`（15 分钟）→ `executeRelease`；不查白名单（用户存的是真钱）。排队期内监控核对 BSC 上是否有对应的已 finalized `Deposited`，找不到则**暂停**，由负责人取消该笔。单独的 `b2wDailyCap`、`b2wPerAddrDailyCap`、`b2wMaxPerTx`。`eventKey` 的 `srcChainId` 取对端链 ID（`peerChainId`）。

### 5.4 状态取值

BSC 放款：`None / Queued / Released / Voided`（撤销排队 = 作废）。WANTOS 订单：`Locked / Refunding / Refunded`。BSC 存款退款：`None / Refunding / Refunded`。

### 5.5 参数（两条链各一套）

**BSC（W2B 付款方向）**

| 参数 | 初值建议 | 范围 | 放宽 / 收紧 |
|---|---|---|---|
| `dailyCap`（全局滚动 24h） | 5,000 | 1,000 ～ 50 万 | 时间锁 / 立即 |
| `perAddrDailyCap` | 2,000 | 100 ～ 2 万 | 同上 |
| `maxPerTx` | 2,000 | 10 ～ 2 万 | 同上 |
| `largeThreshold` | 1,000 | ≤ `maxPerTx` | 同上 |
| `releaseDelay` | 12h | 6h ～ 7 天 | 同上 |
| `legacyCap`（旧单补付，滚动 24h） | 5,000 | 0 ～ 10 万 | 同上 |
| `legacyPerAddrCap`（旧单补付，每地址滚动 24h） | 5,000 | ≤ `legacyCap` | 同上 |
| `minDeposit` / `maxDepositPerTx` | 10 / 2,000 | ≤ 2 万 | 放宽走时间锁，收紧立即 |
| `refundDelay` | 24h | 12h ～ 7 天 | 同上 |

**WANTOS（跨出锁币 + B2W 入账）**

| 参数 | 初值建议 | 范围 | 放宽 / 收紧 |
|---|---|---|---|
| `w2bMinAmount` / `w2bMaxPerTx` / `w2bPerAddrDailyCap` | 10 / 2,000 / 2,000 | 10 ～ 2 万 | 时间锁 / 立即 |
| `b2wDailyCap` / `b2wPerAddrDailyCap` / `b2wMaxPerTx` | 3,000 / 2,000 / 2,000 | 500 ～ 20 万 | 同上 |
| `b2wDelay` | 15 分钟 | 10 分钟 ～ 24h | 同上 |
| `refundDelay` | 24h | 12h ～ 7 天 | 同上 |
| `supplyCeiling` | 部署时 `totalSupply` + `mintAlertThreshold`（1 万） | 降低不得低于当前 `totalSupply` | 降低立即；提高走时间锁 |

**参数间约束（合约在每次设置和收紧时检查）**：BSC `maxPerTx ≤ perAddrDailyCap ≤ dailyCap`、`largeThreshold ≤ maxPerTx`；WANTOS `w2bMinAmount ≤ w2bMaxPerTx ≤ w2bPerAddrDailyCap`、`b2wMaxPerTx ≤ b2wPerAddrDailyCap ≤ b2wDailyCap`。收紧时按顺序逐个调。

**跨链一致性（合约无法硬编码，由监控检查并告警）**：BSC `maxPerTx ≥` WANTOS `w2bMaxPerTx`；BSC `maxDepositPerTx ≤` WANTOS `b2wMaxPerTx`。**收紧顺序**：先收紧 WANTOS，再收紧 BSC；放宽反过来。订单金额超过当前上限时进入 PENDING_REVIEW，由负责人决定。

**储备口径**：滚动 24h = 24 个连续小时桶；**"1 天用量" = `dailyCap + legacyCap`**（初值 1 万/天）；首批 BSC 储备 ≥ 其 3 倍（≥ 3 万）。补水后提额是例行操作（时间锁提议，48h）。

### 5.6 不变量（PR-1 每条都要有测试）

1. 白名单为空时，任何地址都无法 `bridgeOut`，BSC 也无法向任何地址放款。
2. 同一个 `eventKey`，只能发生"放款一次"或"作废一次"中的一个；`Voided` 之后不能放款。
3. 任意**连续 24 个小时桶**内，BSC 侧总放款（含已排队，不含旧单补付）≤ `dailyCap`；旧单补付 ≤ `legacyCap`；任一地址 ≤ 对应的每地址额度。
4. 升级、提取、放宽参数、授予钥匙、更换管理钱包只能经时间锁；不满 48h 不能执行；过期 14 天作废；暂停期间和恢复期间不能执行；**交接或恢复后，旧地址的 cancel 被拒绝**。
5. 四类钥匙两两不同；提议人恰好一个；白名单钱包只能经交接或恢复更换；`DEFAULT_ADMIN_ROLE` 只能是时间锁。
6. 升级后白名单、订单、额度、储备数据不变；存储布局检查通过。
7. 暂停时放款、排队、执行、旧单补付、跨出、存入、退款执行全部不可用；取消、作废、吊销、冻结、移除仍可用。
8. 白名单批次只接受当前白名单钱包签名；nonce 不能重放；不能跨链；超过 2h 无效；冻结时不能添加；地址严格递增。
9. 交接 / 恢复：等待期、指定地址、过期、零地址、钥匙重复、否决、对称取消、一次只允许一个恢复、恢复一启动白名单自动冻结，全部生效。
10. `totalSupply > supplyCeiling` 时 `bridgeOut` 被拒绝；`supplyCeiling` 不能降到 `totalSupply` 以下。
11. 退款只能退给原地址、原金额。
12. 收紧操作不能突破下限，参数间约束始终成立。
13. 崩溃后重放 `queueRelease`，合约返回已 `Queued`，不重复扣额度。

跨链不变量"同一订单 BSC 放款与 WANTOS 退款最多一个"放在 PR-9 端到端测试中验证。

---

## 6. 付款程序 Relayer v2（服务器 A）

### 6.1 运行与密钥

- 服务器 A 由负责人指定；旧 relayer 的服务器和代码一律不复用。
- 两条链各一把付款钥匙，放在云 KMS。KMS 只防钥匙被拷走；**真正的防线是链上白名单和额度**。
- 服务器上的 gas 只放 3 天用量。

### 6.2 数据来源

- **WANTOS**：自建非验证全节点为主，另用 rpc / rpc2 / rpc3 中至少一个交叉核对；每笔订单的 receipt 两个来源一致才处理。WANTOS 出块即最终，同时检查节点块高没有落后。
- **BSC**：至少两个独立 RPC；**只处理 `finalized` 区块**，取不到时等待并告警；BSC 放款也要等 `finalized` 才记为 RELEASED。
- **自建交易索引**：WANTOS 上 USDT / MG / TIDE 的 `Transfer`、原生币转账、工厂 `0x31580F9B288A7774311D7E1962EF173150167E64` 下全部 8 个交易对的 `Swap`。Blockscout 只用来交叉核对。
- 只处理 `log.address == 本链桥合约` 的事件。

### 6.3 订单状态机（按方向）

**W2B（WANTOS → BSC）**

| 状态 | 出口 |
|---|---|
| DETECTED | 风控 → 下列之一 |
| WAIT_INDEX | 索引追上后继续；超过 10 分钟告警 |
| WAIT_WHITELIST | 两链一致后继续；30 分钟告警 |
| WAIT_CAP / WAIT_RESERVE | 额度恢复 / 补水后继续；WAIT_RESERVE 立即告警 |
| WAIT_PAUSE | 合约暂停中；解除后继续（上链前先读 `paused()`） |
| PENDING_REVIEW | 通过 → 继续；拒绝 → REJECTED；72h 未处理告警 |
| HELD | 负责人放行 → 继续；拒绝 → REJECTED；7 天未处理告警 |
| SUBMITTED | finalized → RELEASED 或 QUEUED；回滚 → 按原因分类 |
| QUEUED | 到期执行 → SUBMITTED；被撤销 / 地址被移出白名单 → REJECTED |
| REJECTED | BSC 上作废 finalized → VOIDED |
| VOIDED | 负责人发起退款 → REFUND_REQUESTED |
| REFUND_REQUESTED | 到期执行 → REFUNDED；被取消 → 回到 VOIDED |
| RELEASED / REFUNDED | 终态 |
| FAILED | 只能人工处理：重试或 REJECTED |

**B2W（BSC → WANTOS）**：DETECTED → WAIT_RESERVE / WAIT_CAP / WAIT_PAUSE（没有 WAIT_WHITELIST）→ QUEUED（15 分钟）→ RELEASED。被拒绝（极少）→ WANTOS 上作废 → BSC 存款退款 → REFUNDED。

**LEGACY（旧单补付）**：DETECTED（来自补付清单）→ WAIT_WHITELIST / WAIT_CAP（收款地址必须先进白名单）→ PENDING_REVIEW → QUEUED → RELEASED；被拒绝是终态。

**回滚原因分类**：读 `payouts[eventKey].status`：Released → RELEASED；Queued → QUEUED；Voided → REJECTED；额度不足 → WAIT_CAP；余额不足 → WAIT_RESERVE；合约暂停 → WAIT_PAUSE；不在白名单 → 按 §4.4 判断；金额超过当前上限 → PENDING_REVIEW；其他 → FAILED。

### 6.4 可靠性

- `tx_attempts`：签名后、广播前先落库；加价替换的多个哈希全部记录。
- `chain_cursor`：区块游标；启动时对齐 nonce，已签名未广播的交易原样重播，从游标回扫 100 块。
- 单进程串行发送；卡住时同 nonce 加价替换（WANTOS 的行为在 PR-0 实测）。
- BSC 放款前重读 WANTOS 上 `orders[id].status == Locked`。

### 6.5 数据库（PostgreSQL）

```sql
create table orders (
  event_key bytea primary key, direction text not null,            -- W2B | B2W | LEGACY
  src_chain int not null, src_event_nonce numeric not null, src_tx_hash bytea not null,
  user_addr bytea not null, to_addr bytea not null, amount_wei numeric(78,0) not null,
  status text not null, reasons jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table tx_attempts (id bigserial primary key, event_key bytea, chain_id int, nonce bigint,
  tx_hash bytea, gas_price numeric, raw_tx bytea, state text, created_at timestamptz default now());
create table chain_cursor (chain_id int primary key, last_processed_block bigint);
create table controlled_set (addr bytea primary key, label text, added_at timestamptz default now());
create table audit_log (id bigserial primary key, actor text, action text, payload jsonb, at timestamptz default now());
```

白名单以链上为准。付款程序自己发心跳和告警（等待超时、nonce 不一致、KMS 失败、gas 不足）给负责人。

---

## 7. 风控：资金来源检查

防"受控资金转给白名单用户代跨"。

- **受控来源集合**：附录 A，加上旧金库 `0x8dFd` 在切换时刻 T 之后的转出。**由负责人在管理后台直接增删**，每次操作写审计日志，不需要签名或延迟。增发接收地址只告警，不自动加入。
- **追溯**：每笔跨出前，用自建索引回溯该地址近 30 天入账，追 2 跳。
  - 经过交易池时跟着交易者走：同一笔交易里交易者卖进池子的币来自受控来源，换出来的币也算受控。
  - 统一按 USDT 价值折算（MG、TIDE 用池子时间加权价格；WANT 用 WANT/USDT 池价）。
  - **占比 = 受控来源价值 ÷ 该地址近 30 天全部入账价值**。
- **判定**：占比 ≥ 20% → HELD；5%～20% → PENDING_REVIEW；< 5% 放行。
- **行为规则**：首次收到资金后 10 分钟内跨出且 ≥ 500 → PENDING_REVIEW；同一来源 24h 内资助 ≥ 3 个地址跨出 → 全部 PENDING_REVIEW 并告警。
- **降级**：索引不可用或落后时只停自动放行（WAIT_INDEX），不放松规则。
- **对外不公开**：用户页面对 HELD、PENDING_REVIEW 统一显示"处理中"。
- **局限**：场外交易只能部分拦住，兜底靠每地址额度、行为规则和监控。

---

## 8. 站点

三个独立的 Cloudflare Pages 项目、三个子域名，互不共用代码包和部署，全部在 Qbit 账户。

### 8.1 用户跨链页 `bridge.wanto.pro`

- 功能：连接钱包、开通状态、两个方向跨链、订单状态、今日剩余额度。不含任何管理功能。
- 钱包：TP / MetaMask / OKX 的 DApp 浏览器；电脑用插件或 WalletConnect v2。缺 WANTOS 网络时一键添加（chainId 13555，RPC `https://rpc.wantos.io`，浏览器 `https://scan.wantos.io`）。
- 未开通："跨链未开通，请联系客服"；风控中的订单统一显示"处理中"。
- 交易目标只能是两个桥合约和 USDT；授权用精确金额；页脚固定显示两条链的桥合约地址。
- 技术栈：Vite + React + viem + wagmi。

### 8.2 管理后台 `admin.wanto.pro`（暂定名）

| 页面 | 功能 | 操作者 |
|---|---|---|
| 白名单管理 | 上传（CSV / TXT / 粘贴）→ 校验、去重、排序、剔除合约地址 → 逐行参考信息（网体、上级、风险标记、历史跨出、余额）→ 选择**添加或移除** → 显示 `listHash` 与 `count` → 白名单钱包签名 → 按顺序提交两条链；当前白名单、批次记录、两链不一致补齐 | 白名单钱包 |
| 紧急 | 冻结白名单写入、移除地址、否决交接、暂停 / 解除暂停、吊销付款钥匙 / 暂停钥匙 | 管理钱包（暂停也可用白名单钱包） |
| 时间锁面板 | 两条链所有待执行提议：内容解码、倒计时、取消、执行 | 管理钱包、白名单钱包 |
| 参数 | 收紧（立即）；放宽（生成时间锁提议） | 管理钱包 |
| 交接与恢复 | 发起 / 取消 / 否决；启动或取消恢复；生成交接链接 | 两个钱包 |
| 订单审核与退款 | PENDING_REVIEW / HELD：命中规则、资金来源路径；通过或拒绝；批量作废；退款申请 | 负责人 |
| 受控集合 | 增删，写审计日志 | 负责人 |
| 储备与对账 | 两条链余额、额度使用、对账结果、告警记录、每日白名单变更报告 | 只读 |

风险标记只是提示：🔴 受控来源；🟠 可疑名单或来源命中；🟡 不在网体内。🔴 默认不勾选，需要二次确认。

管理后台读取付款程序数据的接口：经 Cloudflare Worker 转发，请求需带负责人钱包签名的短期会话（SIWE）。

### 8.3 离线核对工具

单文件开源工具，在**另一台设备**离线运行：读原始地址文件 → 校验、排序 → 输出 `listHash` 与 `count`。负责人签名前比对工具输出和钱包显示，一致才签。同一工具也可解码时间锁提议。

### 8.4 交接链接页 `handover.wanto.pro`

独立子域名和独立项目，不放在 Cloudflare Access 后面（新持有人可能在钱包 DApp 浏览器里打开）。页面只读链上数据。功能：新持有人证明地址 → 等待倒计时 → 接收（两条链各一次）；显示两条链合约地址供核对；"只完成一条链"时引导补签。链接里没有任何签名或密钥。

### 8.5 Cloudflare 与供应链

Qbit 账户启用硬件安全密钥两步验证；`admin.wanto.pro` 加 Cloudflare Access（防窥视，不是安全边界）；强制 HTTPS、HSTS、严格 CSP；部署令牌最小权限；依赖锁定；发布产物哈希在两个独立渠道公布。

---

## 9. 独立监控 Watcher（服务器 B）

- 与付款程序**不同服务器、不同钥匙、不读付款程序的数据库**；用至少两个 RPC 订阅两条链事件，逐事件实时核对，断线后按游标补扫。
- 持有暂停钥匙（**只能暂停，没有取消权**）。
- **告警只发负责人**。通道：Telegram 机器人 + 电话升级。
- **监控自身存活**：每 5 分钟向外部心跳服务报到，超时由外部服务直接打电话或发短信给负责人。

### 9.1 实时核对

| 核对 | 不符时 |
|---|---|
| BSC 每笔 `Released` / `ReleaseQueued` 都对应 WANTOS 上一个 `BridgeOut`（同 orderId、同地址、同金额），或补付清单中的一项 | 自动暂停两条链 |
| WANTOS 每笔 B2W `ReleaseQueued` 都对应 BSC 上一个已 finalized 的 `Deposited` | 自动暂停；负责人先取消可疑排队项，再解除暂停 |
| WANTOS 每笔 `RefundRequested` 对应的 BSC `eventKey` 已 finalized 为 `Voided` | 自动暂停 |
| BSC 每笔 `DepositRefundRequested` 对应的 WANTOS `eventKey` 已是 `Voided` | 自动暂停 |
| WANTOS-USDT 出现增发 | **只告警**；累计增发（监控持久化，不因暂停清零）超过 `mintAlertThreshold`（1 万）才自动暂停 |

### 9.2 余额对账（每小时，不等式加容差）

```
WANTOS 桥余额 ≥ ΣFunded + ΣBridgeOut − Σrelease(B2W) − ΣexecuteRefund − Σwithdraw − 容差
BSC 金库余额  ≥ ΣFunded + ΣDeposited − ΣReleased − ΣexecuteDepositRefund − Σwithdraw − 容差
```

多出的部分列为"未登记入账"，不触发暂停；少了就告警。

### 9.3 告警清单

| 事件 | 级别 |
|---|---|
| §9.1 任一核对不符（已自动暂停） | 紧急 |
| 暂停 / 解除暂停；吊销暂停钥匙 | 高 |
| 时间锁出现新提议（推送解码内容与取消入口；48h 内审阅） | 高 |
| 发起 / 取消 / 否决 / 完成交接；启动或取消恢复；冻结白名单；合约升级已执行；任何角色变化 | 高 |
| 每一批白名单变更（地址数、`listHash`、两链交易哈希）；每日变更报告（含管理钱包紧急移除） | 中（供巡查） |
| WANTOS-USDT 增发（数量、接收地址） | 高 |
| 储备 < 1 天用量（余额扣除已排队未执行的放款）/ < 0.5 天；WANTOS 桥余额偏低 | 高 / 紧急 |
| 受控集合中任一地址有资金动作；`0x8dFd` 转入或转出；旧付款程序 `0x9dab` 有新交易 | 高 |
| 跨链参数不一致（§5.5） | 高 |
| 自建索引或节点落后、WANTOS 出块停滞、BSC 取不到 finalized | 高 |
| 当日放款达到 `dailyCap` 的 70%；新的排队放款；退款申请 / 作废来源；暂停钥匙 gas 不足 | 中 |
| 对账失败或没有运行 | 高 |

付款程序自身的告警（等待超时、nonce 不一致、KMS 失败、gas 不足、心跳中断）由付款程序直接发给负责人。

---

## 10. 旧桥处置与迁移

**Phase 0（现在就做，不依赖新桥）**
1. 旧 BSC 金库 `0xec6e`、旧储备钱包、补水钱包 `0xe1e8` **不再注入任何资金**。
2. 公告旧桥停用、旧网址作废。旧前端在原技术人员手里，公司下线不了；同时向 Cloudflare 举报滥用，并向主流钱包的钓鱼黑名单提交旧网址。
3. 旧 WANTOS 金库 `0x8dFd` 没有暂停：有 owner `0x7afc` 私钥就暂停；没有的话明确记为"旧金库无法暂停"，靠公告和监控。
4. 确定**切换时刻 T** 并公告：T 之前未放款的旧订单列入补付清单；T 之后存进 `0x8dFd` 的资金逐笔人工核实后补付。
5. 尽量查清 `0x9dab` 旧付款程序的位置并停掉；补付期间持续监控旧 BSC 金库和旧付款程序有无新放款。

**旧订单补付**
- 补付清单（旧交易哈希、logIndex、地址、**该旧单总额**）做成 Merkle 树，叶子 = `keccak256(abi.encode(oldTxHash, logIndex, to, totalAmount))`；根经时间锁 `addLegacyRoot` **追加**（T 之后核实的补付另起新根），**清单在提议时同步公开**，白名单钱包据此核对后再决定是否取消。
- `releaseLegacy(oldTxHash, logIndex, to, totalAmount, amount, proof)`：`eventKey = keccak256(abi.encode("LEGACY", oldTxHash, logIndex))`；校验证明；`to` 必须在白名单；一律排队；**合约记录 `paid[eventKey]`，累计已付 ≤ `totalAmount`**，所以大额旧单可以分多天付、不会重复付；每次计入 `legacyCap`（全局）和 `legacyPerAddrCap`（每地址），**不计入 `dailyCap` 和 `perAddrDailyCap`**。
- 放款前查旧 BSC 金库 `0xec6e` 的放款记录，确认旧桥没有付过。
- 被拒绝是终态（WANTOS 侧没有锁币），在清单中标记。

**第一批白名单**：合约部署时为空。我提供参考名单（Magellan 网体 3,927 个地址，附风险标记），由负责人筛选后在管理后台上传、签名写入。每批 500 个，约 8 批 × 2 条链 = 16 次签名。

---

## 11. 应急手册

| 场景 | 攻击者能做什么 | 应对 | 结果 |
|---|---|---|---|
| **BSC 付款钥匙泄露** | 只能付给白名单地址；全局滚动额度 ≤ `dailyCap`（极端时间窗口最多 2 倍，因小时桶对齐），单地址 ≤ `perAddrDailyCap` | 监控发现"找不到源链事件"→ 自动暂停；管理钱包吊销该钥匙；经时间锁授予新钥匙（48h） | 损失有上限，约 `dailyCap`（初值 5,000） |
| **WANTOS 付款钥匙泄露** | B2W 入账一律排队 15 分钟，上限 `b2wDailyCap` | 监控在排队期内发现找不到 BSC 存款 → 自动暂停；负责人取消可疑项后再解除暂停；吊销钥匙 | 正常情况下零损失 |
| **暂停钥匙泄露** | 只能暂停 | 管理钱包解除暂停；吊销；经时间锁授予新的 | 无资金损失 |
| **管理钱包丢失** | — | 白名单钱包发起恢复（14 天，无人取消） | 14 天后恢复；期间白名单冻结，升级 / 提取暂停 |
| **白名单钱包丢失** | — | 管理钱包发起恢复（7 天，无人取消） | 7 天后恢复；期间白名单冻结 |
| **管理钱包被盗** | 收紧类操作（只会更严）；提议放宽 / 升级 / 提取要等 48h；发起白名单钱包恢复 | 白名单钱包逐条取消恶意提议和恢复；暂停期间放宽类操作无法执行 | **资金不会被拿走**；可能长期僵持：储备和 Locked 订单暂时无法动用。被盗者还可以移除白名单，使在途订单进入退款流程，而退款需要管理钱包发起，他可以拒绝配合，订单会一直冻结（不丢失） |
| **白名单钱包被盗** | 往白名单加地址（仍受额度约束）；取消正常提议；暂停；发起交接给自己 | 管理钱包立即冻结白名单、移除可疑地址、否决交接；启动白名单钱包恢复（7 天），攻击者作为现任持有人可以取消它 | **资金不会被拿走**；可能僵持：白名单冻结（只能移除） |
| **两个钱包同时被盗** | 全部权力 | 无法阻止 | 唯一的单点：两个钱包必须分设备、分地点保管，助记词分开备份 |
| **管理后台被篡改** | 诱导签错的批次或交易 | 离线核对 `listHash` 和时间锁 calldata；每批变更实时推送 | 不签就没有损失 |
| **付款程序服务器被攻破** | 等同付款钥匙泄露，并能改自己的数据库 | 监控在另一台服务器、读链上事件，不受影响 | 同第一行 |
| **有人增发 WANTOS-USDT** | 增发的币：接收地址不在白名单，无法直接跨出 | 只告警；累计超过 1 万才自动暂停 | 小额增发不影响业务 |

**无链上"最后手段"（决定 15）**：钥匙被盗且双方互相取消时，只能靠链下处理（沟通、部署新桥另行安排用户资金）。预防靠钥匙保管：两个钱包助记词分开、离线、异地备份，每季度演练一次恢复。

---

## 12. 日常操作的签名次数

| 操作 | 签名 |
|---|---|
| 一批白名单（≤ 500 个） | 白名单钱包 2 次（两条链）+ 离线核对 1 次 |
| 一笔跨出退款 | BSC 作废 1 次 + 管理钱包申请 1 次（WANTOS）；24h 后任何人执行 |
| 补水后提额 | 管理钱包每条链提议 1 次；48h 后执行 |
| 误暂停后恢复（两条链） | 管理钱包 `unpause` 2 次 |
| 订单审核 | 每单 1 次 |
| 审阅时间锁提议 | 确认"这是不是我提的"，不是就取消 |

---

## 13. 开发计划（PR 拆分）

| PR | 内容 | 依赖 | 验收 |
|---|---|---|---|
| PR-0 准备 | ①`0xc74F` owner 权限逐函数审计；②验证者信任假设；③钥匙仪式文档；④硬件钱包能否完整显示 EIP-712 的 `bytes32` 与 `count`（决定单批大小）；⑤WANTOS 支持的 EVM 版本；⑥WANTOS app mempool 同 nonce 替换行为；⑦WANTON 1345 与主网二进制、mempool 是否一致；⑧WANTOS 与 BSC 用全新部署者 EOA 按 nonce 部署的 fork 演练，含失败规程 | — | 结论写进本文档 |
| PR-1 合约 | 两个桥合约、`BridgeTimelock`、`CancelProxy`、地址预测与部署脚本、验收脚本 | PR-0 | §5.6 十三条不变量全部有测试；交接、恢复（对称取消、自动冻结）、退款、额度、批次签名、紧急权力、参数约束、过期换 salt 的正反用例；覆盖率 ≥ 95%；`slither` 无高危 |
| PR-2 外部审计 | 合约冻结后送审，与 PR-3～PR-7 并行 | PR-1 | 高危、中危全部修复；修复后 PR-9 重跑 |
| PR-3 付款程序 | 自建节点与索引、状态机、`tx_attempts`、游标、回滚分类、多 RPC | PR-1 接口 | 故障注入：断网、重启、签名后广播前崩溃、BSC 重组、重复事件、交易卡住、额度不足、余额不足、两链白名单不一致、暂停中提交、崩溃后重放 `queueRelease` |
| PR-4 风控 | 资金来源检查、行为规则 | PR-3 索引 | 10 月真实数据回放：`0x2835`、`0x0b74`、`0xbdc4` 被拦；"受控资金卖进池子换出再转给白名单用户"的模拟用例被拦 |
| PR-5 用户页 | `bridge.wanto.pro` | PR-1 接口 | 未开通被拒；两个方向；订单状态 |
| PR-6 管理后台、交接页、离线工具 | `admin.wanto.pro`、`handover.wanto.pro`、离线核对工具 | PR-1、PR-3、PR-4 | 篡改页面后签名的批次被离线核对拦下；非白名单钱包无法写入；两链部分成功可补齐；紧急操作可用 |
| PR-7 监控 | 服务器 B、实时核对、余额对账、告警、自动暂停、外部心跳 | PR-1 事件 | §9 每条核对和告警在测试网演练一次 |
| PR-8 迁移与旧单 | 切换时刻 T、补付清单与 Merkle 根（含清单公开流程）、公告 | PR-1 | 补付不重复（与旧桥放款记录核对） |
| PR-9 测试网联调 | WANTON 1345 + BSC 测试网全链路 | PR-3～PR-8 | 端到端 100 笔；§11 每个场景演练；跨链不变量"放款与退款最多一个" |
| PR-10 主网上线 | 部署（白名单为空）→ 验收脚本 → 负责人导入第一批白名单 → 两侧注资 → 灰度 | PR-2、PR-9 | 72h 内 §9.1 实时核对零告警，§9.2 对账无短缺 |

各 PR 先落规划文档再实施；合并需负责人明确批准。

---

## 14. 待决事项

1. 公司现在实际掌握哪些旧私钥：`0x9272`、`0x9dab`、`0x7afc`、`0xf974`、`0xc081`、`0xcca4`、`0xe1e8`、4 个储备钱包。
2. PR-0 各项结论。
3. 付款程序服务器 A、监控服务器 B 放在哪里。
4. 额度初值（§5.5）。
5. WANTOS 侧启动资金金额。
6. 管理后台域名是否就用 `admin.wanto.pro`，交接页是否用 `handover.wanto.pro`。

---

## 附录 A：受控来源集合（初版，需负责人逐条确认）

> 用途：①管理后台录入白名单时红色提示，防止误录；②资金来源检查。由负责人在管理后台增删。

| 地址 | 说明 |
|---|---|
| `0x9272f360b98160c1662abb6d2df9e4f313b39502` | 旧桥 owner 与升级权；10-17～10-26 升级 `0x778b` 10 次 |
| `0x9dab17a9ad061cbda2bef607a6a330ee74076e90` | 旧付款程序 |
| `0x7afc830d90f3080dc754618a9e4f71775815c3ad` | 旧 WANTOS 金库 owner |
| `0x8dfd39e98f478688a41cdbe40bc544d672f0a9e3` | 旧 WANTOS 金库（T 之后的转出） |
| `0xac979ae2ff58267bb2534779da4693271ce32964` | 合约 `0xb7f4` owner |
| `0xe6c5a61de6c1bddf45d19332db81cdcfe579d6c7` | 合约 `0x778b`、`0x7fd9` owner |
| `0xc08187977f550f63b810da45b4ab8472f61df003` | WANTOS-USDT owner（可增发） |
| `0x293e61e0c855f9a5a16e7a191684ceb5ab44b916` | USDT 初始铸币接收地址 |
| `0xf974868f63a711d3f36b35a02e3a8fcbd2087c4b` | 持有 2,531 万 WANTOS-USDT |
| `0xcca46deb8f1b7cc61e96bd25fc4db3953ccb3ec1` | MG 池全部 LP |
| `0xeabd18c995c0c5feda5db3ca0d010e49f41a0bb4` | 9,880 万 MG |
| `0xb7a4e1fb7f6acb6416fe701c6ebb7c863cb13523`、`0xfd7627bbc0e5d8edf1123042649ab1a51ac68e94` | MG 池做市资金链路 |
| `0xe49d28397fa4dccbcd087276e6c3c98b81645e17`、`0x765bcb1dfc9cb9ec4c47e052daf4b31ec76292af`、`0x14477d9608ecdf66790a6ccd6bf605d3c6e0b437`、`0xe2dd3b4c4f46d81cc129f1e4830341166216f8fc`、`0xeead2ec17823bc8cb803a1e60d9ce031435c2b67` | `0xf974` 出资的运营地址 |
| `0x6317f6d23ad85058ca3cf5872827e70d05a42938` | TIDE 全部初始发行接收地址 |
| 合约 `0x778b7d2cf7fde555798449c813616191f6b3f3d6`、`0x7fd935d53afbe71ffeb6bd5b1a0ff25d29d01b24`、`0xb7f476ce42782f23f6e04143855cb61337b2791f` | 升级权在 `0x9272` |
| `0xf974` 历史上直接转过钱的 79 个地址 | 建议标 🟠，不直接列为受控 |

网体内需特别注意：`0x765b`（钱来自 `0xf974`，网体第 7 层，下有 41 人）、`0x0b74`（10 月拿 `0xe49d` 的钱直接跨出）。

## 附录 B：参考材料

- `Magellan网体推荐关系.csv`：3,927 个地址，已叠加 10-01 换根改挂（ReferralRegistry `0x082b…a544` + ParentOverride `0x2da8…eefb`）
- `孤立跨出账户_候选清单.csv`：252 个
- `10月MG卖出套现明细_含可疑标注.csv`：1,284 个
- `10月直接跨出超1000_孤立地址.csv`：3 个
- `WANTOS_USDT_散户持仓_ge1.csv`
