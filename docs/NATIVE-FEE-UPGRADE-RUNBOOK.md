# SaveBridge 跨链手续费：升级部署手册（落稿 v0.1，2026-11-04）

> 状态：**方案落稿，未执行**。本文不授权任何链上动作。凡标【G】的步骤，都要负责人在对话里逐项明确说「执行」才能做，授权不外推到下一步。
> 范围：**只做手续费升级**。不碰白名单业务、gas 补给、节点清单、付款程序配置、旧桥（BSC 上另一套 `0xe2fD…4AD5`）。发现范围外的问题只报告，不处理。
> 规范依据：`docs/SPEC-NATIVE-FEE-v1.md`（规则）、`docs/NATIVE-FEE-APP-FLUTTER.md`（App 接口）、本文（怎么上线）。

---

## 0. 一页纸总览

| 阶段 | 做什么 | 链上写入 | 授权 | 需要等 |
|---|---|---|---|---|
| P0 | 冻结代码、全部测试、本地分叉演练、监控改造完成 | 无 | 否 | — |
| P1 | 两条链各部署一个**新实现合约**（不动线上代理） | 有（部署者发 2 笔） | **G1** | — |
| P2 | 管理钱包在两条链**提议升级**（进时间锁排队） | 有 | **G2** | 48 小时 |
| P3 | 到期后**执行升级**，逐项核对状态没变 | 有 | **G3** | — |
| P4 | 发布新版用户页（Cloudflare）；App 新版提交上架 | 无链上写入 | **G4** | App 上架时间 |
| P5 | 管理钱包**提议开启手续费**（写收款地址与费率） | 有 | **G5** | 48 小时 |
| P6 | 到期后**执行配置**，用真实小额交易验证 | 有 | **G6** | — |

**核心安全事实（已核实）：**
1. 升级只有时间锁能做，**排队的 48 小时里线上仍是旧合约，所有功能照常**。
2. 升级执行后手续费配置为空，**默认不收费**：`deposit`、`bridgeOut` 虽然变成 `payable`，旧调用方式（不带 `value`）照样成功。
3. 时间锁执行升级后会做自检（`_checkBridgeSane`）：新实现丢了必要视图、或进入异常状态，**整笔执行回滚**，不会把治理搞坏。
4. 手续费新增的存储放在两个新的独立命名空间，**不改动原有存储**，回滚到旧实现不会破坏数据。
5. 管理钱包可以**立即关闭手续费**（`disableNativeFee()`，不用等时间锁）。

**拟定决定（需你在 G1 前确认）：D1 = 升级与配置分两步，各走一次 48 小时。** 好处：升级后可先观察、先发布前端，再开费；任何一步出问题都只影响一步。代价：总共要等约 4 天。若要打包成一个批量提案（只等 48 小时，升级一执行手续费就生效），见 §12。

---

## 1. 现场基线（2026-11-04 只读核实）

两条链的桥代理地址相同，下表对 BSC（链 56）和 WANTOS（链 13555）都成立，除标注外两链一致。

| 项目 | 值 |
|---|---|
| 桥代理（用户交互地址） | `0x41e9900BF09553C46b6b3F267626FDa2b4711E44` |
| 当前实现 | `0x668698E8683167F412550aEA9D72537435176297`（两链相同） |
| 时间锁 | `0xE962600e3F9c608Cf7E0e80aB450ffE63b563618`（两链相同），延迟 **172800 秒（48 小时）** |
| 管理钱包（唯一提议人） | `0x860f5B29f60F86c82b18f789E0219Cf966375669` |
| 白名单钱包（可取消提案） | `0x8F36C2b951ff9Cc752844d50460e1e3D51EaF4A9` |
| `paused()` | 两链均为 false |
| 白名单批次号 `whitelistNonce` | 17（会随白名单操作变化，升级前以现场读取为准） |
| 实现字节码 | BSC 22,432 字节、WANTOS 21,594 字节 |

**基线源码核对（已做）：** 把 `origin/main`（提交 `5045e02`）的 `contracts/src` 用同一编译设置编译，与链上实现逐字节比对：长度完全相同；差异只有 4 处——3 处各 20 字节（UUPS 的 immutable 自身地址）和末尾 32 字节（元数据哈希），两链一致。**结论：线上实现 = main 源码，没有夹带未评审的改动。** 升级新实现 = main 源码 + 本次手续费改动（只改 `BscVaultV2.sol`、`WantosBridgeV2.sol`，`BridgeBase.sol` 不变）。

两链的 USDT 都是 **18 位小数**（BSC USDT、WANTOS-USDT），手续费档位的金额边界按 18 位小数写（见 §8）。收款地址 `0xADCDe89431978C79ef66956Cfed67ac925426957` 在两条链上都**没有合约代码**（普通钱包地址）。

---

## 2. 角色与要用到的钥匙

| 角色 | 用在哪一步 | 说明 |
|---|---|---|
| **新部署者 EOA** | P1 | 全新生成、nonce 为 0、干净设备上生成，两链各发 1 笔部署（所以两条链上的实现地址会相同）。部署完退回余额、销毁钥匙。**不复用任何旧部署者**（nonce 已不为 0，不符合 runbook 要求） |
| 管理钱包（硬件钱包） | P2、P5；紧急关闭费用 | 只由负责人本人签名，我不接触 |
| 任意有 gas 的账号 | P3、P6 | 时间锁的执行人角色是开放的（任何人都能执行已到期的提案），可用管理钱包，也可用别的账号 |
| 白名单钱包 | 可选：发现问题时取消提案 | 在 TP 手机钱包里 |

**口令与钥匙的规矩：** 部署者钥匙口令由负责人自己输入终端，不在聊天里出现、不入文件、不进日志。管理钱包的签名在硬件钱包上完成。API key（区块浏览器验证用）由负责人自己放环境变量。

---

## 3. P0：准备（不上链，不需要授权）

每一步都有「通过标准」，一项不过不进入 P1。

### P0-1 冻结源码
- 合约代码以手续费分支 `native-fee-20261103` 为准（合约改动都在这个分支上，只改 `BscVaultV2.sol`、`WantosBridgeV2.sol`）。
- 冻结后记录：`git rev-parse HEAD` 与 `contracts/src` 目录内容哈希（见 §3 P0-3 命令）。冻结后合约源码再有任何改动，从 P0-1 重来。
- **通过标准：** 提交号和源码目录哈希写进本文末尾的「执行记录」。

### P0-2 全量合约测试
```bash
cd <仓库根>            # 含 lib/ 子模块的完整检出；数据放外接盘
forge test            # 全部应通过（上次：260 项，覆盖率 100%）
```
**通过标准：** 全绿；`StorageLayout.t.sol` 的存储布局核对（含 `layout/BscNativeFee.namespace.json`、`NativeFee.namespace.json`）通过——这条证明新字段没挤占旧存储。

### P0-3 编译产物指纹（部署后要对照）
```bash
forge build
# 本地实现的运行时字节码（去掉元数据尾部和 immutable 后比对用）
forge inspect BscVaultV2 deployedBytecode   > /tmp/bsc-impl.hex
forge inspect WantosBridgeV2 deployedBytecode > /tmp/wantos-impl.hex
find contracts/src -name '*.sol' | sort | xargs shasum -a 256 | shasum -a 256   # 源码目录哈希
```
记录两个字节码的长度和上面的目录哈希。

### P0-4 本地分叉演练（BSC）
目的：在真实线上状态上预演「升级 → 不收费照常 → 开费 → 收费」，提前发现意外。

```bash
# 数据放外接盘；关闭 anvil 的磁盘缓存，避免内置盘被占满
anvil --fork-url https://bsc-rpc.publicnode.com --no-storage-caching --port 8546 &
# 记下 pid，结束时只按这个 pid 结束，不要用 pkill -f
```
演练脚本要做的事（用 `cast` 完成，全部在 anvil 里，不上链）：
1. 部署新实现；用时间锁地址 impersonate（`cast rpc anvil_impersonateAccount`）调用 `upgradeToAndCall(newImpl, 0x)`。
2. 升级后读：`paused`、`whitelistNonce`、`params()`、`whitelisted(...)` 抽样、`depositNonce`、代理的 USDT 余额，与升级前逐项相同。
3. `quoteNativeFee(50000000)` 应为 0；用一个测试账号 `deposit` 不带 `value` 应成功。
4. impersonate 时间锁调 `setNativeFeeConfig(0xADCD…, 50)`；`quoteNativeFee(50000000)` 应为 `500000000000000`（0.0005 BNB）；`deposit` 带 `value=0.0006 BNB`、legacy `gasPrice=0.05 gwei`，收款地址增加 0.0005 BNB，发起人退回 0.0001 BNB。
5. `disableNativeFee()`（impersonate 管理钱包）后报价回到 0。

**WANTOS 链说明：** `rpc3.wantos.io` 对单个请求限流（并发会 429），anvil 分叉会发大量单请求，很可能被拦。**分叉演练失败不算红灯**：WANTOS 侧改动已有合约测试覆盖（`NativeFee.t.sol`，含升级后状态保留的 `WantosInvariants`），并且 P3 之后有逐项现场核对。如果要演练 WANTOS，只能在受控环境（自有 RPC 或独立沙盒）做。

**通过标准：** BSC 分叉演练 5 项全部符合预期，记录结果。

### P0-5 配套代码就位（部署前必须完成）
- [ ] **监控**认识 `NativeFeeCollected`、`NativeFeeConfigUpdated` 新事件（独立任务，需单独做、单独验证）。**必须在 P5 之前上线。**
- [ ] **用户页** bridge-web 新版（已完成，提交 `076d54c`）通过测试；是否加「报价失败按无手续费处理」的兼容，见 §12 D3。
- [ ] **App（Flutter）** 按 `NATIVE-FEE-APP-FLUTTER.md` 改好并提交上架。App 上架审核时间可能是整个流程里最慢的一环，**尽早启动**，**必须在 P6 之前让绝大多数用户升级到新版**。
- [ ] **管理页**用新 ABI 重新构建（见 §5.1）：否则时间锁页面看到 `setNativeFeeConfig` / `setNativeFeeTiers` 可能解不出来而标成「无法解码」。

---

## 4. P1：部署新实现【G1】

**授权前先确认：** D1（分两步）、部署者地址与 gas、使用的 RPC。

### P1-1 准备部署者
1. 在干净设备上生成全新 EOA（nonce 0），记下地址（**公开信息，可写进文档**）。
2. 两条链各转入少量 gas：BSC 约 0.01 BNB、WANTOS 约 5 WANT（实现合约约 22 KB，部署大约要 500 万 gas，这是我的估算、未实测；BSC 现价 0.05 gwei，实际花费远低于此，富余即可）。
3. 核对：两条链上这个地址的 nonce 都是 0。
```bash
cast nonce <部署者地址> --rpc-url <BSC RPC>
cast nonce <部署者地址> --rpc-url https://rpc3.wantos.io
```

### P1-2 部署（逐链，先 BSC 后 WANTOS）
实现合约的构造函数无参数（只做 `_disableInitializers()`），所以：
```bash
# BSC（链 56）。口令由负责人在终端自己输入
forge create contracts/src/BscVaultV2.sol:BscVaultV2 \
  --rpc-url <BSC RPC> --keystore <部署者钥匙文件> --broadcast
# WANTOS（链 13555）
forge create contracts/src/WantosBridgeV2.sol:WantosBridgeV2 \
  --rpc-url https://rpc3.wantos.io --keystore <部署者钥匙文件> --broadcast
```
两笔都是各自链上部署者的第 1 笔交易，所以**两条链上的新实现地址应当相同**。如果不同，停下来查原因再继续。

### P1-3 部署后核对（必须全部通过）
```bash
NEW=<新实现地址>
# 1. 有代码，字节数与 P0-3 一致
cast code $NEW --rpc-url <RPC> | awk '{print (length($0)-2)/2}'
# 2. 是合法的 UUPS 实现：返回 EIP-1967 实现槽标识
cast call $NEW "proxiableUUID()(bytes32)" --rpc-url <RPC>   # 期望 0x360894a1...2bbc
# 3. 构造函数已锁定初始化（不能被人拿去初始化）
cast call $NEW "paused()(bool)" --rpc-url <RPC>              # 不应回滚
# 4. 字节码与本地编译比对：只允许 4 处差异（3 处各 20 字节 immutable、末尾 32 字节元数据）
```
比对脚本用 §1 同样的方法（逐字节比较链上 `eth_getCode` 与 `forge inspect ... deployedBytecode`）。**通过标准：** 长度相同，差异只在上述位置，且两链结果一致。

### P1-4 开源验证与收尾
1. 在 BscScan 与 `scan.wantos.io` 验证两个新实现的源码（`forge verify-contract`，API key 由负责人自己提供）。
2. 部署者退回剩余 gas，销毁钥匙文件。
3. 把新实现地址、两笔部署交易哈希、区块号写进本文「执行记录」。

**此时线上没有任何变化**（代理仍指向旧实现 `0x6686…`）。

---

## 5. P2：提议升级【G2】

### 5.1 提议方式
时间锁的 `schedule` 只有管理钱包（硬件钱包）能调用。管理页现在只能提议「参数、交接、提取」等固定几类，**不能提议升级和手续费配置**；但时间锁页面能**列出、解码、取消、执行**任何提案。所以：

- **提议**：用 `cast` 加硬件钱包签名（`--ledger` 或 `--trezor`，**待确认硬件钱包型号，见 §12 待确认项**）。
- **查看 / 核对 / 执行 / 取消**：用管理页的时间锁页面（需先按新 ABI 重新构建发布，否则新函数可能显示「无法解码」）。

### 5.2 生成提案内容（任何人可复核）
```bash
PROXY=0x41e9900BF09553C46b6b3F267626FDa2b4711E44
TL=0xE962600e3F9c608Cf7E0e80aB450ffE63b563618
NEW=<新实现地址>
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
SALT=$(cast keccak "native-fee-upgrade-20261104")      # 固定盐，两链相同、可复核
DATA=$(cast calldata "upgradeToAndCall(address,bytes)" $NEW 0x)
echo $DATA          # 应以 0x4f1ef286 开头（upgradeToAndCall）
# 提案编号（用于后面核对）
cast call $TL "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" $PROXY 0 $DATA $ZERO32 $SALT --rpc-url <RPC>
```
**让负责人在签名前核对三件事：** ① `DATA` 以 `0x4f1ef286` 开头；② 里面的地址就是 P1 记录的新实现；③ 目标是桥代理 `0x41e9…1E44`，不是别的合约。

### 5.3 提交（先 BSC，再 WANTOS）
```bash
cast send $TL "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
  $PROXY 0 $DATA $ZERO32 $SALT 172800 \
  --rpc-url <RPC> --ledger          # 管理钱包硬件签名
```
**核对（每条链）：**
```bash
ID=<上面算出的提案编号>
cast call $TL "isOperationPending(bytes32)(bool)" $ID --rpc-url <RPC>   # true
cast call $TL "getTimestamp(bytes32)(uint256)"   $ID --rpc-url <RPC>   # 可执行时间 = 现在 + 172800
```
把两条链的提案编号、交易哈希、可执行时间写进「执行记录」。

### 5.4 排队期间（48 小时）
- 线上仍是旧合约，**所有功能不受影响**；白名单、转账、放款照常。
- 监控会不会对「时间锁里出现升级提案」发告警，我没有核实；收到提案类告警属于预期，不代表出事。
- **取消路径**：管理钱包或白名单钱包任一都可以 `cancel` 提案（管理页时间锁页面有取消按钮；或 `cast send $TL "cancel(bytes32)" $ID`）。取消后重新提议即可。
- 提案有**有效期**：到了可执行时间后 **14 天内**必须执行，过期作废（`EXPIRY_PERIOD = 14 天`）。

---

## 6. P3：执行升级【G3】

**前置：** 两条链的提案都已到期（`isOperationReady` 为 true）。执行人开放，任何有 gas 的账号都能执行；通常用管理页时间锁页面的「执行」按钮。

### P3-1 执行前快照（两条链各一份，存档）
```bash
cast call $PROXY "paused()(bool)"            --rpc-url <RPC>
cast call $PROXY "whitelistNonce()(uint256)" --rpc-url <RPC>
cast call $PROXY "params()" --rpc-url <RPC>               # 各限额参数
cast call $PROXY "adminWallet()(address)"    --rpc-url <RPC>
cast call $PROXY "whitelistManager()(address)" --rpc-url <RPC>
cast call $PROXY "timelock()(address)"       --rpc-url <RPC>
cast storage $PROXY 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url <RPC>   # 旧实现
# 抽样 5 个已在白名单里的地址
cast call $PROXY "whitelisted(address)(bool)" <地址> --rpc-url <RPC>
# 桥合约持有的 USDT 余额
cast call <USDT> "balanceOf(address)(uint256)" $PROXY --rpc-url <RPC>
```
BSC 额外：`depositNonce()`；WANTOS 额外：`currentDay()`、`dailyUsed(currentDay)`。

### P3-2 执行（先 BSC，再 WANTOS，每条链单独核对后再做下一条）
```bash
cast send $TL "execute(address,uint256,bytes,bytes32,bytes32)" $PROXY 0 $DATA $ZERO32 $SALT --rpc-url <RPC> --ledger
```
若执行回滚：时间锁自检失败（`BridgeCheckFailed`）会让整笔回滚，**线上状态不变**。**硬停：** 回滚就停，把错误原文发给我，不要换参数重试。

### P3-3 执行后核对（每条链，全部通过才算完成）
1. 实现槽 = 新实现地址：`cast storage $PROXY 0x360894a1...2bbc`。
2. P3-1 的每一项读数与快照**逐项相同**（`paused`、`whitelistNonce`、`params`、三个角色地址、抽样白名单、USDT 余额）。
3. **新能力存在、但手续费是关的：**
   - BSC：`cast call $PROXY "quoteNativeFee(uint256)(uint256)" 50000000` → **0**；`nativeFeeConfig()` → 收款地址为零、倍数 0。
   - WANTOS：`quoteNativeFee(1000000000000000000000)` → **0**；`feeRecipient()` → 零地址。
4. **现有功能照常（旧调用方式，不带 value）：**
   - 用负责人的测试地址在**现有流程**里各做一笔最小额转账（BSC 入金、WANTOS 出金），或让客户正常使用，观察 15 分钟内无异常；订单状态正常。
   - 监控无新增告警（升级提案本身产生的提案类告警除外）。
5. 用户页在升级后仍正常（此时线上页面还是旧版，应完全正常）。

**回退（升级后发现问题）：** 旧实现 `0x6686…` 仍在链上。再走一次 48 小时时间锁，`upgradeToAndCall(0x668698E8683167F412550aEA9D72537435176297, 0x)` 即可退回；因为手续费存储在独立命名空间里，退回后旧实现看不到它、也不受影响。升级期间手续费一直关着，所以退回前没有任何用户被收费。

---

## 7. P4：发布用户页与 App【G4】

**前置条件（硬条件）：P3 两条链核对通过。** 在合约还是旧版时发布新版用户页，页面每次转账前都会调 `quoteNativeFee`，旧合约上这个调用会回滚，用户转账会报错——我已实测线上现在两条链的 `quoteNativeFee` 都回滚。

### P4-1 用户页（Cloudflare Pages 项目 `safebridge`，域名 `savebridge.wanto.pro`）
1. 发布前先 `wrangler pages deployment list --project-name safebridge`，记下当前生产部署编号作为**回退锚点**（别的会话也可能在部署，先看再做）。
2. 从用户页分支（`fee-web-20261104`，提交 `076d54c`）构建；构建配置沿用线上现有的公开配置（桥地址、RPC、起始块），**不要把任何密钥写进构建**。
3. 本地先 `pnpm test`（单元 + 组件）全绿，再构建、预览。
4. 发布：`cd /tmp && npx -y wrangler@4 pages deploy <dist 绝对路径> --project-name safebridge --branch main`（必须离开 pnpm 工作区目录执行；项目已存在，不要加会创建项目的参数）。
5. 核对：线上首页和脚本哈希与本地构建一致；用手机钱包（TP）实际打开一遍；此时手续费关闭，页面**不应出现**手续费那一行，转账流程与现在一样。
6. **回退：** 在 Cloudflare Pages 里把生产部署回滚到锚点编号。

### P4-2 App（Flutter）
- 前端人员照 `NATIVE-FEE-APP-FLUTTER.md` 改完并提交上架；开启手续费（P6）之前，**新版必须已经覆盖绝大多数用户**。覆盖率的标准由你定（例如 90% 的活跃用户）。我无法从链上或页面读到 App 的版本分布，需要你或 App 团队提供。

### P4-3 管理页用新 ABI 重新构建发布
- Pages 项目 `safebridge-admin`（`admin.wanto.pro`）。发布前先 `pages deployment list` 记回退锚点。
- 这是为了让时间锁页面认得新函数；**不要借机改别的功能**。发布命令与注意事项同 `docs/` 中管理页部署记录。

---

## 8. P5：提议开启手续费【G5】

**前置条件（全部满足才可以提议）：**
- [ ] P3 完成并核对通过。
- [ ] P4-1 用户页新版已发布并验证。
- [ ] 监控已认识新事件（P0-5），且已上线、告警通道验证过。
- [ ] App 新版已上架、覆盖率达到你定的标准。
- [ ] 你给出明确的**生效日期时间**（提议后 48 小时生效，不能立即）。

**参数（均已由你 2026-11-04 拍板，写进提案前请再核对一次）：**

| 链 | 函数 | 参数 |
|---|---|---|
| BSC | `setNativeFeeConfig(address recipient, uint256 multiplier)` | recipient = `0xADCDe89431978C79ef66956Cfed67ac925426957`，multiplier = **50** |
| WANTOS | `setNativeFeeTiers((address,uint256,uint256,uint256,uint256,uint256,uint256,uint256))` | 见下表 |

WANTOS 档位结构按顺序为 `(feeRecipient, l0, l1, l2, f0, f1, f2, f3)`，金额都是 18 位小数的原始值：

| 字段 | 含义 | 值（原始单位） | 折合 |
|---|---|---|---|
| feeRecipient | 收款地址 | `0xADCDe89431978C79ef66956Cfed67ac925426957` | — |
| l0 | 档 0 / 档 1 的分界 | `200000000000000000000` | 200 USDT |
| l1 | 档 1 / 档 2 的分界 | `1000000000000000000000` | 1000 USDT |
| l2 | 档 2 / 档 3 的分界 | `5000000000000000000000` | 5000 USDT |
| f0 | 低于 200 的费用 | `2500000000000000000` | 2.5 WANT |
| f1 | 200–1000 | `12000000000000000000` | 12 WANT |
| f2 | 1000–5000 | `50000000000000000000` | 50 WANT |
| f3 | 5000 及以上 | `120000000000000000000` | 120 WANT |

合约边界（超出会回滚，所以参数不会误设）：最低档 ≥ 1.2 WANT，每档 ≤ 250 WANT，费用逐档不降，分界严格递增，收款地址非零；BSC 倍数 ≤ 100，且费用夹在 `[0.0005, 0.002] BNB`。

### 生成与提交
```bash
# BSC
DATA_B=$(cast calldata "setNativeFeeConfig(address,uint256)" 0xADCDe89431978C79ef66956Cfed67ac925426957 50)
# WANTOS
DATA_W=$(cast calldata "setNativeFeeTiers((address,uint256,uint256,uint256,uint256,uint256,uint256,uint256))" \
  "(0xADCDe89431978C79ef66956Cfed67ac925426957,200000000000000000000,1000000000000000000000,5000000000000000000000,2500000000000000000,12000000000000000000,50000000000000000000,120000000000000000000)")
SALT=$(cast keccak "native-fee-config-20261104")
# 提案编号与提交方式同 §5.2、§5.3，目标仍是桥代理，value 为 0
```
**签名前核对：** `DATA_B` 以 `0x4fca6e8d` 开头、`DATA_W` 以 `0x33db5f5c` 开头；解码后参数与上表逐项一致；收款地址一个字符都不差（收款地址错了，费用会转给错误的人）。

**取消 / 有效期：** 与 §5.4 相同。

---

## 9. P6：执行配置并验证【G6】

1. 到期后执行（管理页时间锁页面或 `cast send ... execute(...)`），先 BSC 再 WANTOS。
2. **配置核对：**
   - BSC：`nativeFeeConfig()` → (收款地址, 50)；`quoteNativeFee(50000000)`（0.05 gwei）= `500000000000000`（0.0005 BNB）；`quoteNativeFee(1000000000)`（1 gwei）= `2000000000000000`（夹到上限 0.002 BNB）。
   - WANTOS：`quoteNativeFee` 在 199.99 / 200 / 999.99 / 1000 / 4999.99 / 5000 USDT 分别 = 2.5 / 12 / 12 / 50 / 50 / 120 WANT；`feeRecipient()` 为收款地址。
3. **真实小额验证（用你自己的白名单测试地址，各一笔）：**
   - BSC 入金：用新版用户页，记录收款地址前后余额，应增加约 0.0005 BNB；发起人多付的部分已退回。
   - WANTOS 出金：小额（例如 10 USDT），收款地址应增加 2.5 WANT。
   - 两笔订单都正常到账。
4. 监控认到 `NativeFeeCollected` 事件、没有误报。
5. 通知客服与客户手续费已生效、收费金额（见规范）。

---

## 10. 回退与应急速查

| 情况 | 动作 | 生效速度 |
|---|---|---|
| 手续费有问题（收错、异常高） | 管理钱包调 `disableNativeFee()`（两条链各一笔） | **立即**，报价回到 0，旧调用方式即可成功 |
| 排队中的提案要作废 | 管理钱包或白名单钱包 `cancel(提案编号)` | 立即 |
| 已升级、要退回旧合约 | 再走一次 48 小时时间锁：`upgradeToAndCall(旧实现 0x6686…, 0x)` | 48 小时 |
| 用户页新版有问题 | Cloudflare Pages 回滚到 P4-1 记下的锚点部署 | 分钟级 |
| 链上数据对不上 | 停在当前阶段，不继续下一步，原样报告 | — |

**硬停判据（任何一条出现就停下，不要自己换办法）：**
- 新实现地址在两条链上不一致；
- 部署后字节码比对多出预期之外的差异；
- 升级执行回滚，或执行后任何一项状态读数与快照不一致；
- 升级后现有转账出现失败；
- `quoteNativeFee` 的返回值与上文预期不符。

---

## 11. 授权清单（每项都需要你在对话里明确说）

| 编号 | 动作 | 范围 |
|---|---|---|
| G1 | 部署两个新实现 | 部署者地址、两链各一笔、使用的 RPC |
| G2 | 提议升级 | 两条链各一笔 `schedule`，管理钱包签名 |
| G3 | 执行升级 | 两条链各一笔 `execute`，逐链核对后再做下一条 |
| G4 | 发布用户页、管理页 | Cloudflare Pages 两个项目；App 上架由 App 团队负责 |
| G5 | 提议开启手续费 | 两条链各一笔 `schedule`，参数见 §8 |
| G6 | 执行手续费配置 | 两条链各一笔 `execute` + 两笔真实小额验证交易 |

---

## 12. 待确认项与刻意不做的

### 待确认（需要你回答）
1. **D1：分两步（建议）还是打包成一个批量提案？** 打包的话把 `upgradeToAndCall` 与 `setNativeFeeConfig`/`setNativeFeeTiers` 放进同一个 `scheduleBatch`，只等 48 小时，但手续费会在升级执行的同一刻生效，用户页和 App 必须在这之前全部到位，风险集中。
2. **管理钱包的硬件钱包型号：** `cast send --ledger/--trezor` 只支持常见型号。如果不支持，需要另想提议办法（例如给管理页加一个仅限本次用途的提案入口，这是新增代码，需要另行定稿）。
3. **D3：用户页是否加「报价失败按无手续费处理」的兼容。** 加了之后，新版用户页在旧合约上也能用，部署顺序不再是硬约束，但会略微放宽对异常的敏感度（报价读失败时会放行而不是提示）。建议只在 P3 之前的过渡期使用，或者干脆不加、严格按本文顺序。
4. **新部署者与 gas：** 谁生成、谁转 gas。
5. **App 覆盖率标准**与上架计划。
6. **WANTOS 链分叉演练：** 是否需要在独立沙盒里做（rpc3 限流会让公共节点分叉失败）。

### 刻意不做的
| 不做 | 少了什么 | 缓解 | 何时再做 |
|---|---|---|---|
| 新建「升级/手续费提案」管理页 | 提议要靠 `cast` 命令行 | 命令都写在本文，核对点明确；一次性操作，出错代价低于加页面的风险 | 以后升级频繁时 |
| 升级与配置打包成一个提案 | 总时间更长（约 4 天） | 分步更稳、可单独回退 | 对上线时间有硬要求时 |
| 自动化部署脚本 | 部署靠手动命令 | 每条命令都带核对步骤 | 以后部署次数多了 |
| 在 WANTOS 链做公共节点分叉演练 | 少一层演练 | 合约测试 + P3 现场核对 + 可回退 | 有自有 RPC 时 |
| 手续费开启后的价格自动调整 | 币价大幅波动时费用会偏 | 档位是时间锁参数，BSC 随 gas 价自动浮动 | 每周要调多次时 |

---

## 13. 执行记录（执行时逐项填写，不预填）

| 项 | 值 |
|---|---|
| 冻结源码提交号 / 目录哈希 | |
| 新部署者地址 | |
| 新实现地址（两链） | |
| 部署交易哈希（BSC / WANTOS） | |
| 升级提案编号 / 提交交易（BSC / WANTOS） | |
| 升级可执行时间 | |
| 升级执行交易（BSC / WANTOS） | |
| 升级前后快照核对结果 | |
| 用户页发布：部署编号 / 回退锚点 | |
| 手续费提案编号 / 提交交易（BSC / WANTOS） | |
| 手续费生效时间 | |
| 真实小额验证交易哈希 | |
