import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { manifestHash } from "../../src/manifest.js";

const PKG = join(__dirname, "../..");
const run = (...args: string[]) => spawnSync(join(PKG, "node_modules/.bin/tsx"), [join(PKG, "src/cli.ts"), ...args], { encoding: "utf8", cwd: PKG });

describe("cli (offline commands)", () => {
  it("scan -> validate -> propose -> verify-call; tampered manifest fails validate", () => {
    const out = mkdtempSync(join(tmpdir(), "pr8-cli-"));
    const s = run("scan", "--source", join(PKG, "test/fixtures/legacy-basic.json"), "--cutoff", "1762000000", "--vault", "0x00000000000000000000000000000000000b5c01", "--bsc-chain-id", "56", "--out", out);
    expect(s.status, s.stderr).toBe(0);
    const csv = join(out, "manifest.csv");
    const orig = readFileSync(csv, "utf8");
    const m = { hash: manifestHash(orig) };
    expect(s.stdout).toContain(`manifest 4 rows`);
    expect(s.stdout).toContain(m.hash);
    expect(run("validate", csv, "--hash", m.hash).status).toBe(0);
    expect(run("validate", csv, "--hash", `0x${"0".repeat(64)}`).status).toBe(1);
    expect(run("propose", csv, "--hash", m.hash, "--timelock", "0x00000000000000000000000000000000000071e1", "--out", out).status).toBe(0);
    const ps = JSON.parse(readFileSync(join(out, "proposals.json"), "utf8")) as { payCalldata: string; target: string }[];
    expect(ps).toHaveLength(1);
    const firstKey = readFileSync(csv, "utf8").split("\n").find((l) => l.startsWith("0x"))!.split(",")[0]!;
    writeFileSync(join(out, "exclude.txt"), `# blocked by preflight\n${firstKey}\n`);
    const out2 = join(out, "round1");
    expect(run("propose", csv, "--hash", m.hash, "--timelock", "0x00000000000000000000000000000000000071e1", "--round", "1", "--exclude", join(out, "exclude.txt"), "--out", out2).status).toBe(0);
    const ps2 = JSON.parse(readFileSync(join(out2, "proposals.json"), "utf8")) as { count: number; oldKeys: string[] }[];
    expect(ps2[0]!.count).toBe(3);
    expect(ps2[0]!.oldKeys).not.toContain(firstKey);
    const ok = run("verify-call", csv, "--hash", m.hash, "--target", ps[0]!.target, "--data", ps[0]!.payCalldata, "--delay", "172800");
    expect(ok.status, ok.stdout).toBe(0);
    expect(run("verify-call", csv, "--hash", m.hash, "--target", ps[0]!.target, "--data", ps[0]!.payCalldata, "--delay", "100").status).toBe(1);
    expect(run("verify-call", csv, "--target", ps[0]!.target, "--data", ps[0]!.payCalldata, "--delay", "172800").stderr).toMatch(/--hash is required/);
    writeFileSync(csv, readFileSync(csv, "utf8").replace(/,W2B,/, ",B2W,"));
    expect(run("validate", csv).status).toBe(0); // direction is informative; hash binding catches it:
    expect(run("validate", csv, "--hash", m.hash).status).toBe(1);
    expect(run("bogus").status).toBe(2);
    writeFileSync(csv, orig);
    // oldKey list files: every line must be 0x + 64 hex (N15: no prefix-less keys)
    const key = orig.split("\n").find((l) => l.startsWith("0x"))!.split(",")[0]!;
    for (const bad of ["0x1234", key.slice(2), `${key} extra`, "R2"]) {
      writeFileSync(join(out, "ex.txt"), `# blocked\n${key}\n${bad}\n`);
      const r = run("propose", csv, "--hash", m.hash, "--timelock", "0x00000000000000000000000000000000000071e1", "--exclude", join(out, "ex.txt"), "--round", "2", "--out", join(out, "ex"));
      expect(r.status, bad).toBe(1);
      expect(r.stderr).toContain(`"${bad}" is not a 32-byte oldKey`);
    }
    // removed options are usage errors now (round 3: no controlled set, no paid-keys)
    expect(run("validate", csv, "--controlled", join(out, "ex.txt")).status).toBe(64);
    expect(run("scan", "--source", join(PKG, "test/fixtures/legacy-basic.json"), "--cutoff", "1762000000", "--vault", "0x00000000000000000000000000000000000b5c01", "--bsc-chain-id", "56", "--paid-keys", join(out, "ex.txt"), "--out", join(out, "s3")).status).toBe(64);
    // offline scans say so
    expect(s.stdout).toContain("offline-json (NOT RPC-verified)");
    // missing required options -> 64 (preflight fails before touching any RPC)
    const noHash = run("preflight", csv, "--rpc-config", "x.json", "--rpc", "http://127.0.0.1:1", "--vault", "0x00000000000000000000000000000000000b5c01");
    expect(noHash.status).toBe(64);
    expect(noHash.stderr).toMatch(/--hash is required/);
    expect(run("preflight", csv, "--hash", m.hash, "--rpc", "http://127.0.0.1:1", "--vault", "0x00000000000000000000000000000000000b5c01").status).toBe(64);
    expect(run("propose", csv).status).toBe(64);
    expect(run("propose", csv).stderr).toMatch(/--hash is required/);
  });
});
