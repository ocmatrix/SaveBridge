import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, pad, toHex } from "viem";
import { startWorld, whitelistBoth, buildRelayer, bridgeOut, deposit, balanceOf, finalizeBsc, confirmWantos, WANTOS_ID, BSC_ID, type World } from "./helpers/system";
import { U } from "./helpers/deploy";
import { w2bEventKey, b2wEventKey } from "../src/eventKey";
import { OrderRepo } from "../src/orders";

/** LOCAL CHECK: vault short of USDT -> the payout waits -> the vault is topped up -> the payout resumes by itself. */
describe("reserve shortage and automatic resume (anvil, real contracts)", () => {
  let world: World;
  beforeAll(async () => {
    world = await startWorld();
    await whitelistBoth(world, [world.act.user.address, world.act.user2.address]);
  });
  afterAll(async () => world?.stop());

  const slot = () => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [world.b.bridge, 0n]));
  const setVault = (v: bigint) => world.bsc.testClient.setStorageAt({ address: world.b.token, index: slot(), value: pad(toHex(v)) });

  it("small order: vault empty -> WAITING(reserve) + one alert, stays waiting -> top up -> released with no manual step", async () => {
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    const full = await balanceOf(world.bsc, world.b.token, world.b.bridge);
    const before = await balanceOf(world.bsc, world.b.token, world.act.user.address);
    await setVault(0n);
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    const key = w2bEventKey({ wantosChainId: BigInt(WANTOS_ID), wantosBridge: world.w.bridge, orderId: 1n });
    expect((await repo.get(key))!).toMatchObject({ status: "WAITING", reason: "reserve" });
    for (let i = 0; i < 3; i++) await sys.relayer.tick(); // many ticks while short: still waiting, no storm of alerts
    expect((await repo.get(key))!).toMatchObject({ status: "WAITING", reason: "reserve" });
    expect(sys.alerts.byKind("RESERVE_LOW").length).toBe(1);
    expect(await balanceOf(world.bsc, world.b.token, world.act.user.address)).toBe(before);

    await setVault(full); // the owner tops the vault up
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("SUBMITTED");
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("RELEASED");
    expect(await balanceOf(world.bsc, world.b.token, world.act.user.address)).toBe(before + 100n * U);
  });

  it("large queued order: vault drained before it is due -> executeRelease cannot pay -> waits -> top up -> paid", async () => {
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    const full = await balanceOf(world.bsc, world.b.token, world.b.bridge);
    const before = await balanceOf(world.bsc, world.b.token, world.act.user2.address);
    await bridgeOut(world, world.act.user2, 1500n * U); // > largeThreshold: queued 12h
    await confirmWantos(world);
    await sys.relayer.tick();
    const key = w2bEventKey({ wantosChainId: BigInt(WANTOS_ID), wantosBridge: world.w.bridge, orderId: 2n });
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("QUEUED");
    await setVault(0n); // the reserve disappears while the order is queued
    await world.bsc.testClient.increaseTime({ seconds: 12 * 3600 });
    await world.bsc.testClient.mine({ blocks: 1 });
    await sys.relayer.tick();
    await sys.relayer.tick();
    const waiting = (await repo.get(key))!;
    expect(["QUEUED", "WAITING"]).toContain(waiting.status); // not FAILED, not lost
    expect(waiting.status).not.toBe("FAILED");
    expect(await balanceOf(world.bsc, world.b.token, world.act.user2.address)).toBe(before);

    await setVault(full);
    await sys.relayer.tick();
    await sys.relayer.tick();
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("RELEASED");
    expect(await balanceOf(world.bsc, world.b.token, world.act.user2.address)).toBe(before + 1500n * U);
  });

  it("BSC -> WANTOS deposit: the WANTOS side is short of the token -> waits -> top up -> the deposit is paid out", async () => {
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    const wslot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [world.w.bridge, 0n]));
    const fullW = await balanceOf(world.wantos, world.w.token, world.w.bridge);
    const recipient = world.act.pauser.address;
    const before = await balanceOf(world.wantos, world.w.token, recipient);
    await world.wantos.testClient.setStorageAt({ address: world.w.token, index: wslot, value: pad(toHex(0n)) });
    await deposit(world, world.act.user, 50n * U, recipient);
    await finalizeBsc(world);
    await sys.relayer.tick();
    const key = b2wEventKey({ bscChainId: BigInt(BSC_ID), bscVault: world.b.bridge, depositNonce: 1n });
    expect((await repo.get(key))!).toMatchObject({ status: "WAITING", reason: "reserve" });
    await sys.relayer.tick();
    expect((await repo.get(key))!).toMatchObject({ status: "WAITING", reason: "reserve" });
    expect(await balanceOf(world.wantos, world.w.token, recipient)).toBe(before);

    await world.wantos.testClient.setStorageAt({ address: world.w.token, index: wslot, value: pad(toHex(fullW)) });
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("SUBMITTED");
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("QUEUED");
    await world.wantos.testClient.increaseTime({ seconds: 15 * 60 + 1 });
    await world.wantos.testClient.mine({ blocks: 1 });
    await sys.relayer.tick();
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await repo.get(key))!.status).toBe("RELEASED");
    expect(await balanceOf(world.wantos, world.w.token, recipient)).toBe(before + 50n * U);
  });
});
