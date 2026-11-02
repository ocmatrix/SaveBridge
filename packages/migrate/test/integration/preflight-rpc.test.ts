/** A4: read-only `preflight` CLI against a real node (local anvil): loadFromRpc → old payouts → blockers. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, parseEther } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DRILL_ACCOUNTS, LOCAL_CHAIN_ID, startLocalVault, tokenAbi, type LocalVault } from "../../src/drill.js";
import { manifestHash } from "../../src/manifest.js";

const PKG = join(__dirname, "../..");
const run = (...args: string[]) => spawnSync(join(PKG, "node_modules/.bin/tsx"), [join(PKG, "src/cli.ts"), ...args], { encoding: "utf8", cwd: PKG });
const acct = (i: number) => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: i });
const USER = acct(5);
const OLD_VAULT = acct(6); // stands in for the old BSC vault 0xec6e

let lv: LocalVault;
beforeAll(async () => {
  lv = await startLocalVault();
});
afterAll(() => lv?.stop());

const transfer = (from: ReturnType<typeof acct>, to: string, n: string) => lv.send(from, lv.token, encodeFunctionData({ abi: [...tokenAbi, { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "transfer", args: [to as `0x${string}`, parseEther(n)] }));

describe("preflight CLI on anvil", () => {
  it("passes before the old bridge pays, blocks after a fee-reduced payout to the depositor", async () => {
    await lv.send(DRILL_ACCOUNTS.tokenDeployer, lv.token, encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [USER.address, parseEther("100")] }));
    await transfer(USER, OLD_VAULT.address, "10"); // the stuck B2W deposit
    const dir = mkdtempSync(join(tmpdir(), "pr8-pf-"));
    const cfg = (toBlock: bigint) => {
      const ev = "event Transfer(address indexed from, address indexed to, uint256 value)";
      const c = {
        rpc: { [LOCAL_CHAIN_ID]: lv.url },
        orders: [{ chainId: LOCAL_CHAIN_ID, address: lv.token, token: lv.token, event: ev, args: { to: OLD_VAULT.address }, fromBlock: "0n", toBlock: `${toBlock}n`, decimals: 18, direction: "B2W", fields: { from: "from", amount: "value" } }],
        payouts: [{ chainId: LOCAL_CHAIN_ID, address: lv.token, token: lv.token, event: ev, args: { from: OLD_VAULT.address }, fromBlock: "0n", toBlock: `${toBlock}n`, decimals: 18, fields: { to: "to", amount: "value" } }],
      };
      writeFileSync(join(dir, "old.json"), JSON.stringify(c));
      return join(dir, "old.json");
    };
    const s = run("scan", "--rpc-config", cfg(await lv.pub.getBlockNumber({ cacheTime: 0 })), "--cutoff", String(Math.floor(Date.now() / 1000) + 10_000_000), "--vault", lv.vault, "--bsc-chain-id", String(LOCAL_CHAIN_ID), "--out", dir);
    expect(s.status, s.stderr).toBe(0);
    expect(s.stdout).toMatch(/payout spec #0 .* returned no logs/);
    const csvPath = join(dir, "manifest.csv");
    const csv = readFileSync(csvPath, "utf8");
    expect(csv).toContain(`,B2W,${USER.address},${USER.address},10000000000000000000,10\n`);
    const hash = manifestHash(csv);

    const pf = (cfgPath: string) => run("preflight", csvPath, "--hash", hash, "--rpc-config", cfgPath, "--rpc", lv.url, "--vault", lv.vault);
    const ok = pf(cfg(await lv.pub.getBlockNumber({ cacheTime: 0 })));
    expect(ok.status, ok.stderr + ok.stdout).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, checked: 1 });

    await transfer(OLD_VAULT, USER.address, "9.9"); // the old bridge refunds late, minus a fee
    const blocked = pf(cfg(await lv.pub.getBlockNumber({ cacheTime: 0 })));
    expect(blocked.status, blocked.stdout + blocked.stderr).toBe(1);
    expect(JSON.parse(blocked.stdout).blockers.join()).toContain(`not linked to this order went to ${USER.address}`);

    expect(run("preflight", csvPath, "--hash", hash, "--rpc-config", join(dir, "old.json"), "--rpc", lv.url, "--vault", DRILL_ACCOUNTS.admin.address).stderr).toMatch(/not the manifest vault/);
    const b0 = run("preflight", csvPath, "--hash", hash, "--rpc-config", join(dir, "old.json"), "--rpc", lv.url, "--vault", lv.vault, "--timelock", lv.timelock, "--batch", "0");
    expect(b0.status).toBe(1);
    expect(run("preflight", csvPath, "--hash", hash, "--rpc-config", join(dir, "old.json"), "--rpc", lv.url, "--vault", lv.vault, "--timelock", lv.timelock, "--batch", "1").stderr).toMatch(/no batch 1/);
  });
});
