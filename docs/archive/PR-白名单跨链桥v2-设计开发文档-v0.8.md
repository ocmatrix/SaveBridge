# PR 规划：白名单跨链桥 v2（WANTOS ↔ BSC USDT）设计开发文档

> 版本 **v0.8**（2026-11-02）｜状态：待复核，**未开工**（负责人指示：先不开工）
>
> **v0.8 是整篇重写**：吸收了 11-01 的安全审查和架构审查意见（共约 40 条），并清理了 v0.1～v0.7 的残留表述。v0.7 原文备份在会话 scratchpad。
>
> **负责人已拍板的决定（本版据此设计，不再讨论）：**
> 1. 严格白名单、默认拒绝；合约部署时白名单**为空**；只有负责人的**白名单钱包**能添加和移除，在管理后台的同一个页面操作；网体关系只作参考。
> 2. 白名单**两条链都写**。
> 3. 合约**可升级**、管理员**可更换**，都要经过 48 小时时间锁。
> 4. 管理员现阶段由负责人一人担任（**管理钱包**），以后交接给团队多签。
> 5. 管理钱包和白名单钱包是**两个不同的钱包**。两者的交接都由负责人发起，负责人提供指定的新地址，新持有人通过交接链接签名接收。
> 6. **白名单钱包同时是"取消"钥匙**：可以取消任何待执行的升级、参数放宽、储备提取、管理员变更。不再设第三个钱包。
> 7. 增加一把**只能暂停**的服务器钥匙（PAUSER），用于异常时自动暂停。
> 8. 用户跨链页面 `bridge.wanto.pro`；**管理后台独立站点**（暂定 `admin.wanto.pro`），两者不混放。均部署在负责人的 Cloudflare 账户（Qbit）。
> 9. WANTOS 侧启动资金由负责人直接转账到 WANTOS 桥合约地址。

---

## 0. 目标

用一套**全新的钥匙和合约**替换旧桥：

1. 原技术人员手里可能残留的任何旧私钥，都**拿不走新桥里的钱**。
2. 他控制的 WANTOS 资产所在地址不在白名单里，**无法直接跨出**；转给白名单用户代为跨出，由资金来源检查拦截。
3. 任何**一把新钥匙**单独泄露，损失都有上限，并且会被发现、可以止损。
4. 团队照常发展：新用户的地址由负责人分批录入白名单即可跨链。

---

## 1. 背景

### 1.1 旧桥结构与现状（链上只读核实）

| 角色 | 地址 | 现状 |
|---|---|---|
| WANTOS 旧金库（可升级代理） | `0x8dFd39E98f478688A41Cdbe40bc544d672F0A9E3` | 锁着约 94.9 万 WANTOS-USDT；**没有暂停**；owner `0x7afc…c3ad`，升级权属于 `0x9272` |
| BSC 旧金库（可升级代理） | `0xeC6E356a2E986D6A9b103217B9d215c8a6F37139` | owner 和升级权都是 `0x9272…9502` |
| 旧付款程序 | `0x9dAb17a9Ad061cbDA2BeF607A6A330EE74076E90` | 2026-11-01 13:04 仍在两条链上发交易，运行位置不明 |
| BSC 旧储备 | 4 个普通钱包持有 Stargate LP + 补水钱包 `0xe1e8…ff10` | 已枯竭 |
| WANTOS-USDT | `0xc74F2e7fBdA2af9D1fc26b85E341229063Dc0873` | owner `0xc081…f003` 可增发；04-15 发行 3,000 万后未再增发 |
| 旧前端 | `mgfound.online`（原技术人员的 Cloudflare 账户） | 公司无法下线 |

### 1.2 旧桥失控的根因

| 问题 | 新桥对策 |
|---|---|
| 一个钱包一笔交易就能升级合约 | 升级只能经 48 小时时间锁，白名单钱包可取消（§4.2） |
| 付款钥匙能付给任意地址、额度只靠链下 | 链上只能付给白名单地址；全局 + 每地址滚动额度写在合约里（§5） |
| 储备放在普通钱包 | 储备只存在合约里；提取只能经时间锁（§4.2） |
| 放款不检查来源 | 白名单 + 资金来源检查（§7） |
| 私钥硬编码在代码里（旧 `relayer.js:19`） | 付款钥匙进 KMS；任何钥匙不进代码和配置（§6.1） |

### 1.3 需要防住的资产

`0xf974`（2,531 万 WANTOS-USDT）、MG 池 LP `0xcca4`（可撤出 5.6 万 USDT + 7.9 万 MG）、`0xeabd`（9,880 万 MG）、合约 `0x778b`/`0x7fd9`（96.5 万 MG）、合约 `0xb7f4`（14.8 万 USDT）、旧金库 `0x8dFd`（94.9 万）、`0xc081` 增发权，以及附录 A 中的其他地址。

**结论**：这些地址不会被录入白名单，所以不能直接跨出；风险在于"转给白名单用户代跨"，由 §7 资金来源检查和 §5 额度兜底。

---

## 2. 设计原则

1. **钥匙全新，权力拆开**：放款、改白名单、提议升级、暂停分属不同的钥匙，并且在合约里**强制互斥**，任何一把都不能兼任另一个角色。
2. **放宽要等、收紧立即**：凡是让资金更容易流出的操作（升级、提取储备、提高额度、缩短延迟、更换付款钥匙、更换管理员），一律经过 48 小时时间锁，白名单钱包可以取消。凡是让资金更难流出的操作（暂停、降低额度、撤销排队放款），立即生效。
3. **链上兜底、链下精细**：白名单、全局额度、每地址额度、大额延迟写在合约里；资金来源检查、行为规则放在付款程序里。
4. **安全优先于可用**：最坏情况下宁可桥被暂停、资金卡住，也不能被提走（§12 写明了这种情况）。
5. **看得见**：任何关键操作都有链上事件，由**独立于付款程序**的监控程序推送告警。

---

## 3. 总体架构

```
 ┌──────────── WANTOS 链 ────────────┐                    ┌────────────── BSC 链 ──────────────┐
 │ 用户 ─bridgeOut()─▶ WantosBridgeV2 │                    │ BscVaultV2 (UUPS 代理，持有 USDT)  │
 │   (查白名单，锁 WANTOS-USDT，     │                    │  ├ release / queue / execute       │
 │    逐笔记录订单)                   │                    │  │  (只付白名单地址，链上额度)      │
 │   ◀─release()── (BSC→WANTOS 入账) │                    │  └ deposit (BSC→WANTOS)            │
 │ TimelockController (48h)           │                    │ TimelockController (48h)           │
 └──────────────▲─────────────────────┘                    └───────────────▲────────────────────┘
                │                                                          │
     ┌──────────┴──────────────────────────────────────────────────────────┴──────────┐
     │ 付款程序 Relayer v2（服务器 A）：自建索引 → 风控 → 放款 / 排队 / 审核 / 冻结     │
     └──────────────────────────────────────────────────────────────────────────────────┘
     ┌──────────────────────────────────────────────────────────────────────────────────┐
     │ 独立监控 Watcher（服务器 B）：多 RPC 读两条链事件 → 对账 → 告警 → PAUSER 自动暂停 │
     └──────────────────────────────────────────────────────────────────────────────────┘
   bridge.wanto.pro（用户跨链页）          admin.wanto.pro（管理后台：白名单、交接、时间锁、审核、储备）
```

---

## 4. 钥匙、角色与权力矩阵

### 4.1 角色

| 角色 | 持有者 | 形态 |
|---|---|---|
| **管理钱包（ADMIN）** | 负责人本人（交接后为团队多签） | 硬件钱包，离线保管 |
| **白名单钱包（WL）** | 负责人本人 | 硬件钱包；另一个钱包，**不得与管理钱包相同** |
| **时间锁（TL）** | 每条链一个 OpenZeppelin `TimelockController` | 合约 |
| **付款钥匙（RELAYER）** | 服务器 A 上的付款程序 | KMS 托管；**两条链各一把** |
| **暂停钥匙（PAUSER）** | 服务器 B 上的监控程序 | 热钥匙，只能暂停 |

**合约内强制规则**：
- 桥合约的最高管理权（`DEFAULT_ADMIN_ROLE`）**交给时间锁合约**，不交给任何钱包。管理钱包只是时间锁的"提议人"。这样管理钱包想做任何"放宽"操作，都必须公告 48 小时。
- RELAYER、PAUSER、WL、管理钱包四个地址**两两不同**，在 `_grantRole` 和交接函数里每次都检查，不只在部署时检查。
- `WL` 不是普通角色，只能通过 §4.4 的交接函数更换；`grantRole/revokeRole/renounceRole` 对 WL 一律禁止。
- 所有对外签名、放款的钥匙都不能是合约地址（部署脚本检查）。

### 4.2 权力矩阵（两条链相同，WANTOS 侧没有的函数注明）

| 操作 | 谁调用 | 是否经 48h 时间锁 | 谁能取消 | 暂停时可用 | 说明 / 约束 |
|---|---|---|---|---|---|
| 升级合约逻辑 `upgradeToAndCall` | 时间锁（管理钱包提议） | 是 | 管理钱包、**白名单钱包** | 是 | 新实现须先开源验证；存储布局检查通过 |
| 提取储备 `withdraw(to, amount)` | 时间锁 | 是 | 管理钱包、白名单钱包 | 是 | 合约里不再有自带的计时器 |
| 放宽参数（提高 `dailyCap`/`perAddrDailyCap`/`maxPerTx`/`largeThreshold`，缩短 `releaseDelay`） | 时间锁 | 是 | 管理钱包、白名单钱包 | 是 | 每个参数有硬编码上下限，见 §5.4 |
| 收紧参数（降低额度、延长延迟） | 管理钱包 | 否，立即生效 | — | 是 | 只能往更严的方向改 |
| 更换付款钥匙 / 暂停钥匙 | 时间锁 | 是 | 管理钱包、白名单钱包 | 是 | 同时检查四钥互斥 |
| 更换管理钱包（时间锁提议人） | 时间锁 | 是 | 管理钱包、白名单钱包 | 是 | 流程见 §4.4 |
| 修改时间锁延迟 `updateDelay` | 时间锁 | 是 | 管理钱包、白名单钱包 | 是 | 下限 48h，低于 48h 的提议在合约中直接拒绝（时间锁外包一层检查） |
| 添加 / 移除白名单 | 任何人提交，**白名单钱包 EIP-712 签名** | 否 | — | 是 | 见 §4.3 |
| 白名单钱包交接（发起 / 取消） | 白名单钱包 | 否（合约内 48h 等待） | 白名单钱包 | 是 | 新地址自己接收，见 §4.4 |
| 白名单钱包丢失后的恢复 | 时间锁 | 是（48h）+ 合约内再等 5 天 | 管理钱包、白名单钱包 | 是 | 合计 ≥ 7 天 |
| 暂停 `pause` | PAUSER、管理钱包、白名单钱包 | 否 | — | — | 立即生效 |
| 解除暂停 `unpause` | 管理钱包 | 否 | — | — | 单独解除暂停拿不走钱，见 §12 |
| 放款 `release`（小额） | RELAYER | 否 | — | **否** | 只付白名单地址；扣额度 |
| 排队 `queueRelease`（大额） | RELAYER | 否 | — | 否 | 排队时即扣额度 |
| 执行排队 `executeRelease` | RELAYER | 合约内 `releaseDelay`（默认 12h） | 管理钱包、白名单钱包（`cancelRelease`） | 否 | 执行时再查白名单 |
| 作废来源 `voidSource` | 管理钱包、白名单钱包 | 否 | — | 是 | 永久禁止该笔放款，退款的前提 |
| 退款 `refund(orderId)`（仅 WANTOS） | 管理钱包 | 合约内 24h 等待 | 白名单钱包 | 是 | 只能退回原地址、原金额；见 §5.3 |
| 存入 `deposit`（仅 BSC） | 任何用户 | 否 | — | 否 | 不查白名单 |
| 跨出 `bridgeOut`（仅 WANTOS） | 白名单用户 | 否 | — | 否 | 链上查白名单、金额上下限、每地址额度 |

### 4.3 白名单写入：EIP-712 签名批次

目的：网页即使被篡改，也不能偷偷往白名单里加地址。

```solidity
// EIP-712 domain: name="WantosBridgeV2" | "BscVaultV2", version="1", chainId, verifyingContract
struct WhitelistBatch {
    bytes32 listHash;   // keccak256(abi.encode(sortedAddrs))，地址升序排列
    bool    allowed;    // true=添加，false=移除
    uint256 nonce;      // 每签一批 +1，防重放
    uint256 deadline;
}
function applyWhitelistBatch(address[] calldata sortedAddrs, bool allowed, uint256 nonce,
                             uint256 deadline, bytes calldata wlSignature) external;
//   合约重新计算 listHash；验证签名者 == 当前白名单钱包；nonce 匹配；未过期
//   单批 ≤ 200 个地址；拒绝零地址；拒绝 code.length > 0 的地址
event WhitelistBatchApplied(bytes32 indexed listHash, bool allowed, uint256 nonce, uint256 count);
event WhitelistUpdated(address indexed addr, bool allowed, bytes32 indexed listHash);
```

- 白名单钱包**只签名，不发交易，不需要 gas**；交易由管理后台用任意账户提交。
- 钱包签名界面会结构化显示 `listHash / allowed / nonce`。负责人用**离线核对工具**（§8.3）对原始地址文件算出 `listHash`，两边一致才签。
- 签名里包含 `chainId` 和合约地址，所以每一批在两条链上各签一次，不能跨链重放。
- 写入顺序：**添加时先 BSC 后 WANTOS；移除时先 WANTOS 后 BSC**。这样任何时刻都不会出现"WANTOS 能锁币、BSC 却不能付款"的状态。
- 地址被移除时，它的在途订单：已排队的在执行时会被拒绝，付款程序把订单转为 REJECTED 走退款（§5.3）；未上链的直接 REJECTED。

### 4.4 交接（管理钱包、白名单钱包）

两种交接都由**负责人发起**，负责人提供指定的新地址。

**白名单钱包交接**（合约内两步）：
1. 新持有人先打开交接链接，用新钱包做一次 `personal_sign`，证明这个地址确实是他的（防止地址填错或被剪贴板篡改）。
2. 负责人用**当前白名单钱包**调用 `beginWhitelistManagerTransfer(新地址)`，两条链各一次。
3. 等满 48 小时；期间当前白名单钱包可以 `cancelWhitelistManagerTransfer()`。
4. 新持有人打开交接链接，调用 `acceptWhitelistManagerTransfer()`，两条链各一次。接收时自动：
   - 撤销旧地址的白名单权限；
   - **把两条链时间锁的"取消人"从旧地址换成新地址**（见 §4.5）。
5. 待接收的交接 7 天未接收自动作废；新地址不能是零地址，也不能等于其他三把钥匙。

**白名单钱包丢失**：管理钱包经时间锁提议 `recoverWhitelistManager(新地址)`（48h），执行后再等 5 天，新地址接收。期间告警持续推送。

**管理钱包交接**（时间锁两步）：
1. 新持有人在交接链接上 `personal_sign` 证明地址。
2. 负责人用管理钱包向时间锁提议：授予新地址提议人和取消人权限、撤销旧地址，两条链各一次。
3. 等满 48 小时，期间管理钱包或白名单钱包可以取消。
4. 新持有人打开交接链接，点击"执行"，两条链各签一次，交接完成。时间锁到期后任何人都能执行，所以新持有人自己签名执行即可。
5. 交接给团队多签时，新地址就是多签地址，由多签成员签名执行。

### 4.5 时间锁配置（每条链）

| 项目 | 设置 |
|---|---|
| 延迟 | 48 小时；`updateDelay` 低于 48 小时的提议拒绝 |
| 时间锁自身管理员 | 构造参数 `admin = address(0)`；改成员只能经时间锁自己提议（48h） |
| PROPOSER | 管理钱包（构造时自动获得 CANCELLER） |
| CANCELLER | 管理钱包、白名单钱包 |
| EXECUTOR | 任何人（到期后谁都能执行，防止被卡） |

**白名单钱包交接时的取消人同步**：部署时经时间锁把"授予/撤销 CANCELLER"的权限委托给桥合约，限定只能用于 WL 交接时的一换一。部署验收脚本检查这一点。（实现方式在 PR-1 定稿：若 OZ `TimelockController` 的角色模型不便委托，就把 CANCELLER 改为指向一个由桥合约维护的小合约，由它代理取消。）

---

## 5. 合约

两条链的合约都基于 OpenZeppelin Contracts Upgradeable v5：`AccessControlUpgradeable` + `PausableUpgradeable` + `ReentrancyGuardUpgradeable` + `UUPSUpgradeable` + `EIP712Upgradeable` + `SafeERC20`。存储使用 ERC-7201 命名空间。

### 5.1 部署与初始化

- 部署顺序：实现合约（构造函数里 `_disableInitializers()`）→ `new ERC1967Proxy(impl, initData)`，**部署和初始化在同一笔交易里完成**，避免被抢先初始化。
- `initialize(timelock, adminWallet, wlWallet, relayer, pauser, usdt, params)`：
  - 白名单为空：`whitelistCount == 0`，不接受任何初始地址。
  - 四把钥匙两两不同，且都不是合约地址。
  - `DEFAULT_ADMIN_ROLE` 只授给时间锁；部署者不保留任何角色。
- 部署后运行验收脚本，逐项检查角色持有者、时间锁成员、延迟、参数、白名单为空，结果存档。

### 5.2 BscVaultV2（BSC，持有真 USDT）

- 直接持有 BSC-USDT（`0x55d398326f99059fF775485246999027B3197955`），**不用 Stargate LP，不用 EOA 储备钱包**。
- 补水：负责人直接把 USDT 转到合约地址。

**放款状态机**（每个 `sourceId` 一条记录）：

```
None ──release()──────────────▶ Released            (小额：amount ≤ largeThreshold)
None ──queueRelease()─────────▶ Queued ──executeRelease()（≥ releaseDelay）──▶ Released
                                Queued ──cancelRelease()──▶ Cancelled
None/Queued ──voidSource()────▶ Voided              (永久禁止放款；WANTOS 退款的前提)
```

- `release` 和 `queueRelease` 都要求状态为 `None`，写入状态后才转账；`Cancelled` 和 `Voided` 永远不能再放款。
- **额度在 `release` 或 `queueRelease` 时扣除**；`cancelRelease`/`voidSource` 时退还。
- `executeRelease` 要求：状态是 `Queued`、已满 `releaseDelay`、合约未暂停、**收款地址仍在白名单**。
- 合约用传入的源链事件字段重新计算 `sourceId`，不信任调用方传入的 ID（编码见 §5.5）。

**入账方向**：`deposit(amount, wantosRecipient)`：
- 金额 ≥ `minDeposit`；`wantosRecipient` 不能是零地址。
- 按余额差额记账，不信任 `amount` 参数。
- 事件 `Deposited(nonce, from, wantosRecipient, amount)`，`nonce` 由合约递增。

### 5.3 WantosBridgeV2（WANTOS）

**跨出** `bridgeOut(amount)`，链上检查以下各项：
- `whitelisted[msg.sender]`；
- `msg.sender.code.length == 0`（不支持合约钱包和 EIP-7702 委托地址，因为同一地址在 BSC 上的控制人可能不同）；
- `minAmount ≤ amount ≤ maxPerTx`；
- 该地址滚动 24 小时额度没有用完，超出直接拒绝，资金不会锁进桥；
- `usdt.totalSupply() ≤ supplyCeiling`（部署时设为 3,000 万；一旦有人增发，跨出立即停止）；
- 按余额差额记账。

收款地址固定为 `msg.sender`（BSC 同地址）。每笔订单在链上存档：

```solidity
struct Order { address user; uint128 amount; uint64 createdAt; uint8 status; } // Locked / Refunding / Refunded
mapping(uint256 => Order) public orders;   // orderId = 合约递增 nonce
event BridgeOut(uint256 indexed orderId, address indexed user, uint256 amount);
```

**退款**（只用于被拒绝的订单）：
1. 先在 BSC 上 `voidSource(sourceId)`，等 BSC `finalized`。
2. 付款程序核验 BSC 上该 `sourceId` 的状态是 `Voided`。
3. 管理钱包调用 `requestRefund(orderId)` → 状态 `Refunding`；24 小时内白名单钱包可以取消。
4. 到期后 `executeRefund(orderId)`：只能退给 `orders[orderId].user`，金额 `orders[orderId].amount`，状态改为 `Refunded`。
5. 每日退款总额有上限；每笔都告警。

**入账方向（BSC→WANTOS）** `release(...)`：
- 由 WANTOS 的 RELAYER 调用；**不查白名单**（用户存的是真钱，无论是否开通都应该收到）。
- 收款地址是 BSC `Deposited` 事件里的 `wantosRecipient`。
- 有防重放、全局额度、每地址额度、大额排队，规则与 BSC 侧相同。
- 被攻破的 WANTOS 付款钥匙每天最多付出 `dailyCap`，而且伪造的入账找不到 BSC 存款事件，会被独立对账发现并自动暂停。
- 资金来源：WANTOS 桥合约余额 = 负责人注入的启动资金 + 用户跨出时锁进来的 USDT。

### 5.4 额度与参数（链上，两条链各一套）

| 参数 | 初值建议 | 硬编码上下限 | 说明 |
|---|---|---|---|
| `dailyCap`（全局滚动 24h） | 首批储备的 20% | 上限 50 万 | 24 个小时桶的滑动窗口 |
| `perAddrDailyCap`（每地址滚动 24h） | 2,000 | 上限 2 万 | 链上检查，不只在付款程序里 |
| `maxPerTx` | 2,000 | 上限 2 万 | 超过直接拒绝 |
| `largeThreshold` | 1,000 | ≤ `maxPerTx` | 超过走排队 |
| `releaseDelay` | 12 小时 | 下限 6 小时 | 排队等待时间 |
| `minAmount` / `minDeposit` | 10 | — | 防粉尘 |
| `refundDelay` | 24 小时 | 下限 12 小时 | 仅 WANTOS |
| `dailyRefundCap` | 1 万 | 上限 10 万 | 仅 WANTOS |

- 上下限只能靠升级修改。
- `dailyCap` 控制在**当前储备的 50% 以内**：储备下降时，管理钱包立即调低（收紧不需要等待）。
- 合约提供 `remainingDailyCap()` 和 `remainingAddrCap(addr)`，付款程序上链前先读，避免发出注定失败的交易。

### 5.5 `sourceId` 编码

```
sourceId = keccak256(abi.encode(
    "WANTOS-BSC-BRIDGE-V2",   // 域分隔
    srcChainId,               // 13555 或 56
    srcBridgeAddress,         // 发出事件的桥合约地址
    srcEventNonce,            // BridgeOut.orderId 或 Deposited.nonce（合约递增，不受区块重组影响）
    to, amount))
```

- 不用 `txHash` 和 `logIndex`：BSC 区块重组后它们可能变化，同一笔存款会被识别成两笔。
- 付款程序只处理 `log.address == 桥合约地址` 的事件。
- 旧订单补付使用单独的域分隔 `"LEGACY"`（§11）。

### 5.6 不变量（PR-1 每条都要有测试）

1. 白名单为空时，任何地址都无法 `bridgeOut`，BSC 也无法向任何地址放款。
2. 同一个 `sourceId`，"BSC 放款"和"WANTOS 退款"最多发生一个。
3. 任意 24 小时内，总放款（含已排队的）≤ `dailyCap`；任一地址 ≤ `perAddrDailyCap`。
4. 只有时间锁能升级、提取储备、放宽参数、更换钥匙；都要等满 48 小时；白名单钱包可以取消。
5. 四把钥匙两两不同；`WL` 只能经交接函数更换；`grantRole(WL)` 被拒绝。
6. 升级后白名单、订单、额度、储备数据不变；存储布局检查通过。
7. 暂停时 `release`、`executeRelease`、`bridgeOut`、`deposit` 全部不可用。
8. `applyWhitelistBatch` 只接受当前白名单钱包的签名；`nonce` 不能重放；签名不能跨链使用。
9. 交接：未满等待期、非指定地址、超过 7 天、零地址、与其他钥匙重复，全部被拒绝。
10. `totalSupply > supplyCeiling` 时 `bridgeOut` 被拒绝。

---

## 6. 付款程序 Relayer v2（服务器 A）

### 6.1 运行与密钥

- 服务器 A 由负责人指定，只有指定人员能登录；旧 relayer 的服务器和代码一律不复用。
- 两条链各一把付款钥匙，放在云 KMS（secp256k1 签名）。KMS 只能防止钥匙被拷走；能登录服务器的人仍然可以让它签名。**真正的防线是链上的白名单和额度。**
- 服务器上的 BNB 和 WANT 只放 3 天的 gas 用量。

### 6.2 数据来源

- **WANTOS**：自建一个非验证全节点作为主数据源；另用 rpc / rpc2 / rpc3 中的至少一个交叉核对。每笔订单的 receipt 必须在两个来源上一致。WANTOS 是单验证者 CometBFT 链，出块即最终；同时检查节点块高没有落后。
- **BSC**：至少两个独立 RPC 提供商；只处理 `finalized` 区块（取不到时，至少确认 15 块）；BSC 上的放款也要等 `finalized` 才记为 RELEASED。
- **自建交易索引**：付款程序自己索引 WANTOS 上 USDT / MG / TIDE 三种代币的 `Transfer` 事件和交易池的 `Swap` 事件，作为资金来源检查的主数据源。rpc3 上的 Blockscout 只用来交叉核对。

### 6.3 订单状态机

| 状态 | 进入条件 | 出口 |
|---|---|---|
| DETECTED | 看到 `BridgeOut` / `Deposited` | 风控评估 → 下列之一 |
| WAIT_INDEX | 索引高度 < 订单所在块 | 追上后重新评估；超过 10 分钟 → PENDING_REVIEW |
| WAIT_WHITELIST | BSC 上收款地址还不在白名单（两链不一致） | 一致后继续；超过 30 分钟告警 |
| WAIT_CAP | 全局或该地址额度用完 | 额度恢复后继续 |
| WAIT_RESERVE | 合约余额不足 | 补水后继续；立即告警 |
| PENDING_REVIEW | 命中审核规则 | 审核通过 → 继续；拒绝 → REJECTED；超过 72 小时必须处理 |
| HELD | 命中冻结规则 | 审核放行 → 继续；拒绝 → REJECTED |
| SUBMITTED | 交易已广播 | 已 finalized → RELEASED / QUEUED；回滚 → 按原因分类 |
| QUEUED | 已排队 | 到期执行 → SUBMITTED；被取消或地址被移出白名单 → REJECTED |
| RELEASED | 放款已 finalized | 终态 |
| REJECTED | 审核拒绝或排队被取消 | voidSource → REFUNDING |
| REFUNDING | 已作废、退款申请中 | 退款 finalized → REFUNDED |
| REFUNDED | 终态 | — |
| FAILED | 无法分类的错误 | 只能人工处理：重试或 REJECTED |

**回滚原因分类**：`sourceId` 已用 → 去查放款事件，标记 RELEASED；额度不足 → WAIT_CAP；余额不足 → WAIT_RESERVE；不在白名单 → WAIT_WHITELIST；其他 → FAILED。

### 6.4 可靠性

- `tx_attempts`：**签名后、广播前先落库**；加价替换会产生多个哈希，全部记录。
- `chain_cursor`：区块游标。
- 启动时：把库里的 nonce 和链上 `pending` nonce 对齐；从游标往回重扫 100 块。
- 单进程串行发送；交易卡住时同 nonce 加价替换（WANTOS 的 app mempool 对替换的行为需实测）。

### 6.5 数据库（PostgreSQL）

```sql
create table orders (
  source_id bytea primary key, direction text not null,          -- W2B | B2W | LEGACY
  src_chain int not null, src_event_nonce numeric not null, src_tx_hash bytea not null,
  user_addr bytea not null, to_addr bytea not null, amount_wei numeric(78,0) not null,
  status text not null, reasons jsonb, review_sigs jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table tx_attempts (id bigserial primary key, source_id bytea, chain_id int, nonce bigint,
  tx_hash bytea, gas_price numeric, raw_tx bytea, state text, created_at timestamptz default now());
create table chain_cursor (chain_id int primary key, last_processed_block bigint);
create table controlled_set (addr bytea primary key, label text, since_block bigint, added_at timestamptz default now());
create table audit_log (id bigserial primary key, actor text, action text, payload jsonb, at timestamptz default now());
```

白名单**以链上为准**，库里不存白名单的"权威副本"，只缓存链上事件。

---

## 7. 风控：资金来源检查

白名单挡住了陌生地址；这一层防"受控资金转给白名单用户代跨"。

- **受控来源集合**：附录 A 的地址，加上**旧金库 `0x8dFd` 在切换时刻 T 之后的转出**。管理后台可以增删，每次操作都写审计日志。
- **追溯**：每笔跨出前，用自建索引回溯该地址近 30 天的入账，追 2 跳。
  - 经过交易池时**跟着交易者走**：同一笔交易里，交易者卖进池子的币如果来自受控来源，换出来的币也算受控。
  - 三种代币按 USDT 价值统一折算（MG、TIDE 用池子的时间加权价格）。
  - 第 2 跳扇出超过 50 个地址 → PENDING_REVIEW。
- **判定**：受控来源占比 ≥ 20% → HELD；5%～20% → PENDING_REVIEW；< 5% 放行。
- **行为规则**：
  - 地址首次收到资金后 10 分钟内跨出，且金额 ≥ 500 → PENDING_REVIEW；
  - 同一来源在 24 小时内资助 ≥ 3 个地址跨出 → 全部 PENDING_REVIEW 并告警。
- **降级**：索引不可用或落后时，只停止**自动放行**（订单进入 WAIT_INDEX），不放松任何规则。
- **对外不公开**：受控集合和检查结果只在管理后台显示，用户页面的接口只返回订单状态和剩余额度，避免被人试探阈值。
- **局限**（写明）：场外交易（他把币卖给白名单用户，对方再跨出）只能部分拦住，兜底靠每地址额度和监控。

---

## 8. 两个站点

### 8.1 用户跨链页 `bridge.wanto.pro`

- 功能：连接钱包、开通状态、两个方向跨链、订单状态、今日剩余额度。**不包含任何管理功能。**
- 钱包：TP 钱包 / MetaMask / OKX 的 DApp 浏览器（EIP-1193 / EIP-6963）；电脑用插件或 WalletConnect v2。没有 WANTOS 网络时一键添加（chainId 13555，RPC `https://rpc.wantos.io`，浏览器 `https://scan.wantos.io`）。
- 未开通："跨链未开通，请联系客服"。
- 交易目标只能是两个桥合约和 USDT 合约；授权时用**精确金额**，不用无限授权。
- 页脚固定显示两条链的桥合约地址，用户可以核对。
- 技术栈：Vite + React + viem + wagmi。

### 8.2 管理后台 `admin.wanto.pro`（独立站点，暂定名）

独立的 Cloudflare Pages 项目和独立子域名，和用户页面**不共用代码包、不共用部署**。

| 页面 | 功能 | 谁能操作 |
|---|---|---|
| 白名单管理 | 上传地址（CSV / TXT / 粘贴）→ 校验、去重、剔除合约地址 → 逐行显示参考信息（网体、上级、风险标记、历史跨出、余额）→ 选择**添加或移除** → 显示 `listHash` → 白名单钱包签名 → 按顺序提交两条链；当前白名单列表、批次记录、两链不一致补齐 | 白名单钱包签名 |
| 时间锁面板 | 两条链所有待执行的提议：内容解码、新实现地址和代码差异链接、倒计时、**取消按钮** | 管理钱包、白名单钱包 |
| 交接 | 发起管理钱包 / 白名单钱包交接；生成交接链接；查看状态；取消 | 负责人 |
| 交接链接页 `/handover` | 新持有人证明地址 → 等待 → 接收或执行 | 被指定的新地址 |
| 订单审核 | PENDING_REVIEW / HELD 订单：命中规则、资金来源路径；通过或拒绝（审核员用钱包签 EIP-712 审批消息，付款程序验签） | 审核员名单 |
| 储备与对账 | 两条链余额、今日放款、额度使用、对账结果、告警记录 | 只读 |
| 参数 | 收紧参数（立即生效）；放宽参数（生成时间锁提议） | 管理钱包 |

风险标记只是提示，不自动过滤：🔴 受控来源集合；🟠 可疑名单 / 资金来源命中；🟡 不在网体内。🔴 行默认不勾选，需要二次确认。

### 8.3 离线 `listHash` 核对工具

- 一个单文件的开源小工具（HTML 或命令行），在**另一台设备**上离线运行：读入原始地址文件 → 校验、排序 → 输出 `listHash`。
- 负责人签名前，比对"工具算出的 `listHash`"和"钱包签名界面显示的 `listHash`"，一致才签；每批的 `listHash` 记入负责人自己的离线台账。
- 这一步保证即使管理后台被篡改，也无法让负责人签下被加料的地址列表。

### 8.4 Cloudflare 与供应链

- 两个站点都在 Qbit 账户；账户启用硬件安全密钥两步验证。
- 管理后台加 Cloudflare Access（邮箱验证码或 IP 白名单）：作用是**防窥视**，不是安全边界；真正的权限只认钱包签名。
- `/handover` 不放在 Access 后面：被指定的新持有人可能在钱包 DApp 浏览器里打开，过不了邮箱验证码；页面只读链上数据，安全由合约保证。
- 强制 HTTPS、HSTS、`Content-Security-Policy`（只允许本站脚本、两条链 RPC、WalletConnect 中继）。
- 部署令牌只给 CI、最小权限；依赖锁定；每次发布的产物哈希在两个独立渠道公布。

---

## 9. 独立监控 Watcher（服务器 B）

- 和付款程序**不同服务器、不同钥匙、不读付款程序的数据库**：自己用至少两个 RPC 读两条链事件做对账。
- 持有 **PAUSER**（只能暂停）。
- 告警通道：Telegram 或企业微信机器人 + 电话升级，至少两人接收；写明值班表。

### 9.1 对账（每小时）

```
WANTOS 桥余额 = 启动资金 + ΣBridgeOut − Σrelease(B2W) − ΣexecuteRefund − Σwithdraw
BSC 金库余额  = Σ补水 + ΣDeposited − ΣReleased − Σwithdraw
每个 BridgeOut 订单在 BSC 上对应的 sourceId 状态一致（None / Queued / Released / Cancelled / Voided）
每个 BSC Released / WANTOS release 都能找到对应的源链事件（旧单补付对应补付清单）
```

### 9.2 告警与自动暂停

| 事件 | 级别 | 动作 |
|---|---|---|
| 某笔放款找不到源链事件（任一条链） | 紧急 | **PAUSER 自动暂停两条链** |
| WANTOS-USDT `totalSupply` 增加 | 紧急 | 自动暂停（合约也会拒绝跨出） |
| 出现白名单批次，但负责人的离线台账里没有这个 `listHash` | 紧急 | 自动暂停（台账同步方式见 PR-6） |
| 时间锁出现新提议（任何内容） | 高 | 推送解码后的内容和取消入口；**48 小时内必须审阅** |
| 发起 / 取消 / 完成交接；`updateDelay` 提议 | 高 | 推送 |
| 合约升级已执行 | 高 | 推送 |
| 储备 < 1 天用量 / < 0.5 天用量 | 高 / 紧急 | 推送补水 |
| WANTOS 桥余额偏低 | 高 | 推送 |
| 当日放款达到 `dailyCap` 的 70% | 中 | 推送 |
| 新的排队放款；排队即将到期 | 中 | 推送，附撤销入口 |
| 受控来源集合中任一地址有资金动作；`0x8dFd` 有转入或转出；旧付款程序 `0x9dab` 有新交易 | 高 | 推送 |
| 订单停在 WAIT_* / PENDING_REVIEW 超过时限；白名单两链不一致超过 30 分钟 | 中 | 推送 |
| 自建索引或节点落后、WANTOS 出块停滞、各 RPC 块高不一致 | 高 | 推送 |
| 付款程序心跳中断、nonce 与链上不一致、KMS 签名失败、gas < 3 天 | 中 | 推送 |
| 退款申请、作废来源 | 中 | 推送 |
| 对账任务失败或没有运行 | 高 | 推送 |

---

## 10. 储备

- **BSC 侧**：负责人直接把 USDT 转到 BscVaultV2。上线初期白名单从空开始，流量会远低于历史水平（旧桥日净流出约 1 万）。首批建议 1～2 万，`dailyCap` 设为储备的 20%～50%，按实际流量调整。
- **WANTOS 侧**：负责人直接把 WANTOS-USDT 转到 WantosBridgeV2，用于 BSC→WANTOS 方向付款。金额由负责人决定；余额低于阈值时告警，B2W 订单进入 WAIT_RESERVE。
- 每日报表：两条链的期初余额、跨入、放款、退款、补水、期末余额。
- 两个方向流量不对等（出多进少）是业务问题，桥只负责防盗。

---

## 11. 旧桥处置与迁移

**Phase 0（现在就做，不依赖新桥）**
1. 旧 BSC 金库 `0xec6e`、旧储备钱包、补水钱包 `0xe1e8`，**不再注入任何资金**。
2. 公告旧桥停用和旧网址作废。旧前端在原技术人员的账户里，公司下线不了，只能靠公告。
3. 旧 WANTOS 金库 `0x8dFd` 没有暂停：如果公司有 owner `0x7afc` 的私钥就暂停；没有的话，明确记为"旧金库无法暂停"，靠公告和监控。
4. 定一个**切换时刻 T**：T 之前未放款的旧订单列入补付清单；T 之后存进 `0x8dFd` 的资金按公告的政策处理（建议逐笔人工核实后补付）。
5. 尽量查清 `0x9dab` 旧付款程序运行在哪台机器上并停掉。
6. **WANTOS-USDT 合约 `0xc74F` 的 owner 权限审计**（开工前必须完成）：逐个函数核对 owner 除增发外是否还能销毁、冻结、强制转账。如果能动桥合约里锁的币，本文档要写出对策。
7. **验证者节点的信任假设**：WANTOS 是单验证者链，控制验证者的人理论上可以伪造事件。核实原技术人员是否接触过验证者私钥，必要时轮换。

**旧订单补付**
- 单独设 `direction = 'LEGACY'`，`sourceId = keccak256(abi.encode("LEGACY", oldTxHash, logIndex))`。
- 放款前查旧 BSC 金库 `0xec6e` 的放款记录，确认旧桥没有付过。
- 订单发起地址也必须先被录入白名单；放款走审核。
- 对账单单列"旧单补付"，资金来源是 BSC 新储备，WANTOS 侧没有对应的锁币。

**第一批白名单**：合约部署时为空。我提供参考名单（Magellan 网体 3,927 个地址，附风险标记），**由负责人筛选后在管理后台上传、签名写入**。

---

## 12. 应急手册（谁、多久、能挡到什么程度）

| 场景 | 攻击者能做什么 | 应对 | 结果 |
|---|---|---|---|
| **付款钥匙泄露**（一条链） | 只能付给白名单地址（WANTOS 入账方向除外），每天 ≤ `dailyCap`，每地址 ≤ `perAddrDailyCap`；伪造的放款找不到源链事件 | 监控发现后自动暂停（分钟级）；管理钱包立即调低额度；经时间锁更换付款钥匙（48h） | 损失 ≤ 发现前的放款额，远小于 `dailyCap` |
| **暂停钥匙泄露** | 只能暂停（拒绝服务） | 管理钱包解除暂停；经时间锁更换 | 无资金损失 |
| **管理钱包泄露** | 提议升级、提取、放宽参数、换钥匙——全部要等 48h；可以立即解除暂停、立即收紧参数（只会更安全） | 白名单钱包在 48h 内**逐条取消**；攻击者可以反复提议，每条都要取消 | 资金安全；但升级和提取会一直被对峙。**最坏情况：合约无法再升级、储备无法提取，但资金不会被拿走** |
| **白名单钱包泄露** | 可以往白名单加地址（拿钱还要经过付款流程，受额度约束）；可以取消正常的时间锁提议 | 管理钱包或 PAUSER 立即暂停 | 资金安全；**最坏情况：桥长期处于暂停** |
| **管理钱包 + 白名单钱包同时泄露** | 全部权力 | 无法阻止 | 这是唯一的单点；两个钱包必须分开保管（不同设备、不同地点、助记词分开备份） |
| **管理后台网站被篡改** | 诱导签错的白名单批次 | 离线 `listHash` 核对（§8.3）；台账不一致自动暂停 | 不签就没有损失 |
| **付款程序服务器被攻破** | 等同付款钥匙泄露，外加可以篡改它自己的数据库 | 监控在另一台服务器、读链上事件，不受影响 | 同第一行 |

**钥匙备份与恢复**：两个钱包的助记词分开、离线、异地备份；每季度演练一次"用备份恢复钱包并签一条测试消息"。

---

## 13. 开发计划（PR 拆分）

| PR | 内容 | 验收 |
|---|---|---|
| PR-0 准备 | §11 Phase 0 第 6、7 项的审计结论；钥匙仪式文档（四把钥匙怎么生成、谁持有、怎么备份） | 结论写进本文档 |
| PR-1 合约 | BscVaultV2、WantosBridgeV2、时间锁配置、部署脚本、部署后验收脚本 | §5.6 十条不变量全部有测试；升级、交接、额度、退款、白名单签名的正反用例；覆盖率 ≥ 95%；`slither` 无高危 |
| PR-2 外部审计 | 合约冻结后送审；与 PR-3～PR-7 并行 | 高危、中危全部修复；修复后 PR-9 重跑 |
| PR-3 付款程序 | 自建节点与索引、状态机、`tx_attempts`、游标、回滚分类、多 RPC 校验 | 故障注入：断网、重启、签名后广播前崩溃、BSC 重组、重复事件、交易卡住、额度不足、余额不足、两链白名单不一致 |
| PR-4 风控 | 资金来源检查（跟随换币、价值折算、扇出上限）、行为规则、降级 | 10 月真实数据回放：`0x2835`、`0x0b74`、`0xbdc4` 被拦；"受控资金卖进池子换出后转给白名单用户"的模拟用例被拦 |
| PR-5 用户页 | `bridge.wanto.pro` | 未开通被拒、两个方向跨链、订单状态显示 |
| PR-6 管理后台 + 离线工具 | `admin.wanto.pro` 全部页面、交接链接页、`listHash` 离线工具、离线台账同步给监控的方式 | 篡改页面后签名的批次被离线核对拦下；非白名单钱包无法写入；两链部分成功可补齐 |
| PR-7 监控 | 服务器 B、对账、告警、PAUSER 自动暂停 | §9.2 每条告警在测试网演练一次 |
| PR-8 迁移与旧单 | 切换时刻 T、旧订单补付清单与流程、公告 | 补付不重复（与旧桥放款记录核对） |
| PR-9 测试网联调 | WANTON 实验链（chainId 1345，需确认有索引）+ BSC 测试网全链路 | 端到端 100 笔，含 §12 每个应急场景的演练 |
| PR-10 主网上线 | 部署（白名单为空）→ 验收脚本 → 负责人导入第一批白名单 → 两侧注资 → 灰度 | 72 小时对账零差异 |

各 PR 先落规划文档再实施；合并需负责人明确批准。

---

## 14. 待决事项

1. 公司现在实际掌握哪些旧私钥：`0x9272`、`0x9dab`、`0x7afc`、`0xf974`、`0xc081`、`0xcca4`、`0xe1e8`、4 个储备钱包。
2. `0xc74F` owner 权限审计结论（PR-0）。
3. 付款程序服务器 A、监控服务器 B 放在哪里。
4. 订单审核员名单（现阶段是否只有负责人一人；HELD 放行是否需要第二人）。
5. 额度初值（§5.4）。
6. WANTOS 侧启动资金金额。
7. 管理后台域名是否就用 `admin.wanto.pro`。

---

## 附录 A：受控来源集合（初版，需负责人逐条确认）

> 用途：①管理后台录入白名单时红色提示，防止误录；②资金来源检查。

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
