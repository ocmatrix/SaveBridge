# DH 列车账本：白名单跨链桥 v2

- 列车文档：`docs/DESIGN.md`（当前 v0.9.5：风控只靠白名单，PR-4 已取消）§13；调研：`docs/PR0-FINDINGS.md`
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
| PR-1 | 合约 | PR-0 | L2 | **merged(local main)** | pr-1-contracts @ e8ad4fd（经 ts-workspace @ 733b388 合入，merge 68db318） | forge 240 测试；覆盖 100%；slither H0/M0；控制器复跑 7 个变异全部抓住 |
| PR-2 | 外部审计 | PR-1 | — | blocked(user) | pr-2-9-10-docs @ 617e9f8（送审包文档已合入，merge ff33265） | 需用户选审计方，非自动化 |
| PR-3 | 付款程序 | PR-1 接口 | L2 | **merged(local main)** | pr-3-relayer @ 4a44bcc（merge c1c883f） | 第 3 轮最终复审通过；21 文件 / 254 测试；变异 82/82 |
| PR-4 | 风控 | — | — | **cancelled** | pr-4-risk @ 8fa4902（不合并，仅存档） | 用户决定（2026-11-02）：风控只靠白名单，DESIGN v0.9.5 §7 / §13 |
| PR-5 | 用户页 | PR-1 接口 | L2 | **merged(local main)** | pr-5-user-page @ 38fc077（merge 263e1ab） | 271 测试；aligner 3 轮 + r4 文档；控制器复跑变异全部抓住 |
| PR-6 | 管理后台+离线工具 | PR-1/3 | L2 | **merged(local main)** | pr-6-admin @ 1e4dbd1（merge 17ec8a9） | 第 3 轮最终复审通过；admin-web 85 测试、offline-check 30 测试；v0.9.5 删除受控集合页 |
| PR-7 | 监控 | PR-1 事件 | L2 | **merged(local main)** | pr-7-watcher @ 0428934（merge 1a2af08） | 合入时 17 文件 / 170 测试；v0.9.5 清理（cleanup-controlled）删除受控集合 1 个用例后 169 |
| PR-8 | 迁移与旧单 | PR-1 | L2 | **merged(local main)** | pr-8-legacy @ c2bc66d（merge b344a20） | 控制器核实；13 文件 / 160 测试；第 3 轮按「只靠白名单」删除受控集合参数 |
| PR-9 | 测试网联调 | PR-3、PR-5～PR-8 | L2 | blocked(dep/user) | 计划文档已合入（pr-2-9-10-docs） | 需测试网资金，须用户授权 |
| PR-10 | 主网上线 | PR-2/9 | L2 | blocked(user) | 手册已合入（pr-2-9-10-docs） | 部署与注资须用户亲自授权 |
| — | DESIGN v0.9.5 | — | — | merged(local main) | docs-v095 @ 3237397（merge 0f0e45c） | SaveBridge；风控只靠白名单；Workers 静态资源 |
| — | v0.9.5 代码清理 | PR-3/6/7/8 | — | 待 Gate2 | cleanup-controlled | 删除 relayer `controlled_set` 表与 WAIT `index`、watcher 受控集合监控，文档同步 |

> 「merged(local main)」= 已合入本地 `main`（以 `git log --merges main` 为准）；均**未推送**。各 PR 的 HEAD 与测试数取自分支最终提交与各自 NOTES。

## 技术栈（总控定）
TypeScript + pnpm workspace（Node ≥ 22）+ viem + vitest。`packages/abi` 由 `scripts/gen-abi.sh` 从 PR-1 合约生成。服务测试用 anvil（本地，非真实网络）+ PGlite（测试用 Postgres）。分支叠加：pr-1-contracts → ts-workspace → 各车道分支。

## DH 流程记录
- 修复循环：第 1、2 轮同档 aligner（opus），第 3 轮换更强一档（fable）。
- 控制器每轮独立核实：HEAD、测试数、共享文件零改动、在独立 git 副本里复跑 aligner 指出的变异。
- 事故记录：lane-7 曾用 pkill -f anvil 可能误杀他车道的 anvil（本机测试进程，无外部影响）；之后所有指令明令禁止。
- 待统一：共享基线（packageManager、pnpm allowBuilds、gen-abi.sh as const、pnpm-lock.yaml）在三条车道完成后并入 ts-workspace，再 rebase。
