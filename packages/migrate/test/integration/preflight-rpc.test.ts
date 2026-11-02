/**
 * Read-only `scan --rpc-config` and `preflight` CLI against real nodes: two local anvils (BSC-like 5600 with the
 * PR-1 vault, WANTOS-like 13500), real Transfer logs standing in for the old bridge. Covers A-1 / A-R3-1 (payout
 * coverage must read to "latest"), A-2 (missing / double coverage fails closed), B1 / round-3 fixes 2, 3, 6, 7.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bscVaultV2Abi } from "@bridge/abi";
import { encodeFunctionData, parseAbi, parseEther, type Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DRILL_ACCOUNTS, LOCAL_CHAIN_ID, startLocalVault, type LocalVault } from "../../src/drill.js";
import { manifestHash } from "../../src/manifest.js";

const PKG = join(__dirname, "../..");
const run = (...args: string[]) => spawnSync(join(PKG, "node_modules/.bin/tsx"), [join(PKG, "src/cli.ts"), ...args], { encoding: "utf8", cwd: PKG });
const acct = (i: number) => mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: i });
const USER = acct(5);
const OLD_BSC = acct(6); // stands in for the old BSC vault 0xec6e
const OLD_WANTOS = acct(7); // stands in for the old WANTOS vault 0x8dFd
const OTHER = acct(8);
const USER2 = acct(3);
const WANTOS_ID = 13500;
const tok = parseAbi(["function mint(address to, uint256 amount)", "function transfer(address to, uint256 amount) returns (bool)"]);
const TRANSFER = "event Transfer(address indexed from, address indexed to, uint256 value)";

let bsc: LocalVault;
let wantos: LocalVault;
beforeAll(async () => {
  [bsc, wantos] = await Promise.all([startLocalVault(), startLocalVault(WANTOS_ID)]);
});
afterAll(() => {
  bsc?.stop();
  wantos?.stop();
});

const mint = (c: LocalVault, to: Address, n: string) => c.send(DRILL_ACCOUNTS.tokenDeployer, c.token, encodeFunctionData({ abi: tok, functionName: "mint", args: [to, parseEther(n)] }));
const transfer = (c: LocalVault, from: ReturnType<typeof acct>, to: Address, n: string) => c.send(from, c.token, encodeFunctionData({ abi: tok, functionName: "transfer", args: [to, parseEther(n)] }));
const head = async (c: LocalVault) => c.pub.getBlockNumber({ cacheTime: 0 });
const mine = async (c: LocalVault, n: number) => {
  await fetch(c.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_mine", params: [`0x${n.toString(16)}`] }) });
};

describe("scan / preflight CLI on two anvils", () => {
  it("full flow: fail-closed coverage, stale payout coverage, late fee-reduced payout, --data", async () => {
    // history: both old vaults paid someone before (so their payout specs are not empty)
    await mint(bsc, OLD_BSC.address, "100");
    await transfer(bsc, OLD_BSC, OTHER.address, "1");
    await mint(wantos, OLD_WANTOS.address, "100");
    await transfer(wantos, OLD_WANTOS, OTHER.address, "1");
    await mint(bsc, USER.address, "100");
    await transfer(bsc, USER, OLD_BSC.address, "10"); // the stuck B2W deposit
    await mint(bsc, USER2.address, "100");
    await transfer(bsc, USER2, OLD_BSC.address, "20"); // a second stuck deposit
    const T = Math.floor(Date.now() / 1000) + 10_000_000;
    const dir = mkdtempSync(join(tmpdir(), "pr8-pf-"));
    const orderTo = (await head(bsc)).toString();
    const cfg = (name: string, over: { payouts?: unknown[]; orders?: unknown[]; bscPayoutTo?: unknown; rpc?: Record<string, string> } = {}) => {
      const c = {
        rpc: over.rpc ?? { [LOCAL_CHAIN_ID]: bsc.url, [WANTOS_ID]: wantos.url },
        orders: over.orders ?? [{ chainId: LOCAL_CHAIN_ID, address: bsc.token, token: bsc.token, event: TRANSFER, args: { to: OLD_BSC.address }, fromBlock: "0n", toBlock: `${orderTo}n`, decimals: 18, direction: "B2W", fields: { from: "from", amount: "value" } }],
        payouts: over.payouts ?? [
          { chainId: LOCAL_CHAIN_ID, address: bsc.token, token: bsc.token, event: TRANSFER, args: { from: OLD_BSC.address }, fromBlock: "0n", toBlock: "bscPayoutTo" in over ? over.bscPayoutTo : "latest", decimals: 18, fields: { to: "to", amount: "value" } },
          { chainId: WANTOS_ID, address: wantos.token, event: TRANSFER, args: { from: OLD_WANTOS.address }, fromBlock: "0n", toBlock: "latest", decimals: 18, fields: { to: "to", amount: "value" } },
        ],
      };
      const f = join(dir, `${name}.json`);
      writeFileSync(f, JSON.stringify(c));
      return f;
    };
    const scan = (cfgPath: string, out: string) => run("scan", "--rpc-config", cfgPath, "--cutoff", String(T), "--vault", bsc.vault, "--bsc-chain-id", String(LOCAL_CHAIN_ID), "--out", out);

    // A-2 ① payout spec at a wrong address -> exit 1, no manifest written
    const goodPayouts = JSON.parse(readFileSync(cfg("tmp"), "utf8")).payouts as Record<string, unknown>[];
    const bad1 = scan(cfg("wrong-addr", { payouts: [{ ...goodPayouts[0], address: OTHER.address }, goodPayouts[1]] }), join(dir, "o1"));
    expect(bad1.status).toBe(1);
    expect(bad1.stderr).toMatch(/payout spec #0 .* returned no logs/);
    expect(existsSync(join(dir, "o1", "manifest.csv"))).toBe(false);
    // A-2 ② no payout specs at all -> exit 1
    const bad2 = scan(cfg("no-payouts", { payouts: [] }), join(dir, "o2"));
    expect(bad2.status).toBe(1);
    expect(bad2.stderr).toMatch(/no payout spec/);
    // A-2 ③ the deposit captured by two order specs -> exit 1
    const goodOrder = JSON.parse(readFileSync(cfg("tmp"), "utf8")).orders[0] as Record<string, unknown>;
    const bad3 = scan(cfg("double", { orders: [goodOrder, { ...goodOrder, args: { from: USER.address } }] }), join(dir, "o3"));
    expect(bad3.status).toBe(1);
    expect(bad3.stderr).toMatch(/captured by order specs #0 and #1/);
    expect(existsSync(join(dir, "o3", "manifest.csv"))).toBe(false);

    // good scan
    const out = join(dir, "ok");
    const s = scan(cfg("good"), out);
    expect(s.status, s.stderr).toBe(0);
    const csvPath = join(out, "manifest.csv");
    const csv = readFileSync(csvPath, "utf8");
    expect(csv).toContain(`,B2W,${USER.address},${USER.address},10000000000000000000,10\n`);
    const hash = manifestHash(csv);
    const pf = (cfgPath: string, ...extra: string[]) => run("preflight", csvPath, "--hash", hash, "--rpc-config", cfgPath, "--rpc", bsc.url, "--vault", bsc.vault, ...extra);

    const ok = pf(cfg("good"));
    expect(ok.status, ok.stderr + ok.stdout).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, checked: 2 });
    // B1: --data checks exactly the scheduled rows (here a batch proposed without USER2's row)
    const user2Key = csv.split("\n").find((l) => l.includes(USER2.address))!.split(",")[0]!;
    writeFileSync(join(dir, "ex.txt"), `${user2Key}\n`);
    expect(run("propose", csvPath, "--hash", hash, "--timelock", bsc.timelock, "--exclude", join(dir, "ex.txt"), "--round", "1", "--out", join(dir, "p")).status).toBe(0);
    const ps = JSON.parse(readFileSync(join(dir, "p", "proposals.json"), "utf8")) as { payCalldata: string }[];
    const okData = pf(cfg("good"), "--data", ps[0]!.payCalldata);
    expect(okData.status, okData.stdout + okData.stderr).toBe(0);
    expect(JSON.parse(okData.stdout)).toMatchObject({ ok: true, checked: 1 });

    // the old bridge refunds late, minus a fee -> "latest" config sees it, preflight blocks
    const depositBlock = await head(bsc);
    await transfer(bsc, OLD_BSC, USER.address, "9.9");
    await mine(bsc, 30);
    const blocked = pf(cfg("good"));
    expect(blocked.status, blocked.stdout + blocked.stderr).toBe(1);
    const blockers1 = JSON.parse(blocked.stdout).blockers.join() as string;
    expect(blockers1).toContain(`not linked to this order went to ${USER.address}`);
    expect(blockers1).not.toContain(USER2.address);
    // a fresh scan with "latest" no longer lists USER
    const rescan = scan(cfg("good"), join(dir, "rescan"));
    expect(rescan.status, rescan.stderr).toBe(0);
    expect(readFileSync(join(dir, "rescan", "manifest.csv"), "utf8")).not.toContain(USER.address);

    // A-R3-1 (reviewer probe): any payout toBlock other than the literal "latest" is a config error —
    // scan exits 1 without a manifest, preflight exits 1. Before the fix "0x…" silently skipped the late refund.
    for (const [i, form] of [`0x${depositBlock.toString(16)}`, "0x8", `${depositBlock}n`, String(depositBlock), Number(depositBlock), "Latest", null].entries()) {
      const f = cfg(`form${i}`, { bscPayoutTo: form });
      const sc = scan(f, join(dir, `form${i}`));
      expect(sc.status, String(form)).toBe(1);
      expect(sc.stderr).toMatch(/rpc-config: payout spec #0: toBlock must be the literal "latest"/);
      expect(existsSync(join(dir, `form${i}`, "manifest.csv"))).toBe(false);
      const p2 = pf(f);
      expect(p2.status, String(form)).toBe(1);
      expect(p2.stderr).toMatch(/toBlock must be the literal "latest"/);
    }

    // fix 3: a WANTOS-side refund from the old WANTOS vault blocks too (both chains' payouts reach the preflight)
    await transfer(wantos, OLD_WANTOS, USER2.address, "1");
    const blocked2 = pf(cfg("good"));
    expect(blocked2.status).toBe(1);
    expect(JSON.parse(blocked2.stdout).blockers.join()).toContain(`not linked to this order went to ${USER2.address}`);

    // misc: wrong vault; B1 --data of the scheduled batch; garbage data; removed flags
    expect(pf(cfg("good")).status).toBe(1);
    expect(run("preflight", csvPath, "--hash", hash, "--rpc-config", cfg("good"), "--rpc", bsc.url, "--vault", DRILL_ACCOUNTS.admin.address).stderr).toMatch(/not the manifest vault/);
    const withData = pf(cfg("good"), "--data", ps[0]!.payCalldata);
    expect(withData.status).toBe(1);
    expect(JSON.parse(withData.stdout)).toMatchObject({ ok: false, checked: 1 });
    expect(JSON.parse(withData.stdout).blockers.join()).not.toContain(USER2.address); // only the scheduled row was checked
    const garbage = pf(cfg("good"), "--data", "0xdeadbeef");
    expect(garbage.status).toBe(1);
    expect(JSON.parse(garbage.stdout).blockers.join()).toMatch(/calldata: cannot decode/);
    // fix 2: calldata with one good row and one foreign row -> exit 1 before any preflight
    const userKey = csv.split("\n").find((l) => l.includes(`,${USER.address},`))!.split(",")[0]! as `0x${string}`;
    const mixed = encodeFunctionData({ abi: bscVaultV2Abi, functionName: "payLegacyBatch", args: [[userKey, `0x${"9".repeat(64)}`], [USER.address, USER.address], [parseEther("10"), 1n]] });
    const partial = pf(cfg("good"), "--data", mixed);
    expect(partial.status).toBe(1);
    expect(JSON.parse(partial.stdout)).toMatchObject({ ok: false, checked: 0 });
    expect(JSON.parse(partial.stdout).blockers.join()).toMatch(/calldata: oldKey 0x9{64} is not in the published manifest/);
    // fix 7: the new-vault RPC must serve the manifest's chain
    const wrongChain = run("preflight", csvPath, "--hash", hash, "--rpc-config", cfg("good"), "--rpc", wantos.url, "--vault", bsc.vault);
    expect(wrongChain.status).toBe(1);
    expect(wrongChain.stderr).toMatch(/--rpc serves chain 13500, the manifest is for chain 5600/);
    // fix 6: RPC URLs (API keys in the path / query) never reach stderr
    const secret = run("preflight", csvPath, "--hash", hash, "--rpc-config", cfg("good"), "--rpc", "http://127.0.0.1:1/v3/SECRETKEY123?apikey=QUERYSECRET", "--vault", bsc.vault);
    expect(secret.status).toBe(1);
    expect(secret.stderr).not.toMatch(/SECRETKEY123|QUERYSECRET|127\.0\.0\.1:1/);
    const secretCfg = scan(cfg("secret", { rpc: { [LOCAL_CHAIN_ID]: "http://127.0.0.1:1/v3/CFGSECRET", [WANTOS_ID]: wantos.url } }), join(dir, "sec"));
    expect(secretCfg.status).toBe(1);
    expect(secretCfg.stderr).not.toMatch(/CFGSECRET|127\.0\.0\.1:1/);
    // fix 2: preflight without --hash is a usage error (64)
    expect(run("preflight", csvPath, "--rpc-config", cfg("good"), "--rpc", bsc.url, "--vault", bsc.vault).status).toBe(64);
    const removed = pf(cfg("good"), "--batch", "0");
    expect(removed.status).toBe(64);
    expect(removed.stderr).toMatch(/Unknown option '--batch'/);
  });
});
