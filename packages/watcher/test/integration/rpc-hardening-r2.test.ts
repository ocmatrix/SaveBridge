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

  describe("single-RPC protections (mutation survivors R02 / R34 / R31 / R05 / R06 / R13)", () => {
    const blockLie = (h: ChainH, on: () => boolean, edit: (b: Record<string, unknown>) => void) =>
      tamperedClient(h, (m, p) => {
        if (!on() || m !== "eth_getBlockByNumber" || typeof p[0] !== "string" || !/^0x[0-9a-f]+$/.test(p[0] as string)) return { handled: false };
        return {
          handled: true,
          result: (async () => {
            const j = (await (await fetch(h.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json()) as { result: Record<string, unknown> };
            edit(j.result);
            return j.result;
          })(),
        };
      });

    it("R02: a primary lying once about a range-end block hash cannot plant a fake cursor (no false WANTOS rollback)", async () => {
      let lie = true;
      const liar = blockLie(H.wantos, () => lie, (b) => void (b["hash"] = `0x${"77".repeat(32)}`));
      const t = await makeWatcher(H, { endpoints: { wantos: [{ label: "liar", client: liar }, { label: "honest", client: H.wantos.pub }] } });
      await H.settle();
      await t.w.tick();
      lie = false;
      await H.settle();
      await t.w.tick();
      await t.w.tick();
      expect(t.codes()).not.toContain("WANTOS_REORG");
      expect(await H.isPaused("bsc")).toBe(false);
      expect(await H.isPaused("wantos")).toBe(false);
      expect(t.w.state.derived.wantos.cursor).not.toBeNull();
    });

    it("R34: a primary lying once about a log's block timestamp cannot push decideAt into the far future", async () => {
      let lie = true;
      const liar = blockLie(H.bsc, () => lie, (b) => void (b["timestamp"] = `0x${(BigInt(b["timestamp"] as string) + 10_000_000n).toString(16)}`));
      const t = await makeWatcher(H, { endpoints: { bsc: [{ label: "liar", client: liar }, { label: "honest", client: H.bsc.pub }] } });
      const r = await H.bsc.write(ACCOUNTS.relayer, "release", [51n, ACCOUNTS.user2.address, E(50)]);
      await H.settle();
      t.clock.now = r.timestamp + 10;
      await t.w.tick();
      lie = false;
      t.clock.now = r.timestamp + 400;
      await t.w.tick();
      expect(await H.isPaused("bsc")).toBe(true);
    });

    it("R31: the Unpaused look-ahead is a consensus read — a fabricated Unpaused from one RPC does not acknowledge", async () => {
      let X: bigint | null = null;
      const liar = injector(H.bsc, () => X, fakeEvent(H.bsc, "Unpaused", () => ACCOUNTS.admin.address), { withTopics: true });
      const t = await makeWatcher(H, {
        endpoints: { bsc: [{ label: "liar", client: liar }, { label: "honest", client: H.bsc.pub }] },
        config: (c) => void ((c.chains.bsc.maxBlockRange = 1), (c.maxRangesPerTick = 1)),
      });
      const r = await H.bsc.write(ACCOUNTS.relayer, "release", [52n, ACCOUNTS.user2.address, E(50)]);
      await H.settle();
      t.clock.now = r.timestamp + 10;
      await t.w.tick(); // forged payout ingested, cursor lags behind the safe head
      await H.bsc.increaseTime(400);
      await H.bsc.mine(5);
      X = (await H.bsc.pub.getBlock({ blockTag: "finalized" })).number;
      t.clock.now = r.timestamp + 401;
      await t.w.tick();
      expect(await H.isPaused("bsc")).toBe(true);
      expect(t.codes()).not.toContain("MISMATCH_ACKNOWLEDGED");
    });

    it("R05: the safe head is the minimum — a primary reporting 'latest' as finalized cannot pull the cursor past honest finality", async () => {
      const liar = tamperedClient(H.bsc, (m, p) =>
        m === "eth_getBlockByNumber" && p[0] === "finalized"
          ? { handled: true, result: (async () => ((await (await fetch(H.bsc.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: ["latest", p[1]] }) })).json()) as { result: unknown }).result)() }
          : { handled: false },
      );
      const t = await makeWatcher(H, { endpoints: { bsc: [{ label: "liar", client: liar }, { label: "honest", client: H.bsc.pub }] } });
      await H.settle();
      await H.bsc.mine(5);
      await t.w.tick();
      const fin = (await H.bsc.pub.getBlock({ blockTag: "finalized" })).number;
      expect(BigInt(t.w.state.derived.bsc.cursor!.number)).toBeLessThanOrEqual(fin);
    });

    it("R06: WANTOS head needs ≥ minRpcAgreement answers — one RPC failing eth_blockNumber stops progress with an alert", async () => {
      const flaky = tamperedClient(H.wantos, (m) => (m === "eth_blockNumber" ? { handled: true, result: new Error("down") } : { handled: false }));
      const t = await makeWatcher(H, { endpoints: { wantos: [{ label: "a", client: H.wantos.pub }, { label: "flaky", client: flaky }] } });
      await H.settle();
      await t.w.tick();
      expect(t.w.state.derived.wantos.cursor).toBeNull();
      expect(t.codes()).toContain("RPC_UNREACHABLE");
    });

    it("R13: a failed range rolls back ALL derived state (here: the mint total), not only the sums", async () => {
      const t = await makeWatcher(H);
      await H.wantos.write(ACCOUNTS.tokenDeployer, "mint", [ACCOUNTS.attacker.address, E(7)], H.wantos.token);
      await H.wantos.write(ACCOUNTS.user1, "approve", [H.wantos.bridge, E(20)], H.wantos.token);
      await H.wantos.write(ACCOUNTS.user1, "bridgeOut", [E(20)]);
      await H.settle();
      const w = t.w as unknown as { onBridge: (c: string, l: { name: string }) => Promise<void> };
      const orig = w.onBridge.bind(t.w);
      let n = 0;
      w.onBridge = async (c, l) => {
        if (l.name === "BridgeOut" && n++ === 0) throw new Error("boom");
        return orig(c, l);
      };
      await t.w.tick();
      await t.w.tick();
      expect(t.w.state.derived.mintTotal).toBe(E(7).toString());
    });
  });
});
