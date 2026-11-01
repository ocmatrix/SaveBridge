/**
 * §9.1 check 1: every BSC Released / ReleaseQueued ↔ a WANTOS BridgeOut (same orderId, address, amount).
 * Mismatch → pause BSC only, after the 5-minute grace, only when the watcher's WANTOS view has passed
 * the payout's time and ≥2 RPCs agree.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { ACCOUNTS, E, startHarness, type Harness } from "../helpers/harness.js";
import { makeWatcher, tamperedClient } from "../helpers/watcher.js";

describe("§9.1-1 BSC payout ↔ WANTOS BridgeOut", () => {
  let H: Harness;
  beforeAll(async () => {
    H = await startHarness();
  });
  afterAll(() => H?.stop());
  beforeEach(async () => {
    await H.reset();
  });

  const bridgeOut = async (amount: bigint) => {
    await H.wantos.write(ACCOUNTS.user1, "approve", [H.wantos.bridge, amount], H.wantos.token);
    return H.wantos.write(ACCOUNTS.user1, "bridgeOut", [amount]);
  };

  it("positive: matching Released (small) and ReleaseQueued (large) raise nothing and pause nothing", async () => {
    const t = await makeWatcher(H);
    await bridgeOut(E(100));
    await bridgeOut(E(1500));
    const r1 = await H.bsc.write(ACCOUNTS.relayer, "release", [1n, ACCOUNTS.user1.address, E(100)]);
    await H.bsc.write(ACCOUNTS.relayer, "queueRelease", [2n, ACCOUNTS.user1.address, E(1500)]);
    await H.settle();
    t.clock.now = r1.timestamp + 10_000;
    await t.w.tick();
    expect(t.w.state.derived.pending).toHaveLength(0);
    expect(t.codes()).not.toContain("AUTO_PAUSE");
    expect(await H.isPaused("bsc")).toBe(false);
    expect(t.w.state.derived.wantos.sums["bridgeOut"]).toBe(E(1600).toString());
    expect(t.w.state.derived.bsc.sums["released"]).toBe(E(100).toString());
  });

  it("negative: a forged Released with no source event pauses BSC only after the grace period", async () => {
    const t = await makeWatcher(H);
    const r = await H.bsc.write(ACCOUNTS.relayer, "release", [7n, ACCOUNTS.user2.address, E(500)]); // relayer key used directly, no BridgeOut
    await H.settle();
    t.clock.now = r.timestamp + 299;
    await t.w.tick();
    expect(await H.isPaused("bsc")).toBe(false);
    expect(t.w.state.derived.pending).toHaveLength(1);
    t.clock.now = r.timestamp + 301;
    const rep = await t.w.tick();
    expect(rep.paused).toEqual(["bsc"]);
    expect(await H.isPaused("bsc")).toBe(true);
    expect(await H.isPaused("wantos")).toBe(false);
    const a = t.sink.alerts.find((x) => x.code === "AUTO_PAUSE")!;
    expect(a.level).toBe(1);
    expect(a.chain).toBe("bsc");
    expect(t.w.state.derived.pending).toHaveLength(0);
  });

  it("negative: wrong amount, and wrong address, each pause BSC", async () => {
    for (const [to, amount] of [
      [ACCOUNTS.user1.address, E(101)],
      [ACCOUNTS.user2.address, E(100)],
    ] as const) {
      await H.reset();
      const t = await makeWatcher(H);
      await bridgeOut(E(100));
      const r = await H.bsc.write(ACCOUNTS.relayer, "release", [1n, to, amount]);
      await H.settle();
      t.clock.now = r.timestamp + 301;
      await t.w.tick();
      expect(await H.isPaused("bsc")).toBe(true);
      expect(t.sink.alerts.find((x) => x.code === "AUTO_PAUSE")!.detail["reason"]).toMatch(/user\/amount/);
    }
  });

  it("negative via ReleaseQueued: forged queue pauses BSC; a queue voided before the decision is benign", async () => {
    const t = await makeWatcher(H);
    const q = await H.bsc.write(ACCOUNTS.relayer, "queueRelease", [9n, ACCOUNTS.user1.address, E(1200)]);
    const q2 = await H.bsc.write(ACCOUNTS.relayer, "queueRelease", [10n, ACCOUNTS.user2.address, E(1200)]);
    await H.bsc.write(ACCOUNTS.wl, "cancelRelease", [10n]);
    await H.settle();
    t.clock.now = Math.max(q.timestamp, q2.timestamp) + 301;
    await t.w.tick();
    expect(await H.isPaused("bsc")).toBe(true);
    expect(t.sink.alerts.filter((x) => x.code === "AUTO_PAUSE")).toHaveLength(1);
    expect(t.w.state.derived.pending).toHaveLength(0);
  });

  it("does not pause while the watcher's WANTOS view is behind the payout (condition ①)", async () => {
    const t = await makeWatcher(H);
    await H.settle();
    await t.w.tick(); // the watcher has a WANTOS cursor...
    const wantosCursor = t.w.state.derived.wantos.cursor!;
    await H.bsc.increaseTime(30);
    const r = await H.bsc.write(ACCOUNTS.relayer, "release", [3n, ACCOUNTS.user2.address, E(50)]);
    await H.bsc.mine(3); // ...but WANTOS gets no newer blocks, so that cursor is older than the payout
    expect(wantosCursor.timestamp).toBeLessThan(r.timestamp);
    t.clock.now = r.timestamp + 1000;
    await t.w.tick();
    expect(t.w.state.derived.wantos.cursor).toEqual(wantosCursor);
    expect(await H.isPaused("bsc")).toBe(false);
    expect(t.codes()).toContain("CHECK_DEFERRED");
    expect(t.w.state.derived.pending).toHaveLength(1);
    // WANTOS catches up → now it may pause.
    await H.wantos.rpc("evm_setNextBlockTimestamp", [r.timestamp + 1]);
    await H.wantos.mine(8);
    await t.w.tick();
    expect(await H.isPaused("bsc")).toBe(true);
  });

  it("does not pause when two RPCs disagree (condition ②)", async () => {
    let forged: Hex = "0x";
    const lying = tamperedClient(H.bsc, (method, params) =>
      method === "eth_getTransactionReceipt" && params[0] === forged ? { handled: true, result: null } : { handled: false },
    );
    const t = await makeWatcher(H, { endpoints: { bsc: [{ label: "bsc-a", client: H.bsc.pub }, { label: "bsc-liar", client: lying }] } });
    const r = await H.bsc.write(ACCOUNTS.relayer, "release", [4n, ACCOUNTS.user2.address, E(50)]);
    forged = r.hash;
    await H.settle();
    t.clock.now = r.timestamp + 400;
    await t.w.tick();
    await t.w.tick();
    expect(await H.isPaused("bsc")).toBe(false);
    expect(t.codes().filter((c) => c === "RPC_DISAGREE")).toHaveLength(1); // deduped
    expect(t.w.state.derived.pending).toHaveLength(1);
  });

  it("drops a check when ≥2 RPCs agree the target event does not exist", async () => {
    let target: Hex = "0x";
    const mk = () => tamperedClient(H.bsc, (method, params) => (method === "eth_getTransactionReceipt" && params[0] === target ? { handled: true, result: null } : { handled: false }));
    const t = await makeWatcher(H);
    const r = await H.bsc.write(ACCOUNTS.relayer, "release", [5n, ACCOUNTS.user2.address, E(50)]);
    await H.settle();
    t.clock.now = r.timestamp + 10;
    await t.w.tick(); // ingested via honest RPCs
    target = r.hash;
    const t2 = await makeWatcher(H, { endpoints: { bsc: [{ label: "x", client: mk() }, { label: "y", client: mk() }] } });
    t2.w.state = t.w.state;
    t2.clock.now = r.timestamp + 400;
    await t2.w.tick();
    expect(await H.isPaused("bsc")).toBe(false);
    expect(t2.codes()).toContain("RPC_DISAGREE");
    expect(t2.w.state.derived.pending).toHaveLength(0);
  });

  it("B7 / §6.2: a WANTOS event is ingested only after 6 confirmations (not while within latest − 5)", async () => {
    const t = await makeWatcher(H);
    await H.settle();
    await t.w.tick();
    await bridgeOut(E(100)); // includes approve; BridgeOut is in the latest block L
    await H.wantos.mine(5); // latest = L + 5 → safe head = L − 1
    await t.w.tick();
    expect(t.w.state.derived.wantos.sums["bridgeOut"] ?? "0").toBe("0");
    await H.wantos.mine(1); // latest = L + 6 → safe head = L
    await t.w.tick();
    expect(t.w.state.derived.wantos.sums["bridgeOut"]).toBe(E(100).toString());
  });
});
