# 手续费升级：部署前的现成材料（2026-11-04，只含公开信息）

> 配合 `NATIVE-FEE-UPGRADE-RUNBOOK.md` 使用。**本文所有值在部署当天都要重新核对**（尤其是部署者 nonce、白名单批次号、两链状态），核对不一致就按手册「硬停判据」处理。没有负责人放行，不做任何链上写入。

## 1. 现场（2026-11-04 只读）

| 项 | BSC（56） | WANTOS（13555） |
|---|---|---|
| 桥代理 | `0x41e9900BF09553C46b6b3F267626FDa2b4711E44` | 同左 |
| 时间锁 | `0xE962600e3F9c608Cf7E0e80aB450ffE63b563618`，延迟 172800 | 同左 |
| 当前实现 | `0x668698E8683167F412550aEA9D72537435176297` | 同左 |
| `paused` / 管理员恢复 / 白名单恢复 | false / false / false | false / false / false |
| 时间锁 `epoch` | 0 | 0 |
| 白名单批次号 | 21（会变） | 21（会变） |
| 提交钥匙 `0x3C26…f7d4` 余额 | 0.08 BNB | 3 WANT（两笔执行约需 0.01 WANT） |
| 收款地址 `0xADCD…6957` 有无合约代码 | 无 | 无 |
| 部署者 `0x5AEB…7ABC`：余额 / nonce | 0.00159 BNB / 3 | 1.92 WANT / 7 |
| 部署 gas 价 | 0.05 gwei | 33.75 gwei |

## 2. 按部署者 nonce 预测的新实现地址（部署当天重新算）

| 链 | nonce | 预测的新实现地址 |
|---|---|---|
| BSC | 3 | `0xdfeE8c9bc21d2a7bf9f0c8d55115135aF5634A59` |
| WANTOS | 7 | `0xcBa30ff023f576ffa915bA322b34D6A835F330B7` |

```bash
cast compute-address 0x5AEB9689655Baf4D29002952C101A0b4407ABC8e --nonce <当前 nonce>
```

## 3. 部署命令（G1，口令由负责人自己在终端输入）

```bash
# 在冻结提交的完整检出里（含 lib 子模块）执行
forge create contracts/src/BscVaultV2.sol:BscVaultV2 \
  --rpc-url https://bsc-rpc.publicnode.com \
  --keystore ~/.savebridge-deployer-new/deployer-20261103 --broadcast
forge create contracts/src/WantosBridgeV2.sol:WantosBridgeV2 \
  --rpc-url https://rpc3.wantos.io \
  --keystore ~/.savebridge-deployer-new/deployer-20261103 --broadcast
```
部署后：核对实际地址等于第 2 节的预测；字节码逐字节比对只允许 4 处差异（3 处各 20 字节 immutable，末尾 32 字节元数据）；`proxiableUUID()` 返回 `0x360894a1…2bbc`。

## 4. 提案内容（G2）

**负责人 2026-11-04 已选方案 A**（下面方案 B 保留作为到期前放行条件不满足时的退路）。

公共变量：
```bash
PROXY=0x41e9900BF09553C46b6b3F267626FDa2b4711E44
TL=0xE962600e3F9c608Cf7E0e80aB450ffE63b563618
RCPT=0xADCDe89431978C79ef66956Cfed67ac925426957
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
DELAY=172800
```

### 方案 A：升级 + 手续费，一个批量（48 小时后一起生效）
| | BSC | WANTOS |
|---|---|---|
| 盐 | `0x19c272a3cd21e2d5f65d3a215901be4050033742c25c99dfe143def703496f25` | 同左 |
| 内容 | `[upgradeToAndCall(预测实现, 0x), setNativeFeeConfig(0xADCDe89431978C79ef66956Cfed67ac925426957, 50)]` | `[upgradeToAndCall(预测实现, 0x), setNativeFeeTiers((收款地址, 200e18, 1000e18, 5000e18, 2.5e18, 12e18, 50e18, 120e18))]` |
| 预期提案编号 | `0x10868fc9571a399a12b30d117f6af6f1b844d1077266a7540c25284009a7457b` | `0x0c755dfaefab596b0983c5343282c7d0d47683a97ed5c5c30b8032d021e98d8f` |

### 方案 B：只升级（手续费保持关闭）
| | BSC | WANTOS |
|---|---|---|
| 盐 | `0xe87fabbd940f68be4bb99b2800d3dbf7af80138a1085ef3771bb66d7ea8f24dd` | 同左 |
| 内容 | `upgradeToAndCall(预测实现, 0x)`（单个 `schedule`） | 同左 |
| 预期提案编号 | `0xe7590886b4a8006af355ee30ded75575f80d92a5104e39dd6f6e5d6c91d69d76` | `0x949940b119f1e85e92afbc75ea8f9f6f81a395d295381b433c5841dc7b01507b` |

方案 B 提议命令（BSC 示例，WANTOS 换 RPC 和实现地址）：
```bash
D1=$(cast calldata "upgradeToAndCall(address,bytes)" <该链新实现> 0x)
cast send $TL "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" $PROXY 0 $D1 $ZERO32 <盐 U> $DELAY --rpc-url <RPC> <签名参数>
```
App 新版覆盖后，手续费配置作为单独提案提议（方案 B 的第二步）：
```bash
cast send $TL "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" $PROXY 0 $(cast calldata "setNativeFeeConfig(address,uint256)" $RCPT 50) $ZERO32 <新盐> <DELAY> ...   # BSC
# WANTOS 用 setNativeFeeTiers，参数见手册 §8
```
**注意：** 方案 A/B 的「预期提案编号」依赖预测的实现地址；部署后若实际地址不同，必须重新计算（命令见手册 §5.2）。

## 5. 部署当天的核对清单（逐项勾）

- [ ] 冻结提交号与源码目录哈希（手册 §13）与完整检出一致，工作区干净
- [ ] `forge test` 全绿；本地升级演练通过
- [ ] 部署者 nonce、余额读取一致（第 1 节）
- [ ] 两链 `paused`/恢复流程/`epoch` 与第 1 节一致
- [ ] 收款地址两链都无合约代码
- [ ] 方案已选（A 或 B），盐与内容与第 4 节一致，签名前逐条核对（手册 §5.2）
- [ ] ss02 付款程序在运行，提交钥匙 gas 够（第 1 节）

## 6. 已构建好的发布产物与回退锚点（未发布）

| 项 | 位置 / 值 |
|---|---|
| 用户页产物 | `/Volumes/Projects/tmp-feeabi-20261104/web-prod`，`check-dist --real` 通过，目录哈希前 16 位 `9c22a8f1f401d183`；配置与线上页面一致（桥 `0x41e9…1E44`、WANTOS RPC `https://rpc.wantos.io`、起始块 3465059 / 131289654） |
| 用户页项目 | Pages 项目 `safebridge`（`savebridge.wanto.pro`）；回退锚点 `d53baf5f-03db-402a-b08e-9fee1a57c56e`（main `45cc15b`） |
| 管理页产物 | `/Volumes/Projects/tmp-feeabi-20261104/admin-prod`，目录哈希前 16 位 `763ecaac99ac24d7` |
| 管理页项目 | Pages 项目 `safebridge-admin`（`admin.wanto.pro`）；回退锚点 `1a7eb11c-c34f-4b78-860f-a1ffe4c9931e`（main `5045e02`）；必须从 `apps/admin-web` 目录发布 |
| ss02 付款程序 | 运行中；`poll.maxBlockRange = 50`；`startBlock` 为新桥部署区块；提交钥匙 BSC 0.08 BNB、WANTOS 3 WANT |
| 管理钱包 gas（付 `schedule`/`cancel`/`disableNativeFee`） | BSC 0.0206 BNB、WANTOS 9.99 WANT |
| 字节码比对脚本 | `node scripts/compare-impl.mjs <RPC> <实现地址> out/<合约>.sol/<合约>.json` |

发布前这些「当前最新部署」都要重新读一次，别的会话也可能在部署。

## 7. G1 完成记录（2026-11-04/05）

两条链的新实现都已部署并核对：BSC `0xdfeE8c9bc21d2a7bf9f0c8d55115135aF5634A59`（交易 `0x923d200d…2bfb`，区块 131651638），WANTOS `0xcBa30ff023f576ffa915bA322b34D6A835F330B7`（交易 `0x1df88c63…b688`，区块 3498560）。与预测地址一致，所以第 4 节的提案编号有效。线上代理的实现槽两条链都**没有变化**（仍是 `0x6686…6297`），现版 App 和用户不受影响；48 小时倒计时**还没开始**（要等 G2 提议）。

## 8. G3 完成记录（2026-11-05）

用户页 `451cdb6c`（回退锚点 `d53baf5f`）、管理页 `b92776f7`（回退锚点 `1a7eb11c`）已发布并核对，详见手册 §13。**两个页面都兼容旧合约**，线上合约仍是旧版，所以对现版 App 和用户没有影响。下一步是 G2：提议批量提案（48 小时倒计时从那一刻开始）。

## 9. G2 完成记录（2026-11-05）

两条链的批量提案都已提议并核对：BSC 到期 `2026-11-07 07:57:26 +08`，WANTOS 到期 `07:57:41 +08`。**48 小时倒计时已经开始**，到期后由付款程序自动执行，升级和手续费一起生效。线上实现和手续费状态目前都没有变化（仍是旧实现 `0x6686…`）。提议是用手机钱包通过一次性页面 `savebridge-feebatch.pages.dev` 发出的（见 `tools/fee-batch-page`）。
