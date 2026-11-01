import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorld, whitelistBoth, buildRelayer, bridgeOut, deposit, balanceOf, finalizeBsc, confirmWantos, WANTOS_ID, BSC_ID, type World } from "./helpers/system";
import { U } from "./helpers/deploy";
import { w2bEventKey, b2wEventKey } from "../src/eventKey";
import { OrderRepo } from "../src/orders";

/**
 * DESIGN §13 PR-3 / task brief: end-to-end on two local anvils with the real PR-1 contracts.
 * W2B small → release; W2B large → queue → execute after releaseDelay (12h); B2W → queue 15 min → execute.
 */
describe("E2E (anvil, real PR-1 contracts)", () => {
  let world: World;
  beforeAll(async () => {
    world = await startWorld();
    await whitelistBoth(world, [world.act.user.address, world.act.user2.address]);
  });
  afterAll(async () => world?.stop());

  it("W2B small amount: BridgeOut → 6 confirmations → release → BSC finalized → RELEASED", async () => {
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    const before = await balanceOf(world.bsc, world.b.token, world.act.user.address);
    await bridgeOut(world, world.act.user, 100n * U);
    await sys.relayer.tick();
    const key = w2bEventKey({ wantosChainId: BigInt(WANTOS_ID), wantosBridge: world.w.bridge, orderId: 1n });
    expect(await repo.get(key)).toBeNull(); // not yet 6 confirmations
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("SUBMITTED");
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("SUBMITTED"); // mined but not finalized
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("RELEASED");
    expect(await balanceOf(world.bsc, world.b.token, world.act.user.address)).toBe(before + 100n * U);
    const att = await sys.db.query<{ action: string; state: string }>("select action, state from tx_attempts");
    expect(att.rows).toEqual([{ action: "release", state: "mined" }]);
  });

  it("W2B large amount: queueRelease → QUEUED → executeRelease after 12h → RELEASED", async () => {
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    const before = await balanceOf(world.bsc, world.b.token, world.act.user2.address);
    await bridgeOut(world, world.act.user2, 1500n * U); // > largeThreshold 1000
    await confirmWantos(world);
    await sys.relayer.tick();
    const key = w2bEventKey({ wantosChainId: BigInt(WANTOS_ID), wantosBridge: world.w.bridge, orderId: 2n });
    expect((await repo.get(key))!.status).toBe("SUBMITTED");
    await finalizeBsc(world);
    await sys.relayer.tick();
    const q = (await repo.get(key))!;
    expect(q.status).toBe("QUEUED");
    expect(q.executableAt).not.toBeNull();
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("QUEUED"); // not due
    await world.bsc.testClient.increaseTime({ seconds: 12 * 3600 });
    await world.bsc.testClient.mine({ blocks: 1 });
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("SUBMITTED");
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("RELEASED");
    expect(await balanceOf(world.bsc, world.b.token, world.act.user2.address)).toBe(before + 1500n * U);
    const att = await sys.db.query<{ action: string }>("select action from tx_attempts where state = 'mined' order by id");
    expect(att.rows.map((r) => r.action)).toEqual(["queueRelease", "executeRelease"]);
  });

  it("B2W: Deposited → finalized → queueRelease → QUEUED 15 min → executeRelease → RELEASED", async () => {
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    const recipient = world.act.pauser.address; // B2W does not check the whitelist
    const before = await balanceOf(world.wantos, world.w.token, recipient);
    await deposit(world, world.act.user, 50n * U, recipient);
    await sys.relayer.tick();
    const key = b2wEventKey({ bscChainId: BigInt(BSC_ID), bscVault: world.b.bridge, depositNonce: 1n });
    expect(await repo.get(key)).toBeNull(); // not finalized yet
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("SUBMITTED");
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("QUEUED");
    await world.wantos.testClient.increaseTime({ seconds: 14 * 60 });
    await world.wantos.testClient.mine({ blocks: 1 });
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("QUEUED");
    await world.wantos.testClient.increaseTime({ seconds: 61 });
    await world.wantos.testClient.mine({ blocks: 1 });
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("SUBMITTED");
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("RELEASED");
    expect(await balanceOf(world.wantos, world.w.token, recipient)).toBe(before + 50n * U);
  });

  it("run loop: ticks until aborted, alerts and continues when a tick throws", async () => {
    const sys = await buildRelayer(world);
    let n = 0;
    const orig = sys.relayer.tick.bind(sys.relayer);
    sys.relayer.tick = async () => {
      n++;
      if (n === 1) throw new Error("transient");
      return orig();
    };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    await sys.relayer.run({ intervalMs: 50, signal: ac.signal });
    expect(n).toBeGreaterThan(1);
    expect(sys.alerts.byKind("LOOP_ERROR")).toHaveLength(1);
  });

  it("refuses to start against the wrong chain", async () => {
    await expect(buildRelayer(world, { wantos: { ...(await buildRelayer(world)).relayer.deps.wantos, chainId: 13555 } })).rejects.toThrow(/chain id/);
  });
});
