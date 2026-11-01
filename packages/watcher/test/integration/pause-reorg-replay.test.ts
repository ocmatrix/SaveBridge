/**
 * Unpause semantics (no pause loops), WANTOS rollback (§9.1-5 / §6.2), cursor catch-up after a restart,
 * and the PAUSER key on a real local chain (pause-only, EnforcedPause = success).
 */
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { PauseExecutor, PauseGuardError, PauseOnlySigner, pauseCall } from "../../src/pauser.js";
import { FileStateStore } from "../../src/state.js";
import { multiRpcPauseReader, viemRawTxSender } from "../../src/wiring.js";
import { MultiRpc } from "../../src/rpc.js";
import { ACCOUNTS, E, startHarness, type Harness } from "../helpers/harness.js";
import { makeWatcher } from "../helpers/watcher.js";

describe("pause semantics, rollback, replay", () => {
  let H: Harness;
  beforeAll(async () => {
    H = await startHarness();
  });
  afterAll(() => H?.stop());
  beforeEach(async () => {
    await H.reset();
  });

  const forge = (nonce: bigint) => H.bsc.write(ACCOUNTS.relayer, "release", [nonce, ACCOUNTS.user2.address, E(50)]);

  it("after the owner unpauses, the old event never re-pauses (even on replay from a stale state); a new one does", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watcher-replay-"));
    const path = join(dir, "state.json");
    const t = await makeWatcher(H, { store: new FileStateStore(path) });
    const r1 = await forge(11n);
    await H.settle();
    t.clock.now = r1.timestamp + 10;
    await t.w.tick(); // ingested, inside grace
    copyFileSync(path, join(dir, "stale.json")); // a state file from before the decision
    t.clock.now = r1.timestamp + 301;
    await t.w.tick();
    expect(await H.isPaused("bsc")).toBe(true);

    // The owner reviews and unpauses later: on chain the Unpaused is after the event's grace period ended.
    await H.bsc.increaseTime(400);
    await H.bsc.write(ACCOUNTS.admin, "unpause", []);
    for (let i = 0; i < 3; i++) {
      await H.settle();
      t.clock.now += 400;
      await t.w.tick();
    }
    expect(await H.isPaused("bsc")).toBe(false);
    expect(t.codes()).toContain("UNPAUSED");
    expect(t.codes().filter((c) => c === "AUTO_PAUSE")).toHaveLength(1);

    // Restart from the stale file: the old forged event is replayed and found mismatching, but it is
    // before the Unpaused block, and the unpause happened after its grace period → alert only.
    const t2 = await makeWatcher(H, { store: new FileStateStore(join(dir, "stale.json")) });
    t2.clock.now = t.clock.now;
    await t2.w.tick();
    expect(await H.isPaused("bsc")).toBe(false);
    expect(t2.codes()).toContain("MISMATCH_ACKNOWLEDGED");
    expect(t2.codes()).not.toContain("AUTO_PAUSE");

    // A NEW forged payout after the unpause pauses again.
    const r2 = await forge(12n);
    await H.settle();
    t.clock.now = r2.timestamp + 301;
    await t.w.tick();
    expect(await H.isPaused("bsc")).toBe(true);
    expect(t.codes().filter((c) => c === "AUTO_PAUSE")).toHaveLength(2);
  });

  it("POC1: an unrelated pause + unpause INSIDE the grace window does not acknowledge a forged payout → BSC paused", async () => {
    const t = await makeWatcher(H);
    const r = await forge(13n);
    await H.settle();
    t.clock.now = r.timestamp + 10;
    await t.w.tick(); // ingested, in grace
    await H.bsc.write(ACCOUNTS.admin, "pause", []);
    await H.bsc.write(ACCOUNTS.wl, "unpause", []); // e.g. maintenance; decision 17: either wallet may unpause
    await H.settle();
    t.clock.now = r.timestamp + 400;
    await t.w.tick();
    await t.w.tick();
    expect(await H.isPaused("bsc")).toBe(true);
    expect(t.codes()).toContain("AUTO_PAUSE");
    expect(t.codes()).not.toContain("MISMATCH_ACKNOWLEDGED");
  });

  it("an unpause not yet under the safe head is not used to acknowledge anything (look-ahead stops at finalized)", async () => {
    const t = await makeWatcher(H);
    const r = await forge(14n);
    await H.settle();
    t.clock.now = r.timestamp + 10;
    await t.w.tick();
    await H.bsc.write(ACCOUNTS.admin, "pause", []);
    await H.bsc.increaseTime(400);
    await H.bsc.write(ACCOUNTS.wl, "unpause", []); // after the grace period, but not finalized yet
    t.clock.now = r.timestamp + 401;
    await t.w.tick();
    expect(await H.isPaused("bsc")).toBe(true);
    expect(t.codes()).toContain("AUTO_PAUSE");
  });

  it("WANTOS block-hash change → level-1 alert and both chains paused; state rewound and re-ingested", async () => {
    const t = await makeWatcher(H);
    await H.wantos.write(ACCOUNTS.user1, "approve", [H.wantos.bridge, E(100)], H.wantos.token);
    const fork = await H.wantos.snapshot();
    await H.wantos.write(ACCOUNTS.user1, "bridgeOut", [E(100)]);
    await H.settle();
    t.clock.now = (await H.wantos.latest()).timestamp;
    await t.w.tick();
    const before = t.w.state.derived.wantos.cursor!;
    expect(t.w.state.derived.wantos.sums["bridgeOut"]).toBe(E(100).toString());

    await H.wantos.revert(fork); // the chain "rolls back" and builds a different history
    await H.wantos.rpc("evm_setNextBlockTimestamp", [(await H.wantos.latest()).timestamp + 500]);
    await H.wantos.mine(12);
    expect((await H.wantos.pub.getBlock({ blockNumber: BigInt(before.number) })).hash).not.toBe(before.hash);

    const rep = await t.w.tick();
    expect(rep.paused.sort()).toEqual(["bsc", "wantos"]);
    expect(await H.isPaused("bsc")).toBe(true);
    expect(await H.isPaused("wantos")).toBe(true);
    const a = t.sink.alerts.find((x) => x.code === "WANTOS_REORG")!;
    expect(a.level).toBe(1);
    // the orphaned BridgeOut no longer counts
    expect(t.w.state.derived.wantos.sums["bridgeOut"] ?? "0").toBe("0");
    // the next tick does not re-alert / re-pause
    await t.w.tick();
    expect(t.codes().filter((c) => c === "WANTOS_REORG")).toHaveLength(1);
  });

  it("cursor catch-up: stop the watcher, produce events, restart from the file → events processed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watcher-cursor-"));
    const path = join(dir, "state.json");
    const t1 = await makeWatcher(H, { store: new FileStateStore(path) });
    await H.settle();
    await t1.w.tick();
    const c1 = t1.w.state.derived.bsc.cursor!.number;
    // watcher is "down" while these happen
    await H.wantos.write(ACCOUNTS.user1, "approve", [H.wantos.bridge, E(300)], H.wantos.token);
    await H.wantos.write(ACCOUNTS.user1, "bridgeOut", [E(300)]);
    const r = await forge(21n);
    await H.settle();
    const t2 = await makeWatcher(H, { store: new FileStateStore(path) });
    expect(t2.w.state.derived.bsc.cursor!.number).toBe(c1);
    t2.clock.now = r.timestamp + 301;
    await t2.w.tick();
    expect(BigInt(t2.w.state.derived.bsc.cursor!.number)).toBeGreaterThan(BigInt(c1));
    expect(t2.w.state.derived.wantos.sums["bridgeOut"]).toBe(E(300).toString());
    expect(await H.isPaused("bsc")).toBe(true);
  });

  it("BSC finalized unavailable → wait + level-2 alert, no progress", async () => {
    const { tamperedClient } = await import("../helpers/watcher.js");
    const noFinal = () =>
      tamperedClient(H.bsc, (m, p) => (m === "eth_getBlockByNumber" && p[0] === "finalized" ? { handled: true, result: new Error("finalized not supported") } : { handled: false }));
    const t = await makeWatcher(H, { endpoints: { bsc: [{ label: "a", client: noFinal() }, { label: "b", client: noFinal() }] } });
    await H.settle();
    await t.w.tick();
    expect(t.w.state.derived.bsc.cursor).toBeNull();
    expect(t.sink.alerts.find((a) => a.code === "BSC_NO_FINALIZED")!.level).toBe(2);
  });

  describe("PAUSER key on a local chain", () => {
    it("can send pause() and nothing else; a rejected call never reaches the chain", async () => {
      const sender = viemRawTxSender(H.bsc.wallet(ACCOUNTS.pauser), ACCOUNTS.pauser);
      const signer = new PauseOnlySigner(sender, [H.bsc.bridge]);
      const n0 = await H.bsc.pub.getTransactionCount({ address: ACCOUNTS.pauser.address });
      for (const data of ["0x3f4ba83a", "0x8456cb5900", "0x2f2ff15d"] as Hex[]) {
        // unpause(), pause()+junk, grantRole selector
        await expect(signer.sendPause({ to: H.bsc.bridge, data } as never)).rejects.toBeInstanceOf(PauseGuardError);
      }
      await expect(signer.sendPause({ to: H.bsc.token, data: "0x8456cb59" } as never)).rejects.toBeInstanceOf(PauseGuardError);
      expect(await H.bsc.pub.getTransactionCount({ address: ACCOUNTS.pauser.address })).toBe(n0);
      await signer.sendPause(pauseCall(H.bsc.bridge as Address));
      expect(await H.isPaused("bsc")).toBe(true);
    });

    it("pause() on an already-paused bridge reverts EnforcedPause on chain and is treated as success", async () => {
      await H.bsc.write(ACCOUNTS.admin, "pause", []);
      const rpc = new MultiRpc("bsc", [{ label: "a", client: H.bsc.pub }], 1);
      const real = multiRpcPauseReader(rpc, H.bsc.bridge);
      let lies = 1;
      const staleReader = { paused: async () => (lies-- > 0 ? false : real.paused()), waitReceipt: real.waitReceipt };
      const signer = new PauseOnlySigner(viemRawTxSender(H.bsc.wallet(ACCOUNTS.pauser), ACCOUNTS.pauser), [H.bsc.bridge]);
      const ex = new PauseExecutor({ bsc: signer, wantos: signer }, { bsc: staleReader, wantos: staleReader }, { bsc: H.bsc.bridge, wantos: H.bsc.bridge }, { attempts: 1, backoffMs: 0 });
      const out = await ex.pause("bsc");
      expect(out).toMatchObject({ ok: true, status: "already-paused" });
    });

    it("a revoked PAUSER key fails to pause → PAUSE_FAILED level 1, check stays pending for retry", async () => {
      const t = await makeWatcher(H);
      await H.bsc.write(ACCOUNTS.admin, "revokeKey", ["0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a", ACCOUNTS.pauser.address]);
      const r = await forge(31n);
      await H.settle();
      t.clock.now = r.timestamp + 301;
      await t.w.tick();
      expect(await H.isPaused("bsc")).toBe(false);
      const f = t.sink.alerts.find((a) => a.code === "PAUSE_FAILED")!;
      expect(f.level).toBe(1);
      expect(t.codes()).toContain("PAUSER_REVOKED");
      expect(t.w.state.derived.pending).toHaveLength(1);
    });
  });
});
