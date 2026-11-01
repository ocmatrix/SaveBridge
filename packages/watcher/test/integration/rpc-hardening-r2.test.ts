/**
 * GATE2 round 2 regressions (aligner POC-A/B/C/D). A log reported by a single RPC must never change
 * state (sums, unpause marker, dropped checks, deposit index …); only conservative effects (new checks,
 * alerts) are allowed. Each POC has a control run without the lying RPC that must end the same way.
 */
import { encodeAbiParameters, encodeEventTopics, getAbiItem, type Abi, type AbiEvent, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNTS, E, startHarness, type ChainH, type Harness } from "../helpers/harness.js";
import { injector, makeWatcher, tamperedClient } from "../helpers/watcher.js";

function fakeEvent(h: ChainH, name: string, vals: (i: { name?: string; type: string }) => unknown) {
  const ev = getAbiItem({ abi: h.abi as Abi, name }) as AbiEvent;
  const all = Object.fromEntries(ev.inputs.map((i) => [i.name!, vals(i)]));
  const nonIdx = ev.inputs.filter((i) => !i.indexed);
  return () => ({
    topics: encodeEventTopics({ abi: [ev], eventName: name, args: Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name!, all[i.name!]])) as never }) as Hex[],
    data: encodeAbiParameters(nonIdx as never, nonIdx.map((i) => all[i.name!]) as never),
  });
}

describe("round-2 RPC hardening", () => {
  let H: Harness;
  beforeAll(async () => {
    H = await startHarness();
  });
  afterAll(() => H?.stop());
  beforeEach(async () => {
    await H.reset();
  });

  for (const control of [false, true]) {
    const tag = control ? "[control, honest RPCs]" : "[one lying RPC]";

    it(`POC-A ${tag}: a fabricated Unpaused cannot acknowledge a forged payout → BSC paused`, async () => {
      let X: bigint | null = null;
      const liar = injector(H.bsc, () => X, fakeEvent(H.bsc, "Unpaused", () => ACCOUNTS.admin.address));
      const t = await makeWatcher(H, { endpoints: { bsc: [{ label: "honest", client: H.bsc.pub }, { label: "liar", client: liar }] } });
      const r = await H.bsc.write(ACCOUNTS.relayer, "release", [22n, ACCOUNTS.user2.address, E(50)]);
      await H.bsc.increaseTime(400);
      X = control ? null : (await H.bsc.latest()).number;
      await H.settle();
      t.clock.now = r.timestamp + 500;
      await t.w.tick();
      expect(await H.isPaused("bsc")).toBe(true);
      expect(t.codes()).not.toContain("MISMATCH_ACKNOWLEDGED");
      expect(t.w.state.derived.bsc.lastUnpaused).toBeNull();
    });

    it(`POC-B ${tag}: a fabricated RefundCancelled cannot drop a refund check → WANTOS paused`, async () => {
      let X: bigint | null = null;
      const liar = injector(H.wantos, () => X, fakeEvent(H.wantos, "RefundCancelled", (i) => (i.type.startsWith("uint") ? 1n : ACCOUNTS.admin.address)));
      const t = await makeWatcher(H, { endpoints: { wantos: [{ label: "honest", client: H.wantos.pub }, { label: "liar", client: liar }] } });
      await H.wantos.write(ACCOUNTS.user1, "approve", [H.wantos.bridge, E(100)], H.wantos.token);
      await H.wantos.write(ACCOUNTS.user1, "bridgeOut", [E(100)]);
      await H.settle();
      await t.w.tick();
      await H.wantos.increaseTime(10);
      const rr = await H.wantos.write(ACCOUNTS.admin, "requestRefund", [1n]);
      await H.wantos.mine(1);
      X = control ? null : (await H.wantos.latest()).number;
      await H.settle();
      t.clock.now = rr.timestamp + 100;
      await t.w.tick();
      expect(t.w.state.derived.pending.map((p) => p.kind)).toEqual(["refund"]);
      t.clock.now = rr.timestamp + 86_400 - 7000;
      await t.w.tick();
      expect(await H.isPaused("wantos")).toBe(true);
    });

    it(`POC-C ${tag}: a fabricated later Deposited(nonce=1) cannot redirect the deposit index → honest B2W NOT paused`, async () => {
      let X: bigint | null = null;
      const liar = injector(H.bsc, () => X, fakeEvent(H.bsc, "Deposited", (i) => (i.name === "nonce" ? 1n : i.type.startsWith("uint") ? E(100) : ACCOUNTS.user2.address)));
      const t = await makeWatcher(H, { endpoints: { bsc: [{ label: "honest", client: H.bsc.pub }, { label: "liar", client: liar }] } });
      await H.bsc.write(ACCOUNTS.user2, "approve", [H.bsc.bridge, E(100)], H.bsc.token);
      const d = await H.bsc.write(ACCOUNTS.user2, "deposit", [E(100), ACCOUNTS.user2.address]);
      await H.bsc.mine(2);
      X = control ? null : (await H.bsc.latest()).number;
      const q = await H.wantos.write(ACCOUNTS.relayer, "queueRelease", [1n, ACCOUNTS.user2.address, E(100)]);
      await H.settle();
      t.clock.now = q.timestamp + 15 * 60 - 179;
      await t.w.tick();
      expect(await H.isPaused("wantos")).toBe(false);
      expect(t.w.state.derived.depositBlocks["1"]).toBe(d.block.toString());
      expect(t.w.state.derived.bsc.sums["deposited"]).toBe(E(100).toString()); // the fake one is not counted
    });
  }

  it("POC-D: a check that was undecidable after its grace period is never silently acknowledged by a later unrelated unpause → BSC paused", async () => {
    let down = true;
    const flaky = tamperedClient(H.wantos, (m) => (down && m === "eth_blockNumber" ? { handled: true, result: new Error("down") } : { handled: false }));
    const t = await makeWatcher(H, { endpoints: { wantos: [{ label: "w-a", client: H.wantos.pub }, { label: "w-flaky", client: flaky }] } });
    const r = await H.bsc.write(ACCOUNTS.relayer, "release", [31n, ACCOUNTS.user2.address, E(50)]);
    await H.settle();
    t.clock.now = r.timestamp + 400;
    await t.w.tick();
    expect(t.codes()).toContain("CHECK_DEFERRED");
    expect(t.sink.alerts.find((a) => a.code === "CHECK_OVERDUE")?.level).toBe(1); // Released: already paid → overdue at grace end
    await H.bsc.increaseTime(400);
    await H.bsc.write(ACCOUNTS.pauser, "pause", []);
    await H.bsc.write(ACCOUNTS.admin, "unpause", []);
    await H.settle();
    t.clock.now += 400;
    await t.w.tick();
    down = false;
    await H.settle();
    t.clock.now += 10;
    await t.w.tick();
    expect(await H.isPaused("bsc")).toBe(true);
    expect(t.codes()).not.toContain("MISMATCH_ACKNOWLEDGED");
  });
});
