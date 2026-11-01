# DH 列车账本：白名单跨链桥 v2

- 列车文档：`docs/DESIGN.md`（v0.9.3）§13；调研：`docs/PR0-FINDINGS.md`
- 总控：本会话（Claude）。车道：子智能体（隔离 worktree），分支叠加（stacked），**不合并**。
- 验证：合约 `forge test` / `forge coverage` / `forge build --sizes`；服务各自测试。无 fci（非 mulo）。
- 开始：2026-11-02

## 用户授权（原话，逐字）
- 2026-11-02「开工」
- 2026-11-02「走DH流程，全自动化推进」

## 授权边界（总控自设的硬约束，未经用户新授权不得突破）
1. 不部署任何合约、不发送任何链上交易、不动用任何资金、不读写任何私钥（Testor 转账需用户直接授权）。
2. 不触碰 rpc1 / rpc2；不对 S1 做任何改动。
3. **不合并**任何分支或 PR；合并只在用户亲口说「合并 #N」之后。
4. 推送 / 建 PR：GitHub 令牌（qubitark、ocmatrix）已失效，须用户执行 `gh auth refresh -h github.com`；远端仓库名待用户确认，在此之前仅本地提交。
5. 不改变 `docs/DESIGN.md` 里已拍板的 17 条决定；歧义记入各 PR 的 NOTES，交总控转用户。

## 账本
| PR | 标题 | 依赖 | 级别 | 状态 | 分支 | 备注 |
|---|---|---|---|---|---|---|
| PR-0 | 调研与准备 | — | L1 | running | main | ①③⑤已完成；②④⑥⑦⑧待用户 |
| PR-1 | 合约 | PR-0 | L2 | **gate2-passed(local)** | pr-1-contracts @ e8ad4fd | aligner 2 轮；230→240 测试；覆盖 100%；slither H0/M0；控制器已独立复跑 7 个变异全部抓住。未推送/未合并 |
| PR-2 | 外部审计 | PR-1 | — | blocked | — | 需用户选审计方，非自动化 |
| PR-3 | 付款程序 | PR-1 接口 | L2 | fix round 1 | pr-3-relayer | aligner 打回：3 阻塞（批准绕过 Locked 检查、executeRelease 前不重读、加价替换后错标 FAILED）+ 与 PR-5 的 /v1/orders 接口对齐 |
| PR-4 | 风控 | PR-3 | L2 | blocked(dep) | — | — |
| PR-5 | 用户页 | PR-1 接口 | L2 | **gate2-passed(local)** | pr-5-user-page @ 38fc077 | aligner 3 轮（第 3 轮最强模型 fable）；271 测试；控制器复跑变异全部抓住。有意取舍：未确认锁只保护本标签页及刷新，不做替换检测/手动解锁（非回执解锁会引入重复转账风险）。未推送/未合并 |
| PR-6 | 管理后台+离线工具 | PR-1/3/4 | L2 | blocked(dep) | — | — |
| PR-7 | 监控 | PR-1 事件 | L2 | aligner round 3 | pr-7-watcher @ b326518 | 3 轮：单一 RPC 信任类问题逐层修复；第 3 轮最强模型穷举审计中 |
| PR-8 | 迁移与旧单 | PR-1 | L2 | blocked(dep) | — | — |
| PR-9 | 测试网联调 | PR-3~8 | L2 | blocked(dep) | — | 需测试网资金，须用户授权 |
| PR-10 | 主网上线 | PR-2/9 | L2 | blocked(user) | — | 部署与注资须用户亲自授权 |

## 技术栈（总控定）
TypeScript + pnpm workspace（Node ≥ 22）+ viem + vitest。`packages/abi` 由 `scripts/gen-abi.sh` 从 PR-1 合约生成。服务测试用 anvil（本地，非真实网络）+ PGlite（测试用 Postgres）。分支叠加：pr-1-contracts → ts-workspace → 各车道分支。

## DH 流程记录
- 修复循环：第 1、2 轮同档 aligner（opus），第 3 轮换更强一档（fable）。
- 控制器每轮独立核实：HEAD、测试数、共享文件零改动、在独立 git 副本里复跑 aligner 指出的变异。
- 事故记录：lane-7 曾用 pkill -f anvil 可能误杀他车道的 anvil（本机测试进程，无外部影响）；之后所有指令明令禁止。
- 待统一：共享基线（packageManager、pnpm allowBuilds、gen-abi.sh as const、pnpm-lock.yaml）在三条车道完成后并入 ts-workspace，再 rebase。
