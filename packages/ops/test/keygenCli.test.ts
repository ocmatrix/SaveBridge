import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = resolve(__dirname, "../src/keygenCli.ts");
const PASS = "a-long-enough-test-passphrase-9f8e";
const dir = mkdtempSync(join(tmpdir(), "sb-cli-"));
const ks = join(dir, "keystore");
mkdirSync(ks, { mode: 0o700 });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], input?: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { input, encoding: "utf8", cwd: resolve(__dirname, ".."), env: { PATH: process.env.PATH ?? "", ...env } });

describe("savebridge-keygen CLI (production scrypt parameters)", () => {
  it("create via stdin pipe → prints address + public key only; verify via credential", () => {
    const out = join(ks, "pauser-bsc.json");
    const r = run(["create", "--out", out, "--label", "pauser-bsc"], `${PASS}\n`);
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout) as Record<string, string>;
    expect(Object.keys(res).sort()).toEqual(["address", "keystore", "label", "publicKey"]);
    expect(r.stdout + r.stderr).not.toContain(PASS);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(out, "utf8")).kdf.N).toBe(2 ** 17);

    const cd = join(dir, "creds");
    mkdirSync(cd, { mode: 0o700 });
    writeFileSync(join(cd, "pass"), PASS, { mode: 0o400 });
    const v = run(["verify", "--keystore", out, "--expect-address", res.address!, "--passphrase-credential", "pass"], undefined, { CREDENTIALS_DIRECTORY: cd });
    expect(v.status, v.stderr).toBe(0);
    expect(JSON.parse(v.stdout)).toEqual({ address: res.address });

    const w = run(["verify", "--keystore", out], "wrong-but-long-enough-passphrase\n");
    expect(w.status).toBe(2);
    expect(w.stderr).toMatch(/DECRYPT_FAILED/);
    expect(w.stderr).not.toContain("wrong-but-long-enough-passphrase");
  });

  it("refuses secrets on the command line and never echoes them", () => {
    for (const a of ["--passphrase", "--password=x", "--private-key", "--key"]) {
      const r = run(["create", "--out", join(ks, "x.json"), "--label", "x", a, "SECRETVALUE123"], `${PASS}\n`);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/never go on the command line/);
      expect(r.stderr).not.toContain("SECRETVALUE123");
    }
  });

  it("refuses to overwrite, rejects short passphrases and bad usage", () => {
    const out = join(ks, "dup.json");
    expect(run(["create", "--out", out, "--label", "dup"], `${PASS}\n`).status).toBe(0);
    const again = run(["create", "--out", out, "--label", "dup"], `${PASS}\n`);
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/EXISTS/);
    expect(run(["create", "--out", join(ks, "s.json"), "--label", "s"], "short\n").stderr).toMatch(/WEAK_PASSPHRASE/);
    expect(run(["create", "--label", "s"], `${PASS}\n`).stderr).toMatch(/usage/);
    expect(run(["bogus"], `${PASS}\n`).stderr).toMatch(/usage/);
    expect(run(["verify"], `${PASS}\n`).stderr).toMatch(/usage/);
  });
});
