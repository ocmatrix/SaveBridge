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
});
