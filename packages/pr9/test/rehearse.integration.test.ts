import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The whole local rehearsal (two anvils on random 127.0.0.1 ports, fast contracts, real relayer /
 * watcher / migrate / offline-check) must pass end to end, and a single stage must be re-runnable
 * from its checkpoint. Never touches a real network.
 */
const run = promisify(execFile);
const PKG = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "pr9-rehearse-it-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("local rehearsal (warp)", () => {
  it("all stages pass", async () => {
    const r = await run("npx", ["tsx", "src/rehearse/main.ts", "--run-dir", dir], { cwd: PKG, maxBuffer: 64 << 20, timeout: 600_000 });
    expect(r.stdout).toContain("全部通过");
    const report = readFileSync(join(dir, "report.md"), "utf8");
    for (const s of ["build", "deploy", "verify", "roles", "e2e", "emergency", "faults", "monitor", "legacy"]) expect(report).toContain(`| ${s} |`);
    expect(report).not.toContain("**失败**");
    expect(existsSync(join(dir, "alert-coverage.md"))).toBe(true);
  }, 600_000);

  it("re-runs a single stage from its checkpoint", async () => {
    const r = await run("npx", ["tsx", "src/rehearse/main.ts", "--run-dir", dir, "--only", "legacy"], { cwd: PKG, maxBuffer: 64 << 20, timeout: 300_000 });
    expect(r.stdout).toContain("restored checkpoint of stage legacy");
    expect(r.stdout).toContain("全部通过");
  }, 300_000);

  it("refuses the testnet profile without the owner's authorization (before any network access)", async () => {
    const e = await run("npx", ["tsx", "src/rehearse/main.ts", "--config", "config/rehearse.testnet.json", "--run-dir", join(dir, "t")], { cwd: PKG, timeout: 60_000 }).catch((x: { stderr: string }) => x);
    expect(String((e as { stderr: string }).stderr)).toMatch(/authorization/);
  }, 60_000);
});
