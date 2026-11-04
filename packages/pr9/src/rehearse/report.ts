import type { Ctx } from "./ctx";

export function renderReport(ctx: Ctx, totalMs: number, failed: Error | null): string {
  const rows = ctx.results.map((r) => `| ${r.stage} | ${r.checks.filter((c) => c.pass).length}/${r.checks.length} | ${(r.ms / 1000).toFixed(1)} s |`);
  const lines = [
    `# PR-9 演练报告（${ctx.cfg.profile} / ${ctx.cfg.waitMode}）`,
    "",
    `总耗时 ${(totalMs / 60000).toFixed(1)} 分钟；结果：${failed ? `**失败** — ${failed.message}` : "**全部通过**"}`,
    "",
    "| 阶段 | 通过判据 | 实测耗时 |",
    "|---|---|---|",
    ...rows,
    "",
  ];
  for (const r of ctx.results) {
    lines.push(`## ${r.stage}`, "", "| # | 判据 | 结果 | 耗时 | 说明 |", "|---|---|---|---|---|");
    for (const c of r.checks) lines.push(`| ${c.id} | ${c.title} | ${c.pass ? "通过" : "**失败**"} | ${(c.ms / 1000).toFixed(1)} s | ${c.detail.replace(/\|/g, "/").slice(0, 160)} |`);
    if (r.notes.length) lines.push("", ...r.notes.map((n) => `- ${n}`));
    lines.push("");
  }
  return lines.join("\n");
}
