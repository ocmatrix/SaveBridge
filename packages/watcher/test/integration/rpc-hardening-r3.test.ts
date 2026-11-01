/**
 * GATE2 round 3 regressions (aligner POC-M1/M2/E/J/L/F/G + mutation gaps). Each test asserts the desired
 * behaviour; the POCs were red on the round-2 HEAD.
 */
import { bridgeTimelockAbi } from "@bridge/abi";
import { type Abi, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNTS, E, startHarness, type Harness } from "../helpers/harness.js";
import { fakeLog, honest, injector, injectorAt, logRewriter, makeWatcher, stalledNode, tamperedClient } from "../helpers/watcher.js";

describe("round-3 hardening", () => {
  let H: Harness;
  beforeAll(async () => {
    H = await startHarness();
  });
  afterAll(() => H?.stop());
  beforeEach(async () => {
    await H.reset();
  });
  const forge = (nonce: bigint) => H.bsc.write(ACCOUNTS.relayer, "release", [nonce, ACCOUNTS.user2.address, E(50)]);
  const three = (liar: ReturnType<typeof honest>, label = "liar") => [{ label: "a", client: H.bsc.pub }, { label: "b", client: honest(H.bsc) }, { label, client: liar }];

  describe("A-1: confirmations count distinct RPCs, not entries", () => {
    it("POC-M1: one RPC returning a fabricated Unpaused TWICE does not acknowledge a forged payout", async () => {
      let X: bigint | null = null;
      const liar = injectorAt(H.bsc, () => H.bsc.bridge, () => fakeLog(H.bsc.abi as Abi, "Unpaused", () => ACCOUNTS.admin.address), () => X !== null, { times: 2, fixedTx: `0x${"ab".repeat(32)}` });
      const t = await makeWatcher(H, { endpoints: { bsc: three(liar) } });
      const r = await forge(22n);
      await H.bsc.increaseTime(400);
      X = (await H.bsc.latest()).number;
      await H.settle();
      t.clock.now = r.timestamp + 500;
      await t.w.tick();
      expect(t.w.state.derived.bsc.lastUnpaused).toBeNull();
      expect(await H.isPaused("bsc")).toBe(true);
    });

    it("POC-M2: one RPC returning a fabricated Deposited TWICE does not enter sums / deposit index", async () => {
      let on = false;
      const liar = injectorAt(H.bsc, () => H.bsc.bridge, () => fakeLog(H.bsc.abi as Abi, "Deposited", (i) => (i.name === "nonce" ? 7n : i.type.startsWith("uint") ? E(100) : ACCOUNTS.user2.address)), () => on, { times: 2, fixedTx: `0x${"ab".repeat(32)}` });
      const t = await makeWatcher(H, { endpoints: { bsc: three(liar) } });
      on = true;
      await H.settle();
      await t.w.tick();
      expect(t.w.state.derived.bsc.sums["deposited"] ?? "0").toBe("0");
      expect(t.w.state.derived.depositBlocks["7"]).toBeUndefined();
      expect(t.codes()).toContain("RPC_DISAGREE"); // the duplicate itself is reported
    });
  });

  describe("B-1: stale-fork variants are removed BEFORE counting confirmations", () => {
    for (const staleFirst of [false, true]) {
      it(`POC-J${staleFirst ? " (stale RPC listed first, MA03)" : ""}: a stale-fork RPC returning the honest log with another blockHash does not un-confirm it`, async () => {
        let X: bigint | null = null;
        const stale = logRewriter(H.bsc, () => X, (l) => ({ ...l, blockHash: `0x${"99".repeat(32)}` }));
        const eps = staleFirst ? [{ label: "stale", client: stale }, { label: "a", client: H.bsc.pub }, { label: "b", client: honest(H.bsc) }] : three(stale, "stale");
        const t = await makeWatcher(H, { endpoints: { bsc: eps } });
        const f = await H.bsc.write(ACCOUNTS.admin, "fund", [E(1)]);
        X = f.block;
        await H.settle();
        await t.w.tick();
        expect(t.codes()).toContain("RPC_DISAGREE");
        expect(t.w.state.derived.bsc.sums["funded"]).toBe(E(1).toString());
      });
    }

    it("MA02 / MA04: any dissenting content at a position blocks confirmation (no plain majority, data is part of the identity)", async () => {
      let X: bigint | null = null;
      const tamper = logRewriter(H.bsc, () => X, (l) => ({ ...l, data: `0x${(10n ** 30n).toString(16).padStart(64, "0")}` }));
      const t = await makeWatcher(H, { endpoints: { bsc: [{ label: "tamper", client: tamper }, { label: "a", client: H.bsc.pub }, { label: "b", client: honest(H.bsc) }] } });
      const f = await H.bsc.write(ACCOUNTS.admin, "fund", [E(1)]);
      X = f.block;
      await H.settle();
      await t.w.tick();
      expect(t.w.state.derived.bsc.sums["funded"]).toBeUndefined(); // neither the tampered nor the majority value
      const d = t.sink.alerts.find((a) => a.code === "RPC_DISAGREE")!;
      expect(JSON.stringify(d.detail)).toContain("unconfirmed");
    });
  });

  describe("A-2: liveness reads use the minAgree-th largest head; a frozen head is 'stuck'", () => {
    it("POC-E: one of 3 BSC nodes stopped syncing → the cursor keeps moving, RPC_LAGGING is raised, and the forged payout is escalated", async () => {
      let frozen: bigint | null = null;
      const t = await makeWatcher(H, {
        endpoints: { bsc: [{ label: "a", client: H.bsc.pub }, { label: "b", client: honest(H.bsc) }, { label: "stalled", client: stalledNode(H.bsc, () => frozen) }] },
        config: (c) => void (c.chains.bsc.maxLagBlocks = 5),
      });
      await H.settle();
      await t.w.tick();
      frozen = (await H.bsc.pub.getBlock({ blockTag: "finalized" })).number;
      const r = await forge(71n);
      await H.settle();
      t.clock.now = r.timestamp + 400;
      await t.w.tick();
      for (let i = 0; i < 3; i++) {
        await H.bsc.mine(2);
        t.clock.now += 700;
        await t.w.tick();
      }
      expect(BigInt(t.w.state.derived.bsc.cursor!.number)).toBeGreaterThan(frozen);
      expect(t.codes()).toContain("RPC_LAGGING");
      const level1 = t.sink.alerts.filter((a) => a.level === 1).map((a) => a.code);
      expect((await H.isPaused("bsc")) || level1.some((c) => ["CURSOR_STUCK", "CHECK_OVERDUE", "RPC_DISSENTING"].includes(c))).toBe(true);
    });

    it("a head that does not move for > cursorStallSeconds is stuck even when the cursor is caught up", async () => {
      const t = await makeWatcher(H);
      await H.settle();
      await t.w.tick();
      t.clock.now += 601;
      await t.w.tick(); // no new BSC / WANTOS blocks at all
      expect(t.sink.alerts.find((a) => a.code === "CURSOR_STUCK")?.level).toBe(1);
    });

    it("MA19: CURSOR_STUCK also fires while the head itself is unavailable", async () => {
      const noFinal = () => tamperedClient(H.bsc, (m, p) => (m === "eth_getBlockByNumber" && p[0] === "finalized" ? { handled: true, result: new Error("no finalized") } : { handled: false }));
      const t = await makeWatcher(H, { endpoints: { bsc: [{ label: "a", client: noFinal() }, { label: "b", client: noFinal() }] } });
      await t.w.tick();
      t.clock.now += 601;
      await t.w.tick();
      expect(t.sink.alerts.find((a) => a.code === "CURSOR_STUCK" && a.chain === "bsc")?.level).toBe(1);
    });
  });
});
