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
| PR-3 | 付款程序 | PR-1 接口 | L2 | running | pr-3-relayer（叠在 ts-workspace 上） | lane-3 |
| PR-4 | 风控 | PR-3 | L2 | blocked(dep) | — | — |
| PR-5 | 用户页 | PR-1 接口 | L2 | running | pr-5-user-page | lane-5 |
| PR-6 | 管理后台+离线工具 | PR-1/3/4 | L2 | blocked(dep) | — | — |
| PR-7 | 监控 | PR-1 事件 | L2 | running | pr-7-watcher | lane-7 |
| PR-8 | 迁移与旧单 | PR-1 | L2 | blocked(dep) | — | — |
| PR-9 | 测试网联调 | PR-3~8 | L2 | blocked(dep) | — | 需测试网资金，须用户授权 |
| PR-10 | 主网上线 | PR-2/9 | L2 | blocked(user) | — | 部署与注资须用户亲自授权 |

## 技术栈（总控定）
TypeScript + pnpm workspace（Node ≥ 22）+ viem + vitest。`packages/abi` 由 `scripts/gen-abi.sh` 从 PR-1 合约生成。服务测试用 anvil（本地，非真实网络）+ PGlite（测试用 Postgres）。分支叠加：pr-1-contracts → ts-workspace → 各车道分支。
