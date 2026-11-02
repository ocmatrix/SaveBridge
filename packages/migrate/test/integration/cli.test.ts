import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PKG = join(__dirname, "../..");
const run = (...args: string[]) => spawnSync(join(PKG, "node_modules/.bin/tsx"), [join(PKG, "src/cli.ts"), ...args], { encoding: "utf8", cwd: PKG });

describe("cli (offline commands)", () => {
  it("scan -> validate -> propose -> verify-call; tampered manifest fails validate", () => {
    const out = mkdtempSync(join(tmpdir(), "pr8-cli-"));
    const s = run("scan", "--source", join(PKG, "test/fixtures/legacy-basic.json"), "--cutoff", "1762000000", "--vault", "0x00000000000000000000000000000000000b5c01", "--bsc-chain-id", "56", "--out", out);
    expect(s.status, s.stderr).toBe(0);
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { hash: string; count: number };
    expect(m.count).toBe(5);
    const csv = join(out, "manifest.csv");
    expect(run("validate", csv, "--hash", m.hash).status).toBe(0);
    expect(run("validate", csv, "--hash", `0x${"0".repeat(64)}`).status).toBe(1);
    expect(run("propose", csv, "--hash", m.hash, "--timelock", "0x00000000000000000000000000000000000071e1", "--out", out).status).toBe(0);
    const ps = JSON.parse(readFileSync(join(out, "proposals.json"), "utf8")) as { payCalldata: string; target: string }[];
    expect(ps).toHaveLength(1);
    const ok = run("verify-call", csv, "--hash", m.hash, "--target", ps[0]!.target, "--data", ps[0]!.payCalldata, "--delay", "172800");
    expect(ok.status, ok.stdout).toBe(0);
    expect(run("verify-call", csv, "--hash", m.hash, "--target", ps[0]!.target, "--data", ps[0]!.payCalldata, "--delay", "100").status).toBe(1);
    expect(run("verify-call", csv, "--target", ps[0]!.target, "--data", ps[0]!.payCalldata, "--delay", "172800").stderr).toMatch(/--hash is required/);
    writeFileSync(csv, readFileSync(csv, "utf8").replace(/,W2B,/, ",B2W,"));
    expect(run("validate", csv).status).toBe(0); // direction is informative; hash binding catches it:
    expect(run("validate", csv, "--hash", m.hash).status).toBe(1);
    expect(run("bogus").status).toBe(2);
    expect(run("propose", csv).stderr).toMatch(/--hash is required/);
  });
});
