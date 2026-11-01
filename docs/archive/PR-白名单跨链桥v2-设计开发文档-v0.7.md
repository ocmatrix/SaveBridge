# PR 规划：白名单跨链桥 v2（WANTOS ↔ BSC USDT）设计开发文档

> 版本 v0.7（2026-11-01）｜状态：**待评审**，未开工（负责人指示：先不开工）
> v0.2 变更：改为**严格白名单（默认拒绝）**，去掉 v0.1 的 T1～T3 分级。
> v0.3 变更（负责人 11-01 拍板）：
> - 合约部署时**白名单为空**，不预置任何地址（网体用户、公司地址、测试地址都不带）。
> - **只有负责人本人**能添加和移除白名单：使用一个**新建的专用钱包**，在白名单导入网页上手动上传地址、用自己的钱包签名写入。网体关系只作参考（网体里也可能有老鼠仓），**不自动开通**。
> - **两条链都写**白名单；移除也只能由负责人操作，取消守护者的紧急移除权限。
> - 去掉 v0.2 的"推荐人报备 → 审核后台 → 白名单服务自动上链"，新增 §6 白名单导入网页。
> v0.4 变更（负责人 11-01 拍板）：两条链的桥合约改为**可升级**（UUPS 代理），**管理员地址可更换**。升级和更换管理员都必须经过 48 小时时间锁，负责人专用钱包可以取消任何待执行的升级或管理员变更（见 §4.0）。
> v0.5 变更（负责人 11-01 拍板）：**管理员（ADMIN）暂由负责人一人担任**，不用多签；以后交接给管理团队时，通过"更换管理员"把 ADMIN 转给团队多签（见 §4.0 交接流程）。
> v0.6 变更（负责人 11-01 拍板）：管理钱包和白名单钱包**用两个不同的钱包**；**白名单钱包也可以更换**；新增**交接链接页**（§6.6）——现任持有人发起交接后生成链接，新持有人用自己的钱包打开链接签名接收。
> v0.7 变更（负责人 11-01 拍板）：前端域名定为 **`bridge.wanto.pro`**，部署在 Cloudflare（§6.7）。
> 依据：2026-10-31 ~ 11-01 对旧桥的链上只读诊断（储备枯竭、权限地址、10 月出金追踪）
> 目标读者：接手跨链桥的开发、运维和项目负责人

---

## 0. 一句话目标

用一套**全新的钥匙和合约**替换旧桥，并实行**严格白名单：默认所有地址都不能跨出**，只有负责人本人手动录入白名单的地址才能跨。做到三点：

1. 原技术人员手里可能残留的私钥，**拿不走新桥里的任何一分钱**。
2. 他手里的 WANTOS 资产（包括 `0xf974`、LP `0xcca4` 等）所在地址不在白名单里，**一分钱也跨不出去**；换新地址也没用，新地址不会被负责人录入。
3. 团队照常发展：新用户的地址由负责人在白名单导入网页上批量录入后即可跨链。

---

## 1. 背景：旧桥现状与问题

### 1.1 旧桥结构（链上实测）

| 角色 | 地址 | 说明 |
|---|---|---|
| WANTOS 金库（可升级代理） | `0x8dFd39E98f478688A41Cdbe40bc544d672F0A9E3` | 用户跨出时把 WANTOS-USDT 锁在这里（现约 94.9 万），owner=`0x7afc…c3ad`，升级管理员属于 `0x9272` |
| BSC 金库（可升级代理） | `0xeC6E356a2E986D6A9b103217B9d215c8a6F37139` | owner 和升级管理员都是 `0x9272…9502`；本身不存钱 |
| 付款程序（relayer） | `0x9dAb17a9Ad061cbDA2BeF607A6A330EE74076E90` | 两条链上调用 `unlockToken(address,uint256,bytes32,uint256)`（`0x999d73d2`）放款；**2026-11-01 13:04 仍在运行，运行位置不明** |
| BSC 储备 | 4 个普通钱包，持有 Stargate LP（S*USDT），给金库无限授权 | 放款时从这些钱包拉 LP → 赎回 USDT；现已枯竭（0.95） |
| 补水钱包 | `0xe1e817a6df4da07f0a031b52146e39668c36ff10` | 运营方从交易所提币 → 存 Stargate → LP 记到储备钱包 |
| WANTOS-USDT | `0xc74F2e7fBdA2af9D1fc26b85E341229063Dc0873` | owner `0xc081…f003` 可增发；04-15 一次性发行 3,000 万后未再增发 |

### 1.2 旧桥的根本问题

| 问题 | 后果 |
|---|---|
| 付款私钥一把就能给任意地址放款，且只受单笔/每日限额约束 | 私钥泄露 = 储备随时被提走，封地址无效 |
| 金库可升级，升级权在一个普通钱包（`0x9272`） | 一笔升级交易就能把金库改成任意逻辑 |
| 储备放在普通钱包（EOA）里 | 储备钱包私钥泄露 = 直接转走 |
| 放款没有任何身份/来源检查 | 受控资金可以换个新地址直接跨出（10-30 `0x2835` 先养号、30 秒内跨出 5,000） |
| 两个方向流量严重不对等，靠人工补水 | 跨出（要付真钱）是跨入的约 11 倍；不补就枯竭 |
| 旧 relayer 代码里硬编码私钥（`relayer.js:19`） | 私钥随代码、备份扩散，无法确认谁手里有 |

### 1.3 需要防住的资产（威胁面）

| 受控来源 | 规模 | 新桥对策 |
|---|---|---|
| `0xf974…7c4b` | 25,318,440 WANTOS-USDT | 来源检查 → 冻结；不能靠黑名单 |
| MG 池 LP `0xcca4…3ec1`（EOA，从未发过交易） | 可撤出 56,313 USDT + 78,769 MG | 来源检查 |
| `0xeabd…0bb4` | 9,880 万 MG（卖进池子可抽干 MG 池） | 来源检查 + 告警 |
| 合约 `0x778b`、`0x7fd9`（升级权在 `0x9272`） | 合计 96.5 万 MG | 来源检查 |
| 合约 `0xb7f4`（暂停中，升级权在 `0x9272`） | 148,037 USDT | 来源检查 |
| `0x1447`、`0xe49d`、`0xb7a4`、`0x765b`、`0xe2dd`、TIDE 发行地址 `0x6317` 等 | 合计约 9 万 USDT 及代币 | 来源检查 |
| USDT owner `0xc081` | 可无限增发 | 增发监控；见 §11 待决 |

完整地址见附录 A。

---

## 2. 设计原则

1. **钥匙全新、权限分散**：新合约的管理权交给管理员（现阶段为负责人本人，交接后为团队多签），付款钥匙只能"在限额内放款"，没有任何一把钥匙能单独拿走全部储备。
2. **可以升级，但不能偷偷升级**：合约可升级、管理员可更换，但升级和更换管理员都要先在链上公告、等满 48 小时才能执行，期间会告警，负责人可以取消。旧桥的问题是一个钱包一笔交易就能升级，新桥不允许这样。
3. **白名单上链、默认拒绝**：白名单写在两条链的桥合约里。WANTOS 上不在白名单的地址调用 `bridgeOut` 直接失败，钱不会被锁进桥；BSC 上即使付款钥匙泄露，也只能付给白名单地址。
4. **白名单只由负责人手动录入**：部署时为空；网体关系、可疑名单只在导入网页上作参考提示，是否录入由负责人决定。公司自有地址（LP、做市、运营钱包）默认不录入。
5. **白名单钥匙只在负责人手里**：使用新建的专用钱包，私钥不上任何服务器，网页只调用钱包签名；和付款钥匙完全分开，任何一把单独泄露都不能把钱付给陌生地址。
6. **拦不住也要限住、看得见**：白名单地址也有每日额度和大额延迟；任何异常每天最多损失一个可控额度，并且实时告警。

---

## 3. 总体架构

```
 ┌────────────── WANTOS 链 ──────────────┐            ┌─────────────── BSC 链 ───────────────┐
 │                                        │            │                                       │
 │  用户 ──bridgeOut()──▶ WantosBridgeV2  │            │  BscVaultV2（可升级·48h时间锁，持有USDT）│
 │                        (锁 WANTOS-USDT)│            │   ├ release()   ← 只能付款程序调用    │
 │                        ▲ release()     │            │   ├ 单笔上限 / 每日总上限（链上）     │
 │                        │ (BSC→WANTOS)  │            │   ├ 大额 → queue，延迟后才能执行      │
 └────────────────────────┼───────────────┘            │   └ 暂停 / 撤销排队 ← 守护者          │
                          │                            │  用户 ──deposit()──▶（BSC→WANTOS）    │
                          │                            └───────────────▲───────────────────────┘
                 ┌────────┴────────────────────────────────────────────┴────────┐
                 │                   付款程序 Relayer v2（公司自有服务器）       │
                 │  监听事件 → 风控引擎 → 放款 / 延迟 / 人工审核 / 拦截        │
                 │  ├ 白名单（只读两条链合约；负责人在导入网页手动写入）        │
                 │  ├ 每地址每日额度、全桥每日额度                              │
                 │  ├ 资金来源检查（受控地址集合，2-3 跳）                      │
                 │  └ 状态机 + 幂等 + nonce 管理                                │
                 └──────┬───────────────────────┬───────────────────────┬───────┘
                        │                       │                       │
                 平台后台（白名单同步）    审核后台（人工审核）      监控告警（Telegram/企业微信）
```

**管理权分层：**

| 角色 | 持有者 | 能做什么 | 不能做什么 |
|---|---|---|---|
| ADMIN（**现阶段 = 负责人本人钱包**，地址可更换；交接后改为团队多签） | 负责人本人（硬件钱包） | 改限额、换付款钥匙、换守护者、提取储备（经时间锁）、**提议升级**、**提议更换管理员** | 直接升级（必须经 48 小时时间锁）、改白名单 |
| 时间锁（合约） | 每条链一个 `TimelockController` | 48 小时后执行升级 | 跳过等待 |
| RELAYER（付款钥匙，单签热钱包） | 付款程序服务器 | 在限额内放款；大额只能排队 | 改限额、提储备、绕过延迟 |
| WHITELIST（白名单钥匙，单签） | **负责人本人新建的专用钱包**（硬件钱包或手机钱包，私钥不上任何服务器） | 批量添加 / 移除白名单地址 | 放款、改限额、暂停 |
| GUARDIAN（守护者，单签） | 现阶段 = 负责人本人；交接后可另设值班人 | **暂停**、撤销排队中的大额放款 | 放款、解除暂停（解除需多签）、改白名单 |

- 两条链的 WHITELIST 角色授给**同一个专用钱包地址**，负责人一个钱包管两条链。
- WHITELIST 角色**只授给这一个地址**；部署脚本里不授给部署者、不授给付款程序、不授给任何服务器钥匙。
- 白名单钱包更换走两步交接（§4.0）；专用钱包丢失时由 ADMIN 发起交接，泄露时 ADMIN 可先暂停合约再发起交接。

---

## 4. 合约设计

### 4.0 升级与管理员更换（两条链相同）

**结构**：每条链一个 UUPS 代理 + 一个 OpenZeppelin `TimelockController`（延迟 48 小时）。

```
             提议升级 / 提议换管理员                 48 小时后执行
ADMIN ──────────────────────────────▶ 时间锁合约 ─────────────────────▶ 桥合约（UUPS 代理）
                                         ▲
负责人专用钱包 ─── 取消（CANCELLER） ─────┘
```

| 操作 | 谁能发起 | 生效条件 | 谁能取消 |
|---|---|---|---|
| 升级合约逻辑 | ADMIN 向时间锁提议 `upgradeToAndCall` | 等满 48 小时，任何人可触发执行 | ADMIN、**负责人白名单专用钱包** |
| 更换管理员（ADMIN） | 现任 ADMIN 发起 `beginDefaultAdminTransfer(新地址)` | 等满 48 小时，**新管理员自己调用 `acceptDefaultAdminTransfer` 确认接收** | 现任 ADMIN（`cancelDefaultAdminTransfer`）；时间锁期间告警推送给负责人 |
| 更换白名单钱包（WHITELIST） | 现任白名单钱包或 ADMIN 调用 `beginWhitelistManagerTransfer(新地址)` | 等满 48 小时，**新地址自己调用 `acceptWhitelistManagerTransfer()`** | 现任白名单钱包、ADMIN（`cancelWhitelistManagerTransfer`） |
| 更换时间锁本身的提议人/执行人 | 只能通过时间锁自己发起（同样 48 小时） | — | 同上 |

**约束（写进合约和测试）**：
- `_authorizeUpgrade` 只允许时间锁地址调用；ADMIN、部署者、付款程序都不能直接升级。
- 管理员更换用 `AccessControlDefaultAdminRules`：同一时间只能有一个管理员，必须两步完成，带 48 小时延迟。
- 白名单钱包同样**同一时间只有一个**：`WHITELIST_ROLE` 不用 `grantRole` 直接授予，改为合约自带的两步交接（发起 → 48 小时 → 新地址接收）；接收成功时自动撤销旧地址。`grantRole(WHITELIST_ROLE, …)` 在合约里直接禁止。
- 交接期间旧持有人仍然有效，直到新地址接收的那一刻才切换，不会出现无人管理的空档。
- 升级只能换逻辑，不能清空状态：存储布局用 OpenZeppelin 的 ERC-7201 命名空间存储；每次升级前跑 `openzeppelin-foundry-upgrades` 的存储布局兼容检查，不兼容就拒绝。
- 新实现合约必须**先在浏览器开源验证**，再提议升级；告警消息里附上新旧实现的代码差异链接。
- 白名单数据保存在代理的存储里，升级不会丢失；但新逻辑理论上可以改变白名单规则，所以**负责人必须在 48 小时内审阅每一次升级提议**，不认可就取消。
- 部署时，时间锁的 PROPOSER 只授给 ADMIN，CANCELLER 授给 ADMIN 和负责人白名单专用钱包，EXECUTOR 设为任何人（到期后谁都能触发，防止被卡）。时间锁自己的管理员权限在部署后立即放弃。

**现阶段与交接流程**：

- 现阶段：ADMIN、时间锁 PROPOSER、GUARDIAN 都是负责人本人的**管理钱包**；时间锁 CANCELLER 是管理钱包 + 白名单专用钱包。
- 交接给管理团队时（两条链各做一遍）：
  1. 团队先建好多签（BSC 用 Safe；WANTOS 部署 Safe，见 §4.3）。
  2. 负责人调用 `beginDefaultAdminTransfer(团队多签)`，告警推送。
  3. 等满 48 小时，团队多签调用 `acceptDefaultAdminTransfer()` 接收 ADMIN。
  4. 通过时间锁（同样 48 小时）把 PROPOSER 角色授给团队多签，并撤销负责人管理钱包的 PROPOSER。
  5. GUARDIAN、RELAYER 按交接方案重新授予。白名单权限是否同时交接，由负责人另行决定（`WHITELIST_ROLE` 由 ADMIN 授予和撤销）。
- 交接前后合约地址不变、白名单和储备不变，用户无感。
- **建议管理钱包和白名单专用钱包用两个不同的钱包**：白名单钱包日常频繁签名，管理钱包很少用、可以离线保管，泄露其中一个不会两样权力同时丢失。

### 4.1 BscVaultV2（BSC，核心）

- **可升级（UUPS，见 §4.0）**，直接持有 BSC-USDT（`0x55d398326f99059fF775485246999027B3197955`），**不再用 Stargate LP，不再用 EOA 储备钱包**。
- 基于 OpenZeppelin Upgradeable v5：`AccessControlDefaultAdminRulesUpgradeable` + `PausableUpgradeable` + `ReentrancyGuardUpgradeable` + `UUPSUpgradeable` + `SafeERC20`。

```solidity
// 角色
bytes32 constant RELAYER_ROLE  = keccak256("RELAYER_ROLE");
bytes32 constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
// DEFAULT_ADMIN_ROLE = 管理员（现阶段负责人本人钱包；交接后团队多签），由 AccessControlDefaultAdminRules 管理

// 参数（ADMIN 可改，改动发事件）
uint256 public maxPerTx;          // 单笔上限，例 5,000e18
uint256 public dailyCap;          // 全桥 24h 放款上限，例 20,000e18（按 UTC 日或滑动窗口）
uint256 public largeThreshold;    // 超过即必须排队，例 2,000e18
uint256 public releaseDelay;      // 排队延迟，例 12 hours
uint256 public withdrawDelay;     // ADMIN 提取储备的时间锁，例 48 hours

mapping(bytes32 => bool) public usedSources;   // 防重放：keccak(srcChainId, srcTxHash, srcLogIndex)

// 白名单：部署时为空；只有 WHITELIST 角色（负责人专用钱包）能增删
bytes32 constant WHITELIST_ROLE = keccak256("WHITELIST_ROLE");
mapping(address => bool) public whitelisted;
uint256 public whitelistCount;
function setWhitelist(address[] calldata addrs, bool allowed) external onlyRole(WHITELIST_ROLE);
function beginWhitelistManagerTransfer(address newManager) external;   // 现任白名单钱包或 ADMIN
function cancelWhitelistManagerTransfer() external;                    // 现任白名单钱包或 ADMIN
function acceptWhitelistManagerTransfer() external;                    // 只能由 pending 新地址调用，且 >= 48h
function pendingWhitelistManager() external view returns (address newManager, uint48 acceptableAt);
event WhitelistManagerTransferStarted(address indexed current, address indexed pending, uint48 acceptableAt);
event WhitelistManagerTransferred(address indexed oldManager, address indexed newManager);
//   单批上限 200 个地址（防 gas 超限）；拒绝 address(0)；重复设置不报错但不重复计数
event WhitelistUpdated(address indexed addr, bool allowed, address indexed by, bytes32 indexed batchId);
// batchId = 网页生成的批次号（导入文件的 keccak），便于和网页操作记录对账

// 构造函数：constructor(address admin, address whitelistManager, address relayer, address guardian, ...)
//   - 不接受任何初始白名单参数；部署后 whitelistCount == 0
//   - whitelistManager 必须不同于 relayer 和 guardian（构造时检查）

// BSC → WANTOS：用户存入
function deposit(uint256 amount, address wantosRecipient) external whenNotPaused;
event Deposited(address indexed from, address indexed wantosRecipient, uint256 amount, uint256 nonce);

// WANTOS → BSC：小额直接放款
function release(bytes32 sourceId, address to, uint256 amount)
    external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant;
//   require(whitelisted[to]);   // 收款地址必须在白名单内（queueRelease / executeRelease 同样检查）
//   require(!usedSources[sourceId]); require(amount <= maxPerTx && amount <= largeThreshold);
//   _consumeDailyCap(amount); usedSources[sourceId]=true; USDT.safeTransfer(to, amount);
event Released(bytes32 indexed sourceId, address indexed to, uint256 amount);

// 大额：排队 → 延迟后执行；守护者可撤销
function queueRelease(bytes32 sourceId, address to, uint256 amount) external onlyRole(RELAYER_ROLE) whenNotPaused;
function executeRelease(bytes32 sourceId) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant; // block.timestamp >= queuedAt + releaseDelay
function cancelRelease(bytes32 sourceId) external onlyRole(GUARDIAN_ROLE);
event ReleaseQueued(bytes32 indexed sourceId, address indexed to, uint256 amount, uint256 executableAt);
event ReleaseCancelled(bytes32 indexed sourceId);

// 紧急
function pause() external onlyRole(GUARDIAN_ROLE);
function unpause() external onlyRole(DEFAULT_ADMIN_ROLE);

// 储备提取：只有 ADMIN，且经时间锁
function scheduleWithdraw(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE);
function executeWithdraw(uint256 id) external onlyRole(DEFAULT_ADMIN_ROLE);  // >= withdrawDelay
```

**关键不变量（测试必须覆盖）：**

1. 只有时间锁合约能升级，且必须等满 48 小时；`_authorizeUpgrade` 只认时间锁地址。实现合约本身调用 `_disableInitializers()`，不能被单独初始化。
2. **钱只能付给白名单地址**：RELAYER 单独泄露时无法付给陌生地址；WHITELIST 单独泄露时无法放款。两者同时泄露，也受下一条的每日上限约束。部署后白名单为空，只有 WHITELIST 角色能改，ADMIN 和 GUARDIAN 都不能直接改白名单。
3. RELAYER 24 小时内最多放出 `dailyCap`；单笔大额必须等满 `releaseDelay`，执行时再次检查白名单，期间守护者可撤销。
4. 同一个 `sourceId` 只能放款一次（排队和直接放款共用 `usedSources`）。
5. 储备只能由 ADMIN 经 `withdrawDelay` 时间锁提走；守护者可在时间锁期间暂停合约来阻止。
6. 暂停后 `release` / `executeRelease` / `deposit` 全部不可用。

**补水方式**：公司从交易所提币 → **直接转账到 BscVaultV2 合约地址**。不需要任何签名，也不经过中间钱包。

### 4.2 WantosBridgeV2（WANTOS）

- 可升级（UUPS，见 §4.0），持有 WANTOS-USDT。
- 用户跨出：

```solidity
mapping(address => bool) public whitelisted;   // 与 BSC 侧内容一致，同一个后台批量写两条链
function setWhitelist(address[] calldata addrs, bool allowed) external onlyRole(WHITELIST_ROLE);

function bridgeOut(uint256 amount) external whenNotPaused;   // require(whitelisted[msg.sender])；收款地址 = msg.sender（BSC 同地址）
event BridgeOut(address indexed user, uint256 amount, uint256 nonce);
```

  - **不在白名单的地址调用 `bridgeOut` 直接失败**（revert `NotWhitelisted`），钱留在用户自己钱包里，不会锁进桥。前端在发起前先读 `whitelisted(addr)`，未开通时提示"跨链未开通，请联系客服"。
  - **BSC 收款地址固定等于发起地址**，不允许指定别的地址，杜绝"白名单地址替陌生地址收款"。
  - 跨出的 WANTOS-USDT 锁在合约里，不销毁（WANTOS-USDT 不由桥增发）。
- BSC → WANTOS 入账：`release(bytes32 sourceId, address to, uint256 amount)`，角色、限额和防重放与 BSC 侧对称。
- 被拒绝订单的退款：`refund(bytes32 bridgeOutId)`，**只能退回原发起地址**，由 ADMIN 调用（见 §6.4）。

### 4.3 多签（交接时使用，现阶段不部署）

- **BSC**：直接使用 Safe（Gnosis Safe）官方部署。
- **WANTOS**：先确认链上是否已有 Safe 工厂/单例合约（chainId 13555）。如果没有，在 WANTOS 上部署 Safe v1.4.1 官方合约（`SafeProxyFactory` + `Safe` + `CompatibilityFallbackHandler`），并用相同的签名人建同构多签。
- 签名人：建议 3 人、门槛 2；每人使用独立的硬件钱包；**任何签名人都不能是原技术人员接触过的设备或助记词**。

---

## 5. 付款程序 Relayer v2

### 5.1 运行与密钥

- 部署在**公司自有、只有指定人员能登录的服务器**上。旧 relayer 的服务器和代码一律不复用。
- 付款钥匙：新生成，**不写进代码或配置文件**。优先放云 KMS（AWS KMS / 腾讯云 KMS 的 secp256k1 签名）；退一步用加密 keystore + 启动时手工输入口令。
- 两条链各一把付款钥匙（BSC、WANTOS 分开），泄露一把不影响另一条链。
- 服务器上的 BNB / WANT 只放 gas 用量，低于阈值告警。

### 5.2 处理流程（WANTOS → BSC）

```
监听 BridgeOut 事件（WANTOS 确认 ≥ 3 块）
  → 写入 orders 表（状态 DETECTED；sourceId = keccak(13555, txHash, logIndex)，唯一索引）
  → 风控引擎评估 → 得出 decision：
       AUTO      → 调 release()（小额）                         → 状态 RELEASED
       DELAY     → 调 queueRelease()，到点自动 executeRelease()   → QUEUED → RELEASED
       REVIEW    → 进审核队列，不上链                             → PENDING_REVIEW
       HOLD      → 冻结，通知负责人                               → HELD
  → 上链后等待 BSC 回执（确认 ≥ 15 块），失败按 §5.5 重试
```

BSC → WANTOS 方向同理（监听 `Deposited` → WANTOS `release`）。这个方向是真钱进来，**不要求白名单**（任何人都能把 USDT 存进来），只做防重放和限额；但跨进来以后，想再跨出去仍然必须在白名单里。

### 5.3 风控规则（全部是可配置参数，下表是建议初值）

**① 白名单（唯一的准入条件，见 §6）**

| 地址状态 | 能否跨出 | 说明 |
|---|---|---|
| 在白名单内 | 能 | 负责人在导入网页手动录入 |
| 不在白名单内（含所有孤立地址、新生成地址、公司自有 LP/做市/运营地址，以及**未被录入的网体用户**） | **不能** | WANTOS 合约直接拒绝，不产生订单 |
| 在白名单内，但同时在受控地址集合中 | 不能 | 一律 HOLD 并告警；导入网页在录入前已红色提示，正常不应出现 |

白名单地址统一额度（不分等级，可配置）：每地址每日 5,000；单笔超过 2,000 走 DELAY（排队 12 小时）。

**② 资金来源检查（第二道防线：防"受控资金转给白名单地址代跨"）**

白名单挡住了陌生地址，但他仍可能把钱转给某个已在白名单里的人代为跨出。所以白名单地址的每笔跨出仍要检查资金来源：

- 维护**受控地址集合**（附录 A，可在审核后台增删）。
- 每笔跨出前，用 WANTOS 浏览器数据库（rpc3 上 Blockscout 的 Postgres，**只读账号**）回溯该地址近 30 天的 USDT / MG / TIDE 入账，追 2 跳（第 3 跳可选）。
  - 交易池（MG 池 `0x787c`、TIDE 池 `0xdf2a`、路由 `0xDC88`）**不向下传播**：池子里的 USDT 是混合的，追溯停在交易者本人。
  - 计算"受控来源占比" = 来自受控集合的金额 ÷ 该地址近 30 天总入账。
- 判定：占比 ≥ 20% → HOLD；5%～20% → REVIEW；< 5% 放行。
- 性能：只查跨出地址本人和它的直接来源，单次查询走 `token_transfers_to_address_hash_block_number_index`，实测单地址毫秒级到秒级；设置 `statement_timeout=10s`，**超时视为 REVIEW**，不放行。

**③ 行为规则**

| 规则 | 动作 |
|---|---|
| 地址首次入账到跨出间隔 < 10 分钟，且金额 ≥ 500 | REVIEW |
| 同一来源地址 24 小时内资助 ≥ 3 个地址跨出 | 这些订单全部 REVIEW，并告警 |
| 同一笔跨出命中多条规则 | 取最严格的动作 |

**④ 全局额度**

- 全桥每日放款额度：链下设为链上 `dailyCap` 的 80%，留 20% 给人工审核通过的订单。
- 储备余额 < 2 天用量时，单地址每日额度自动减半，并告警补水。

### 5.4 数据库（PostgreSQL）

```sql
create table orders (
  source_id      bytea primary key,         -- keccak(srcChainId, txHash, logIndex)
  direction      text not null,             -- 'W2B' | 'B2W'
  src_tx_hash    bytea not null,
  src_log_index  int   not null,
  src_block      bigint not null,
  user_addr      bytea not null,
  amount_wei     numeric(78,0) not null,
  whitelist_batch bytea,                    -- 放款时该地址所属的白名单批次（来自 whitelist_mirror）
  decision       text,                      -- AUTO|DELAY|REVIEW|HOLD
  reasons        jsonb,                     -- 命中的规则及数值
  status         text not null,             -- DETECTED|QUEUED|PENDING_REVIEW|HELD|SUBMITTED|RELEASED|REJECTED|REFUNDED|FAILED
  dst_tx_hash    bytea,
  reviewed_by    text, reviewed_at timestamptz, review_note text,
  created_at     timestamptz default now(), updated_at timestamptz default now()
);
create index on orders(user_addr, created_at);
create index on orders(status);

-- 白名单以链上合约为准；以下两张表只是导入网页的记录和索引，不能决定任何地址能否跨链
create table whitelist_batches (               -- 每次上传 = 一个批次
  batch_id       bytea primary key,            -- 上传文件内容的 keccak
  action         text not null,                -- ADD | REMOVE
  file_name      text, addr_count int not null,
  signer         bytea not null,               -- 签名钱包（必须是专用钱包）
  tx_wantos      bytea, tx_bsc bytea,          -- 两条链的写入交易
  status         text not null,                -- DRAFT|WANTOS_DONE|BOTH_DONE|PARTIAL|FAILED
  note           text,
  created_at     timestamptz default now()
);
create table whitelist_mirror (                -- 由事件监听从链上 WhitelistUpdated 回填
  addr           bytea primary key,
  on_wantos      boolean not null, on_bsc boolean not null,
  last_batch_id  bytea, updated_at timestamptz
);

create table controlled_set (addr bytea primary key, label text, added_by text, added_at timestamptz default now());
create table daily_usage   (addr bytea, day date, released_wei numeric(78,0), primary key(addr, day));
create table audit_log     (id bigserial primary key, actor text, action text, payload jsonb, at timestamptz default now());
create table nonce_state   (chain_id int primary key, next_nonce bigint);
```

### 5.5 可靠性

- **幂等**：`source_id` 主键 + 合约 `usedSources` 双重保证，同一笔永远不会付两次。
- **nonce**：单进程串行发送，nonce 落库；交易卡住时同 nonce 加价替换，不重新分配 nonce。
- **重启恢复**：从 `orders` 表恢复，并从最后确认块往回重扫 100 块补漏。
- **对账**（每小时）：WANTOS 侧 `BridgeOut` 总额 − 已放款 − 审核中/冻结 = 0；BSC 侧 `Released` 必须一一对应 `orders`，**出现链上有、库里没有的放款立即暂停合约并告警**（这意味着付款钥匙泄露）。

---

## 6. 白名单导入网页与人工审核

### 6.1 原则

- 合约部署后白名单为空。**唯一的写入入口是这个网页 + 负责人专用钱包的签名**。
- 网页本身没有任何写权限：它只负责解析文件、展示参考信息、拼交易，最后由负责人的钱包签名发出。网页服务器被攻破，也写不进白名单。
- 网体关系、可疑名单、受控地址只在页面上作**提示**，不自动过滤、不自动通过，录不录由负责人决定。

### 6.2 页面功能

**① 连接钱包**
- 支持 MetaMask / TP 钱包（WalletConnect）。
- 连接后检查当前地址是否持有两条链合约的 `WHITELIST_ROLE`；不是专用钱包时，页面只读，不显示任何写入按钮。

**② 上传地址（添加或移除）**
- 支持 CSV / TXT / 直接粘贴，每行一个地址，可带备注列。
- 自动处理：去空格、统一校验和格式（EIP-55）、去重；非法地址、零地址、合约地址单独列出，不进入待写入列表。

**③ 预览与参考信息（逐行展示）**

| 列 | 内容 |
|---|---|
| 地址 | — |
| 当前状态 | WANTOS 是否已在白名单、BSC 是否已在白名单（已在的自动跳过） |
| 网体信息 | 是否在 Magellan 网体内、当前有效上级、层级、团队人数（读 ReferralRegistry + ParentOverride） |
| 风险提示 | 🔴 命中受控地址集合（附录 A）；🟠 命中可疑名单（孤立跨出账户、10 月可疑套现、直接跨出 >1000）；🟠 资金来源检查命中受控资金（§5.3 ②）；🟡 不在网体内 |
| 历史跨出 / 当前余额 | WANTOS-USDT |

- 负责人可以逐行勾选或取消；🔴 行默认不勾选，需要手动勾上并二次确认。
- 页面底部汇总：本批添加 N 个，其中 🔴 x 个、🟠 y 个、🟡 z 个。

**④ 签名写入（两条链）**
- 按 200 个地址一批拆分。
- 每批先写 WANTOS（`setWhitelist(addrs, true)`），成功后再写 BSC；页面引导钱包切换网络。
- 两条链都成功，该批才算完成；只成功一条时，页面标记 PARTIAL，并提供"补写另一条链"按钮。
- 移除流程完全相同，调用 `setWhitelist(addrs, false)`。

**⑤ 当前白名单与操作记录**
- 白名单列表以**链上事件为准**（`WhitelistUpdated` 回填 `whitelist_mirror`），可按地址搜索、导出 CSV。
- 两条链不一致的地址（一边有、一边没有）标红，提供一键补齐。
- 批次记录：时间、操作（添加 / 移除）、地址数、两条链的交易哈希、签名钱包。

### 6.3 部署与访问

- 网页是纯前端静态页面 + 一个只读查询接口（网体信息、风险提示、资金来源检查），部署在 `bridge.wanto.pro/admin/whitelist`（§6.7），**不放在原技术控制的任何账户**（例如 mgfound.online 的 Cloudflare 账户）。
- 只读接口不需要登录即可访问也不会泄露资金，但建议加 IP 白名单或简单的访问口令，防止名单被外人查看。

### 6.4 用户体验

| 场景 | 用户看到的 |
|---|---|
| 未开通 | 跨链按钮置灰，提示"跨链未开通，请联系客服" |
| 已开通 | 正常跨链，显示今日剩余额度 |
| 单笔大额 | "大额到账需 12 小时"，到点自动到账（期间可被撤销） |
| 被移除 | "跨链权限已关闭，请联系客服" |

### 6.5 订单审核后台

- **订单审核**：PENDING_REVIEW / HELD / QUEUED，显示命中规则、资金来源路径（逐跳地址和金额）、浏览器链接。
- 操作：通过（→ 放款或排队）、拒绝（→ 状态 REJECTED，进入退款流程）、加入或移出受控集合。
- **订单审核后台不能修改白名单**，移除白名单只能回到导入网页由负责人签名。
- HOLD 订单放行需要 2 人确认；所有操作写 `audit_log`。
- 退款：拒绝的订单由 ADMIN 在 WANTOS 侧调用 `refund`，资金只能退回原地址。

### 6.6 交接链接页（管理钱包、白名单钱包通用）

**用途**：更换管理员或白名单钱包时，现任持有人发起交接，把链接发给新持有人，新持有人用自己的钱包打开链接签名接收。

**流程**：
1. 现任持有人在管理页面连接钱包，选择"交接管理员"或"交接白名单钱包"，填入新地址，**两条链各签一次发起**（`beginDefaultAdminTransfer` / `beginWhitelistManagerTransfer`）。
2. 页面生成交接链接，例如 `https://bridge.wanto.pro/handover?role=whitelist&to=0x新地址`。链接里**不含任何签名或密钥**，只是一个指向页面的地址。
3. 新持有人用 TP 钱包或 MetaMask 的 DApp 浏览器打开链接：
   - 页面读取两条链合约上的待接收地址和可接收时间；**当前连接的钱包不是被指定的地址时，不显示接收按钮**。
   - 显示两条链的合约地址（供核对，防钓鱼）、发起人、倒计时。
   - 缺少 WANTOS 网络时，提示一键添加（chainId 13555，RPC `https://rpc.wantos.io`）。
4. 到时间后，新持有人点击"接收"，两条链各签一次（`acceptDefaultAdminTransfer` / `acceptWhitelistManagerTransfer`）。两条链都完成才算交接成功；只完成一条时显示"补签另一条链"。
5. 48 小时内现任持有人可在管理页面取消，取消后链接立即失效。

**安全要点**：
- 链接本身没有权力，被转发、泄露都无法抢权；权力来自现任持有人在链上的指定。
- 新持有人需要在两条链上各有少量 gas（WANT、BNB）。
- 交接发起、取消、完成都会触发告警（§7）。
- 页面只部署在 `bridge.wanto.pro`，和白名单导入网页同一个站点。

### 6.7 前端部署：`bridge.wanto.pro`

**站点结构**（同一个 Cloudflare Pages 项目，纯静态页面）：

| 路径 | 页面 | 使用者 |
|---|---|---|
| `https://bridge.wanto.pro/` | 跨链页面：连接钱包、开通状态、两个方向跨链、订单状态、今日剩余额度 | 所有用户 |
| `https://bridge.wanto.pro/admin/whitelist` | 白名单导入网页（§6.2） | 只有白名单钱包能写入，其他钱包只读 |
| `https://bridge.wanto.pro/handover` | 交接链接页（§6.6） | 被指定的新管理员 / 新白名单钱包 |
| `https://bridge.wanto.pro/admin/review` | 订单审核后台（§6.5） | 审核员 |

**钱包连接**：
- 手机：TP 钱包、MetaMask、OKX 钱包的 DApp 浏览器打开链接，使用钱包注入的 provider（EIP-1193 / EIP-6963）。
- 电脑：浏览器钱包插件；或用 WalletConnect v2 扫码连接手机钱包。
- 页面检测到钱包里没有 WANTOS 网络时，调用 `wallet_addEthereumChain` 一键添加（chainId 13555，RPC `https://rpc.wantos.io`，备用 rpc2 / rpc3，浏览器 `https://scan.wantos.io`）。
- 技术栈建议：Vite + React + viem + wagmi（带 WalletConnect 连接器）。

**Cloudflare 配置**：
- `wanto.pro` 已托管在 Cloudflare（NS：`abdullah.ns.cloudflare.com` / `elle.ns.cloudflare.com`）。**上线前必须确认这个 zone 在负责人自己的 Cloudflare 账户里**，而不是原技术人员的账户（他的 `mgfound.online` 使用的是另一组 NS：`dom` / `luciana`）。
- Pages 项目、DNS 记录、部署令牌全部在负责人账户下；部署令牌只给 Pages 编辑权限，用完可撤销。
- `/admin/*` 和 `/handover` 用 Cloudflare Access 加一层访问控制（邮箱验证码或 IP 白名单）：不影响链上安全（写入权限只认钱包），但能防止名单和管理入口被外人查看。
- 开启 HTTPS 强制跳转、HSTS；响应头加 `Content-Security-Policy`（只允许本站脚本、两条链的 RPC、WalletConnect 中继），防止页面被注入恶意脚本改签名内容。
- 只读查询接口（网体信息、风险提示、资金来源检查、订单状态）用 Cloudflare Worker 转发到付款程序服务器的只读 API，不直连数据库。

**防钓鱼**：
- 上线时在官方渠道公告**唯一网址 `bridge.wanto.pro`**，并提醒旧桥链接作废。
- 页面页脚固定显示两条链的桥合约地址，用户可以对照浏览器核对。
- 页面发起的每笔交易，`to` 只能是这两个桥合约地址和 USDT 合约（授权用），前端代码里写死，不从接口读取。

## 7. 监控与告警

| 告警 | 阈值（初值） | 级别 |
|---|---|---|
| BSC 储备余额 | < 2 天平均放款量 | 高 |
| 链上出现 `Released` 但库里没有对应订单 | 任何一笔 | **紧急：自动暂停** |
| 合约角色、参数变更事件（`RoleGranted`/`RoleRevoked`/参数事件） | 任何一次 | 高 |
| `ReleaseQueued` | 每次推送，附撤销入口 | 中 |
| 当日放款达到 `dailyCap` 的 70% | — | 中 |
| HOLD 订单 | 每笔 | 中 |
| 受控集合中任一地址有资金动作（含 `0xf974` 转出、LP `0xcca4` 撤池、`0xeabd` 转出 MG） | 任何一笔 | 高 |
| WANTOS-USDT 发生增发（从 `0x0` 转出） | 任何一笔 | **紧急** |
| 时间锁出现新的提议（`CallScheduled`，升级或参数变更） | 任何一笔，附新实现地址和取消入口 | **高：推送负责人，48 小时内必须审阅** |
| 发起 / 取消 / 完成更换管理员或白名单钱包 | 任何一次 | **高** |
| 合约升级已执行（`Upgraded`） | 任何一次 | 高 |
| 链上出现 `WhitelistUpdated`，但导入网页没有对应批次记录 | 任何一笔 | **紧急：自动暂停**（意味着专用钱包被他人使用） |
| 任何一次白名单变更 | 每批推送：添加/移除数量、两条链交易哈希 | 中（负责人自己核对） |
| WANTOS 与 BSC 两边白名单不一致超过 1 小时 | — | 中 |
| Relayer 心跳 / 积压订单数 / gas 余额 | 心跳 > 2 分钟 / 积压 > 20 / gas < 3 天 | 中 |
| 旧桥 `0x9dab` 在 BSC 或 WANTOS 上的新交易 | 任何一笔 | 中（用于掌握旧钥匙动向） |

推送渠道：Telegram 或企业微信机器人，至少两名负责人接收。

---

## 8. 储备管理

- 储备只存在 BscVaultV2 合约里，没有中间钱包。
- **分批注资**：每批 = 1～2 天净流出。按近期实测（48 小时跨出 21,910、跨入 1,665，日净流出约 1 万），首批建议 **1～2 万**，之后按告警补。
- 每日报表：期初储备、跨入、放款、补水、期末储备，以及 WANTOS 侧锁仓量。
- 长期：两个方向流量不对等的问题桥本身解决不了，需要业务侧决定（例如限制 WANTOS-USDT 的产出、手续费、额度）。见 §11。

---

## 9. 旧桥处置与迁移

**Phase 0（立即，不依赖新桥）**

1. **旧 BSC 金库 `0xec6e` 不再注入任何资金**，旧储备钱包和 `0xe1e8` 也不再补钱。
2. 前端立即下线旧桥入口，并公告跨链维护。旧 WANTOS 金库 `0x8dFd` **现在没有暂停**（`paused=false`），用户仍能往里存，但存了拿不到钱。如果公司有 owner `0x7afc` 的私钥就调用暂停；没有就只能靠前端拦。
3. 盘点旧桥未放款订单（10-31 时 22 笔、2,451.63 USDT，之后又有新增），导出完整清单。
4. 确认 `0x9dab` 付款程序运行在哪台机器上，确认后停掉。

**Phase 1～5（新桥）**：见 §10 PR 拆分。

**未放款订单的处理**：新桥上线后，按清单逐笔走审核后台（REVIEW）。**订单发起地址也必须先由负责人录入白名单**，审核通过后才从新桥放款，并在 `orders` 表中用旧交易哈希登记，防止重复。

**第一批白名单**：合约部署时为空。我只提供参考名单（Magellan 网体 3,927 个地址，附风险提示），**由负责人自行筛选后在导入网页上传、签名写入**；之后的新用户同样由负责人分批录入。

---

## 10. 开发计划（PR 拆分）

| PR | 内容 | 产出 | 验收 |
|---|---|---|---|
| PR-1 合约 | BscVaultV2、WantosBridgeV2（UUPS）+ 两条链的 TimelockController，Foundry 工程 | 合约 + 单元测试 + 部署脚本 | §4.1 不变量全部有测试；升级测试：非时间锁升级被拒、未满 48 小时被拒、负责人钱包可取消、升级后白名单和储备数据不变、存储布局检查通过；更换管理员和白名单钱包测试：两步完成、未满延迟被拒、非指定地址接收被拒、可取消、接收后旧地址失效、`grantRole(WHITELIST_ROLE)` 被拒；覆盖率 ≥ 95%；`slither` 无高危 |
| PR-2 钥匙与权限 | 负责人管理钱包、白名单专用钱包、付款钥匙、守护者的地址登记；两链时间锁部署（团队多签留到交接时再做） | 地址清单 + 时间锁地址 | 各角色只授给登记地址，部署者不残留任何角色 |
| PR-3 Relayer 核心 | 事件监听、状态机、幂等、nonce、对账 | 服务 + DB 迁移 | 断网、重启、重复事件、交易卡住四种故障注入全部通过 |
| PR-4 风控引擎 | 额度、来源检查、行为规则 | 规则模块（表驱动测试） | 用 10 月真实数据回放：`0x2835`、`0x0b74`、`0xbdc4` 必须被拦；受控资金转给白名单地址代跨的模拟用例必须被拦 |
| PR-5 前端站点 `bridge.wanto.pro`（跨链页 + 白名单导入页 + 交接链接页）| 钱包连接与角色检查、交接发起/取消/接收、文件解析、网体与风险提示、两链分批签名写入、补写、移除、事件回填、批次记录 | 静态页面 + 只读查询接口 | 非专用钱包看不到写入按钮；两链部分成功可补齐；🔴 地址需二次确认；链上与页面记录一致 |
| PR-6 订单审核后台 + 告警 | 订单审核、双人放行、告警机器人 | 页面 + 机器人 | §7 每条告警各演练一次；审核后台无法修改白名单 |
| PR-7 测试网联调 | WANTON 实验链（chainId 1345）+ BSC 测试网全链路 | 联调报告 | 端到端 100 笔，含未录入白名单被拒、大额排队、撤销、暂停、退款、移除白名单 |
| PR-8 外部审计 | 合约审计 | 审计报告 | 高危、中危全部修复 |
| PR-9 灰度上线 | 主网部署（白名单为空）→ 角色授给负责人专用钱包 → 负责人导入第一批白名单 → 首批储备 1～2 万 | 上线记录 | 部署后 `whitelistCount==0` 且 WHITELIST 角色只有专用钱包；运行 72 小时对账零差异 |

各 PR 先落规划文档再实施，合并需负责人明确批准。

---

## 11. 待决事项（需要负责人拍板）

1. **公司现在实际掌握哪些私钥？** `0x9272`、`0x9dab`、`0x7afc`、`0xf974`、`0xc081`、`0xcca4`、`0xe1e8`、4 个储备钱包。这决定 Phase 0 能做到哪一步。
2. **WANTOS-USDT 的增发权（`0xc081`）**：如果公司有这把钥匙，建议转给多签或放弃增发权；如果没有，他理论上可以无限增发。新桥的来源检查能拦住增发出来的币，但要不要发行新版 USDT 并按快照迁移，需要决策。
3. **交接时的团队多签签名人名单**（现阶段不需要）。
4. **额度初值**：§5.3 和 §4.1 的数字只是建议，需要结合业务量确认。
5. **两个方向流量不对等的业务解法**：桥只能防盗，不能解决"出多进少"。
6. **公司自有资金的出口**：公司自有地址一律不进白名单。公司确实需要把 WANTOS 上的资金换回 BSC 时，建议不走桥，而是由多签直接从 BSC 储备按账目处理，并留审计记录。
7. ~~升级权和管理员~~：已定，ADMIN 暂由负责人一人担任，交接时转给团队多签。
8. **负责人专用钱包**：由负责人自己新建（建议硬件钱包），只把**地址**告诉开发方用于授予角色；私钥和助记词任何人都不经手。需要在两条链上各留少量 gas（WANT、BNB）。
9. **订单审核员**：名单、是否双人审核、每日处理时效。

---

## 附录 A：受控地址集合（初版，需负责人逐条确认）

> 严格白名单下，这些地址本来就不在白名单里、跨不出去。这份集合的用途是两条：①导入网页上红色提示，防止误录；②资金来源检查时，识别"受控资金转给白名单地址代跨"。

| 地址 | 说明 |
|---|---|
| `0x9272f360b98160c1662abb6d2df9e4f313b39502` | 旧桥 owner 与升级管理员；10-17～10-26 升级 `0x778b` 10 次 |
| `0x9dab17a9ad061cbda2bef607a6a330ee74076e90` | 旧付款程序 |
| `0x7afc830d90f3080dc754618a9e4f71775815c3ad` | 旧 WANTOS 金库 owner |
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
| 合约 `0x778b7d2c…d6`、`0x7fd935d5…24`、`0xb7f476ce…1f` | 升级权在 `0x9272` |
| `0xf974` 历史上直接转过钱的 79 个地址 | 见 `plat_out.csv`，建议先列为 REVIEW 级而不是直接冻结 |

## 附录 B：已有分析材料

- `孤立跨出账户_候选清单.csv`：252 个孤立跨出账户（全历史）
- `10月MG卖出套现明细_含可疑标注.csv`：10 月 MG 卖方 1,284 个，含可疑等级
- `10月直接跨出超1000_孤立地址.csv`：10 月直接跨出超过 1,000 的孤立地址 3 个
- `WANTOS_USDT_散户持仓_ge1.csv`：USDT 持仓分布

以上 CSV 可直接作为 `controlled_set` 和风控回放测试的输入。
