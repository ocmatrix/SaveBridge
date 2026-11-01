/**
 * GATE2 round 1 regressions (aligner POC2 / POC3): a single lying or silent RPC must not be able to
 * hide a forged payout (A1) or fake a successful pause (A2).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNTS, E, startHarness, type Harness } from "../helpers/harness.js";
import { makeWatcher, tamperedClient } from "../helpers/watcher.js";

describe("RPC hardening", () => {
  let H: Harness;
  beforeAll(async () => {
    H = await startHarness();
  });
  afterAll(() => H?.stop());
  beforeEach(async () => {
    await H.reset();
  });
  const forge = (nonce: bigint) => H.bsc.write(ACCOUNTS.relayer, "release", [nonce, ACCOUNTS.user2.address, E(50)]);

  describe("A1 — logs are read from every RPC (union), not only the primary", () => {
    it("POC2: primary silently drops eth_getLogs → the forged payout is still seen, checked and BSC paused", async () => {
      const silent = tamperedClient(H.bsc, (m) => (m === "eth_getLogs" ? { handled: true, result: [] } : { handled: false }));
      const t = await makeWatcher(H, { endpoints: { bsc: [{ label: "silent-primary", client: silent }, { label: "honest", client: H.bsc.pub }] } });
      const r = await forge(22n);
      await H.settle();
      t.clock.now = r.timestamp + 10;
      await t.w.tick();
      expect(t.w.state.derived.pending.map((p) => p.kind)).toEqual(["w2b"]);
      expect(t.codes()).toContain("RPC_DISAGREE"); // the omission itself is reported
      t.clock.now = r.timestamp + 400;
      await t.w.tick();
      expect(await H.isPaused("bsc")).toBe(true);
      expect(t.codes()).toContain("AUTO_PAUSE");
    });

    it("fewer than minRpcAgreement RPCs answer getLogs → cursor does not advance, alert raised", async () => {
      const broken = tamperedClient(H.bsc, (m) => (m === "eth_getLogs" ? { handled: true, result: new Error("getLogs down") } : { handled: false }));
      const t = await makeWatcher(H, { endpoints: { bsc: [{ label: "honest-primary", client: H.bsc.pub }, { label: "broken", client: broken }] } });
      await forge(23n);
      await H.settle();
      await t.w.tick();
      expect(t.w.state.derived.bsc.cursor).toBeNull();
      expect(t.codes()).toContain("RPC_UNREACHABLE");
    });

    it("B1: a cursor that cannot move for more than 10 minutes escalates to level 1 (CURSOR_STUCK)", async () => {
      const broken = tamperedClient(H.bsc, (m) => (m === "eth_getLogs" ? { handled: true, result: new Error("getLogs down") } : { handled: false }));
      const t = await makeWatcher(H, { endpoints: { bsc: [{ label: "a", client: H.bsc.pub }, { label: "broken", client: broken }] } });
      await H.settle();
      await t.w.tick();
      t.clock.now += 599;
      await t.w.tick();
      expect(t.sink.alerts.filter((x) => x.code === "CURSOR_STUCK" && x.chain === "bsc")).toHaveLength(0);
      t.clock.now += 2;
      await t.w.tick();
      const a = t.sink.alerts.find((x) => x.code === "CURSOR_STUCK" && x.chain === "bsc")!;
      expect(a.level).toBe(1);
      expect(a.chain).toBe("bsc");
    });

    it("safe head is the minimum across RPCs: a primary claiming a far-ahead finalized block cannot move the cursor past the others", async () => {
      const ahead = tamperedClient(H.bsc, (m, p) =>
        m === "eth_getBlockByNumber" && p[0] === "finalized" ? { handled: true, result: new Error("no finalized here") } : { handled: false },
      );
      const t = await makeWatcher(H, { endpoints: { bsc: [{ label: "a", client: ahead }, { label: "b", client: H.bsc.pub }] } });
      await H.settle();
      await t.w.tick();
      // only one RPC can report finalized → not enough to advance
      expect(t.w.state.derived.bsc.cursor).toBeNull();
      expect(t.codes()).toContain("BSC_NO_FINALIZED");
    });
  });

  describe("A2 — a pause counts only when ≥2 RPCs confirm paused()", () => {
    const pausedCall = "0x5c975abb";
    it("POC3: primary lies paused()==true → the watcher still sends pause() and the chain is really paused", async () => {
      const liar = tamperedClient(H.bsc, (m, p) => {
        const d = p[0] as { data?: string; input?: string } | undefined;
        const data = d?.data ?? d?.input;
        return m === "eth_call" && typeof data === "string" && data.startsWith(pausedCall) ? { handled: true, result: `0x${"0".repeat(63)}1` } : { handled: false };
      });
      const t = await makeWatcher(H, { endpoints: { bsc: [{ label: "liar", client: liar }, { label: "honest", client: H.bsc.pub }] } });
      const r = await forge(24n);
      await H.settle();
      t.clock.now = r.timestamp + 400;
      await t.w.tick();
      expect(await H.isPaused("bsc")).toBe(true);
      expect(t.codes()).toContain("AUTO_PAUSE");
    });

    it("a forged EnforcedPause on the send path (bridge not paused) is NOT success → PAUSE_FAILED level 1, no AUTO_PAUSE", async () => {
      const t = await makeWatcher(H, {
        wrapSender: (inner) => ({
          address: inner.address,
          send: async () => {
            throw new Error("execution reverted: custom error 0xd93c0665");
          },
        }),
      });
      const r = await forge(25n);
      await H.settle();
      t.clock.now = r.timestamp + 400;
      await t.w.tick();
      expect(await H.isPaused("bsc")).toBe(false);
      expect(t.codes()).not.toContain("AUTO_PAUSE");
      expect(t.sink.alerts.find((a) => a.code === "PAUSE_FAILED")!.level).toBe(1);
      expect(t.w.state.derived.pending).toHaveLength(1);
    });
  });
});
