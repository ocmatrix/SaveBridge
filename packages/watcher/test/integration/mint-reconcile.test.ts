/**
 * §9.1-6 mint (alert only, gross, persisted, never pauses) and §9.2 reconciliation / reserves.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, toHex, type Address } from "viem";
import { FileStateStore } from "../../src/state.js";
import { ACCOUNTS, E, startHarness, type ChainH, type Harness } from "../helpers/harness.js";
import { makeWatcher } from "../helpers/watcher.js";

/** OZ v5 ERC20 `_balances` is the first storage slot of MockToken. */
async function setTokenBalance(h: ChainH, who: Address, amount: bigint): Promise<void> {
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, 0n]));
  await h.rpc("anvil_setStorageAt", [h.token, slot, toHex(amount, { size: 32 })]);
  await h.mine(1);
}

describe("mint & reconciliation", () => {
  let H: Harness;
  beforeAll(async () => {
    H = await startHarness();
  });
  afterAll(() => H?.stop());
  beforeEach(async () => {
    await H.reset();
  });

  it("mint: small → level-2 alert; cumulative over threshold → level-1 'excess'; never pauses; total survives restarts and pauses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watcher-mint-"));
    const path = join(dir, "s.json");
    const t = await makeWatcher(H, { store: new FileStateStore(path) });
    await H.wantos.write(ACCOUNTS.tokenDeployer, "mint", [ACCOUNTS.attacker.address, E(100)], H.wantos.token);
    await H.bsc.write(ACCOUNTS.tokenDeployer, "mint", [ACCOUNTS.attacker.address, E(5_000_000)], H.bsc.token); // BSC: not WANTOS-USDT
    await H.settle();
    await t.w.tick();
    expect(t.sink.alerts.filter((a) => a.code === "MINT").map((a) => a.level)).toEqual([2]);
    expect(t.w.state.derived.mintTotal).toBe(E(100).toString());

    // pause both bridges manually: the gross total is not reset
    await H.bsc.write(ACCOUNTS.admin, "pause", []);
    await H.wantos.write(ACCOUNTS.admin, "pause", []);
    await H.wantos.write(ACCOUNTS.tokenDeployer, "mint", [ACCOUNTS.attacker.address, E(9_950)], H.wantos.token);
    await H.settle();
    const t2 = await makeWatcher(H, { store: new FileStateStore(path) }); // restart
    await t2.w.tick();
    const ex = t2.sink.alerts.find((a) => a.code === "MINT_EXCESS")!;
    expect(ex.level).toBe(1);
    expect(ex.detail["grossTotal"]).toBe(E(10_050).toString());
    expect(t2.codes()).not.toContain("AUTO_PAUSE");
    expect(t2.w.state.derived.pending).toHaveLength(0);
  });

  it("mint over the threshold with bridges running → still no pause", async () => {
    const t = await makeWatcher(H);
    await H.wantos.write(ACCOUNTS.tokenDeployer, "mint", [ACCOUNTS.attacker.address, E(20_000)], H.wantos.token);
    await H.settle();
    await t.w.tick();
    expect(t.codes()).toContain("MINT_EXCESS");
    expect(await H.isPaused("wantos")).toBe(false);
    expect(await H.isPaused("bsc")).toBe(false);
  });

  it("reconciliation: exact balance → nothing; unregistered surplus → no alert, listed in the daily report", async () => {
    const t = await makeWatcher(H, { startBlock: { bsc: 0n, wantos: 0n } });
    await H.wantos.write(ACCOUNTS.user1, "approve", [H.wantos.bridge, E(100)], H.wantos.token);
    await H.wantos.write(ACCOUNTS.user1, "bridgeOut", [E(100)]);
    await H.bsc.write(ACCOUNTS.user2, "approve", [H.bsc.bridge, E(50)], H.bsc.token);
    await H.bsc.write(ACCOUNTS.user2, "deposit", [E(50), ACCOUNTS.user2.address]);
    await H.bsc.write(ACCOUNTS.relayer, "release", [1n, ACCOUNTS.user1.address, E(100)]);
    await H.settle();
    t.clock.now += 10;
    await t.w.tick();
    expect(t.codes()).not.toContain("RECONCILE_SHORTFALL");
    expect(t.w.state.meta.daily.entries.filter((e) => e.kind === "RECONCILE_SURPLUS")).toHaveLength(0);

    await H.bsc.write(ACCOUNTS.user3, "transfer", [H.bsc.bridge, E(500)], H.bsc.token); // no Funded event
    await H.settle();
    t.clock.now += 3600;
    await t.w.tick();
    expect(t.codes()).not.toContain("RECONCILE_SHORTFALL");
    const s = t.w.state.meta.daily.entries.find((e) => e.kind === "RECONCILE_SURPLUS")!;
    expect(s.chain).toBe("bsc");
    expect(s.data["unregistered"]).toBe(E(500).toString());
  });

  it("reconciliation: a shortfall beyond tolerance → level-2 alert (no pause)", async () => {
    const t = await makeWatcher(H, { startBlock: { bsc: 0n, wantos: 0n } });
    await setTokenBalance(H.wantos, H.wantos.bridge, E(20_000) - E(1) / 2n); // within tolerance (1 USDT)
    await H.settle();
    await t.w.tick();
    expect(t.codes()).not.toContain("RECONCILE_SHORTFALL");
    await setTokenBalance(H.bsc, H.bsc.bridge, E(15_000));
    await H.settle();
    t.clock.now += 3600;
    await t.w.tick();
    const a = t.sink.alerts.find((x) => x.code === "RECONCILE_SHORTFALL")!;
    expect(a.level).toBe(2);
    expect(a.chain).toBe("bsc");
    expect(a.detail["expected"]).toBe(E(20_000).toString());
    expect(await H.isPaused("bsc")).toBe(false);
  });

  it("reserves: BSC < 1 day → level 2; < 0.5 day → level 1; WANTOS low balance → level 2", async () => {
    const t = await makeWatcher(H);
    await setTokenBalance(H.bsc, H.bsc.bridge, E(4_000));
    await setTokenBalance(H.wantos, H.wantos.bridge, E(2_000));
    await H.settle();
    await t.w.tick();
    expect(t.sink.alerts.find((a) => a.code === "RESERVE_LOW")!.level).toBe(2);
    expect(t.sink.alerts.find((a) => a.code === "WANTOS_BALANCE_LOW")!.level).toBe(2);
    expect(t.codes()).not.toContain("RESERVE_CRITICAL");
    await setTokenBalance(H.bsc, H.bsc.bridge, E(2_000));
    await H.settle();
    t.clock.now += 3600;
    await t.w.tick();
    expect(t.sink.alerts.find((a) => a.code === "RESERVE_CRITICAL")!.level).toBe(1);
  });

  it("daily report: BSC used ≥ 70% of dailyCap is listed", async () => {
    const t = await makeWatcher(H);
    await H.bsc.write(ACCOUNTS.relayer, "queueRelease", [101n, ACCOUNTS.user1.address, E(2000)]);
    await H.bsc.write(ACCOUNTS.relayer, "queueRelease", [102n, ACCOUNTS.user2.address, E(1600)]);
    await H.settle();
    await t.w.tick();
    const e = t.w.state.meta.daily.entries.find((x) => x.kind === "DAILY_CAP_70")!;
    expect(e.chain).toBe("bsc");
    expect(e.data["used"]).toBe(E(3600).toString());
  });
});
