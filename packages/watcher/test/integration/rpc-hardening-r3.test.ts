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

  describe("consensus compromise: no automatic eviction, but a persistently dissenting RPC is named (level 1) and the alert self-closes", () => {
    it("RPC_DISSENTING after ≥5 consecutive dissents, naming the RPC; closed (acked) once it agrees again", async () => {
      let lie = true;
      const liar = tamperedClient(H.bsc, (m, p) => {
        if (!lie || m !== "eth_getBlockByNumber" || typeof p[0] !== "string" || !/^0x[0-9a-f]+$/.test(p[0] as string)) return { handled: false };
        return { handled: true, result: (async () => ({ ...((await (await fetch(H.bsc.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json()) as { result: Record<string, unknown> }).result, hash: `0x${"77".repeat(32)}` }))() };
      });
      const t = await makeWatcher(H, { endpoints: { bsc: three(liar, "bsc-liar") } });
      for (let i = 0; i < 6; i++) {
        await H.bsc.mine(1);
        await H.settle();
        t.clock.now += 5;
        await t.w.tick();
      }
      const a = t.sink.alerts.find((x) => x.code === "RPC_DISSENTING")!;
      expect(a.level).toBe(1);
      expect(JSON.stringify(a.detail)).toContain("bsc-liar");
      expect(t.w.state.meta.openLevel1[a.key!]).toBeDefined();
      lie = false;
      await H.settle();
      t.clock.now += 5;
      await t.w.tick();
      expect(t.w.state.meta.openLevel1[a.key!]).toBeUndefined(); // condition cleared → closed, no 24h repeats
      expect(t.w.state.meta.alertKeys[a.key!]).toBeUndefined();
    });
  });

  it("S-2 / POC-L: during catch-up, one RPC omitting topic-filtered logs does not turn an owner-acknowledged mismatch into a pause", async () => {
    const omit = tamperedClient(H.bsc, (m, p) => {
      const f = p[0] as { topics?: unknown[] } | undefined;
      return m === "eth_getLogs" && f?.topics && f.topics.length > 0 ? { handled: true, result: [] } : { handled: false };
    });
    const t = await makeWatcher(H, { endpoints: { bsc: three(omit, "omit") }, config: (c) => void ((c.chains.bsc.maxBlockRange = 1), (c.maxRangesPerTick = 1)) });
    const r = await forge(73n);
    await H.settle();
    t.clock.now = r.timestamp + 10;
    await t.w.tick();
    expect(t.w.state.derived.pending).toHaveLength(1);
    await H.bsc.increaseTime(400);
    await H.bsc.write(ACCOUNTS.admin, "pause", []);
    await H.bsc.write(ACCOUNTS.wl, "unpause", []);
    await H.settle();
    t.clock.now = r.timestamp + 401;
    await t.w.tick();
    expect(t.codes()).toContain("MISMATCH_ACKNOWLEDGED");
    expect(await H.isPaused("bsc")).toBe(false);
  });

  describe("S-4: timelock events from a single RPC change nothing", () => {
    const w3 = (liar: ReturnType<typeof honest>) => [{ label: "a", client: H.wantos.pub }, { label: "b", client: honest(H.wantos) }, { label: "liar", client: liar }];

    it("POC-F: a fabricated CallScheduled → no level-1 TIMELOCK_PROPOSED, no timelockOps entry, listed as unconfirmed", async () => {
      let on = true;
      const mk = () =>
        fakeLog(bridgeTimelockAbi as Abi, "CallScheduled", (i) =>
          i.name === "id" || i.name === "predecessor" ? (`0x${"42".repeat(32)}` as Hex) : i.name === "target" ? H.wantos.bridge : i.name === "data" ? "0x8456cb59" : i.name === "delay" ? 172_800n : 0n,
        );
      const liar = injectorAt(H.wantos, () => H.wantos.timelock, mk, () => on);
      const t = await makeWatcher(H, { endpoints: { wantos: w3(liar) } });
      await H.settle();
      await t.w.tick();
      on = false;
      await H.settle();
      await t.w.tick();
      expect(t.sink.alerts.filter((a) => a.code === "TIMELOCK_PROPOSED")).toHaveLength(0);
      expect(Object.keys(t.w.state.derived.timelockOps)).toHaveLength(0);
      expect(JSON.stringify(t.sink.alerts.filter((a) => a.code === "RPC_DISAGREE").map((a) => a.detail))).toContain("unconfirmed");
    });

    for (const ev of ["CallExecuted", "Cancelled"]) {
      it(`MA07/MA08: a fabricated ${ev} does not delete a real pending proposal`, async () => {
        const ZERO32 = `0x${"00".repeat(32)}` as Hex;
        const data = "0x8456cb59" as Hex;
        await H.wantos.write(ACCOUNTS.admin, "schedule", [H.wantos.bridge, 0n, data, ZERO32, ZERO32, 48n * 3600n], H.wantos.timelock);
        const id = (await H.wantos.pub.readContract({ address: H.wantos.timelock, abi: bridgeTimelockAbi, functionName: "hashOperation", args: [H.wantos.bridge, 0n, data, ZERO32, ZERO32] })) as Hex;
        let on = false;
        const mk = () => fakeLog(bridgeTimelockAbi as Abi, ev, (i) => (i.name === "id" ? id : i.name === "target" ? H.wantos.bridge : i.name === "data" ? data : 0n));
        const liar = injectorAt(H.wantos, () => H.wantos.timelock, mk, () => on);
        const t = await makeWatcher(H, { endpoints: { wantos: w3(liar) }, startBlock: { bsc: (await H.bsc.latest()).number + 1n, wantos: 0n } });
        await H.settle();
        await t.w.tick();
        expect(Object.keys(t.w.state.derived.timelockOps)).toHaveLength(1);
        on = true;
        await H.wantos.mine(1);
        await H.settle();
        await t.w.tick();
        expect(Object.keys(t.w.state.derived.timelockOps)).toHaveLength(1);
      });
    }
  });

  describe("S-3: no phone storm from one RPC; state-type level-1 alerts close themselves", () => {
    it("POC-G: a fresh fabricated RoleGranted per range → no level-1 KEY_CHANGE; reported inside the level-2 RPC_DISAGREE", async () => {
      const mk = () => fakeLog(H.bsc.abi as Abi, "RoleGranted", (i) => (i.type === "bytes32" ? (`0x${"11".repeat(32)}` as Hex) : ACCOUNTS.attacker.address));
      const liar = injectorAt(H.bsc, () => H.bsc.bridge, mk, () => true);
      const t = await makeWatcher(H, { endpoints: { bsc: three(liar) } });
      for (let i = 0; i < 4; i++) {
        await H.bsc.mine(2);
        await H.settle();
        t.clock.now += 5;
        await t.w.tick();
      }
      expect(t.sink.alerts.filter((a) => a.code === "KEY_CHANGE")).toHaveLength(0);
      const d = t.sink.alerts.filter((a) => a.code === "RPC_DISAGREE");
      expect(d.every((a) => a.level === 2)).toBe(true);
      expect(JSON.stringify(d.map((a) => a.detail))).toContain("KEY_CHANGE");
    });

    it("CURSOR_STUCK closes (acked, key re-armed) once the chain makes progress again", async () => {
      const t = await makeWatcher(H);
      await H.settle();
      await t.w.tick();
      t.clock.now += 601;
      await t.w.tick();
      const keys = Object.keys(t.w.state.meta.openLevel1).filter((k) => k.startsWith("stuck:bsc:"));
      expect(keys.length).toBeGreaterThan(0);
      await H.settle();
      t.clock.now += 5;
      await t.w.tick();
      expect(Object.keys(t.w.state.meta.openLevel1).filter((k) => k.startsWith("stuck:bsc:"))).toHaveLength(0);
    });

    it("CHECK_OVERDUE closes once the check is decided", async () => {
      let down = true;
      const flaky = tamperedClient(H.wantos, (m) => (down && m === "eth_blockNumber" ? { handled: true, result: new Error("down") } : { handled: false }));
      const t = await makeWatcher(H, { endpoints: { wantos: [{ label: "w-a", client: H.wantos.pub }, { label: "w-flaky", client: flaky }] } });
      const r = await forge(81n);
      await H.settle();
      t.clock.now = r.timestamp + 400;
      await t.w.tick();
      const k = Object.keys(t.w.state.meta.openLevel1).find((x) => x.startsWith("overdue:"));
      expect(k).toBeDefined();
      down = false;
      await H.settle();
      t.clock.now += 10;
      await t.w.tick(); // decided (paused)
      expect(await H.isPaused("bsc")).toBe(true);
      expect(t.w.state.meta.openLevel1[k!]).toBeUndefined();
    });
  });

  it("S-5 / MA23: rewind checks snapshot canonicity by consensus; an unverifiable snapshot is NOT restored (falls back towards full replay)", async () => {
    let below: bigint | null = null;
    const flaky = tamperedClient(H.wantos, (m, p) =>
      below !== null && m === "eth_getBlockByNumber" && typeof p[0] === "string" && /^0x[0-9a-f]+$/.test(p[0] as string) && BigInt(p[0] as string) < below
        ? { handled: true, result: new Error("flaky") }
        : { handled: false },
    );
    const t = await makeWatcher(H, { endpoints: { wantos: [{ label: "a", client: H.wantos.pub }, { label: "flaky", client: flaky }] } });
    await H.settle();
    await t.w.tick(); // snapshot S1 — canonical, but only verifiable through the flaky RPC's help
    await H.wantos.write(ACCOUNTS.user1, "approve", [H.wantos.bridge, E(100)], H.wantos.token);
    const fork = await H.wantos.snapshot();
    await H.wantos.write(ACCOUNTS.user1, "bridgeOut", [E(100)]);
    await H.settle();
    t.clock.now = (await H.wantos.latest()).timestamp;
    await t.w.tick();
    const cur = BigInt(t.w.state.derived.wantos.cursor!.number);
    await H.wantos.revert(fork);
    await H.wantos.rpc("evm_setNextBlockTimestamp", [(await H.wantos.latest()).timestamp + 500]);
    await H.wantos.mine(12);
    below = cur;
    await t.w.tick();
    const rw = t.sink.alerts.find((a) => a.code === "STATE_REWOUND")!;
    expect(rw.level).toBe(2);
    expect(rw.detail["restoredTo"]).toBeNull();
  });
});
