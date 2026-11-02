import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keccak256, toHex, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import { startWorld, whitelistBoth, buildRelayer, bridgeOut, deposit, finalizeBsc, confirmWantos, WANTOS_ID, BSC_ID, type World } from "./helpers/system";
import { U, write } from "./helpers/deploy";
import { w2bEventKey, b2wEventKey } from "../src/eventKey";
import { OrderRepo } from "../src/orders";
import type { Hex } from "../src/types";

describe("fault injection part 2: QUEUED / refunds / on-chain reverts / manual handling", () => {
  let world: World;
  let snaps: { w: Hex; b: Hex };
  const wKey = (id: bigint) => w2bEventKey({ wantosChainId: BigInt(WANTOS_ID), wantosBridge: world.w.bridge, orderId: id });
  const bKey = (n: bigint) => b2wEventKey({ bscChainId: BigInt(BSC_ID), bscVault: world.b.bridge, depositNonce: n });
  const bsc = (fn: string, args: unknown[] = [], from = world.act.admin) => write(world.bsc, from, world.b.bridge, bscVaultV2Abi as Abi, fn, args);
  const wan = (fn: string, args: unknown[] = [], from = world.act.admin) => write(world.wantos, from, world.w.bridge, wantosBridgeV2Abi as Abi, fn, args);
  const bscRelayer = () => privateKeyToAccount(world.bscRelayerKey).address;

  beforeAll(async () => {
    world = await startWorld();
    await whitelistBoth(world, [world.act.user.address, world.act.user2.address]);
  });
  afterAll(async () => world?.stop());
  beforeEach(async () => {
    snaps = { w: await world.wantos.testClient.snapshot(), b: await world.bsc.testClient.snapshot() };
  });
  afterEach(async () => {
    await world.bsc.testClient.setAutomine(true);
    await world.wantos.testClient.revert({ id: snaps.w });
    await world.bsc.testClient.revert({ id: snaps.b });
  });

  it("simulation passes but the tx reverts on-chain (pause lands first in the same block) → classified WAITING(paused)", async () => {
    const sys = await buildRelayer(world);
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await world.bsc.testClient.setAutomine(false);
    await sys.relayer.tick(); // release broadcast, pending
    const pauseHash = await world.bsc.walletClient.writeContract({
      address: world.b.bridge,
      abi: bscVaultV2Abi as Abi,
      functionName: "pause",
      account: world.act.pauser,
      chain: world.bsc.chain,
      gasPrice: 50_000_000_000n, // ordered before our release
    });
    await world.bsc.testClient.mine({ blocks: 1 });
    await world.bsc.testClient.setAutomine(true);
    expect((await world.bsc.publicClient.getTransactionReceipt({ hash: pauseHash })).status).toBe("success");
    await sys.relayer.tick();
    const st = await sys.db.query<{ state: string }>("select state from tx_attempts");
    expect(st.rows[0]!.state).toBe("reverted");
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!).toMatchObject({ status: "WAITING", reason: "paused" });
  });

  it("QUEUED payout cancelled by the owner → REJECTED → REFUNDING", async () => {
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    await bridgeOut(world, world.act.user, 1500n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("QUEUED");
    await bsc("cancelRelease", [1n]);
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("QUEUED"); // void not final yet
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("REJECTED");
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("REFUNDING");
  });

  it("QUEUED and due while paused → stays QUEUED(paused); after unpause executes and settles", async () => {
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    await bridgeOut(world, world.act.user, 1500n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    await finalizeBsc(world);
    await sys.relayer.tick();
    await world.bsc.testClient.increaseTime({ seconds: 12 * 3600 });
    await bsc("pause", [], world.act.pauser);
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!).toMatchObject({ status: "QUEUED", reason: "paused" });
    await bsc("unpause");
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("SUBMITTED");
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("SUBMITTED"); // execute mined, payout still Queued at final height
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("RELEASED");
  });

  it("B2W voided on WANTOS → REJECTED → REFUNDING → BSC deposit refund executed + finalized → REFUNDED", async () => {
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    await deposit(world, world.act.user, 50n * U, world.act.user.address);
    await wan("voidSource", [1n]);
    await confirmWantos(world);
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await repo.get(bKey(1n)))!.status).toBe("REJECTED");
    await sys.relayer.tick();
    expect((await repo.get(bKey(1n)))!.status).toBe("REFUNDING");
    await bsc("requestDepositRefund", [1n]);
    await world.bsc.testClient.increaseTime({ seconds: 86_401 });
    await bsc("executeDepositRefund", [1n], world.act.funder);
    await sys.relayer.tick();
    expect((await repo.get(bKey(1n)))!.status).toBe("REFUNDING");
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await repo.get(bKey(1n)))!.status).toBe("REFUNDED");
  });

  it("FAILED is manual only: retry → DETECTED → processed; reject → REJECTED", async () => {
    await bsc("revokeKey", [keccak256(toHex("RELAYER_ROLE")), bscRelayer()]);
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    await bridgeOut(world, world.act.user, 100n * U);
    await bridgeOut(world, world.act.user2, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("FAILED");
    expect((await repo.get(wKey(2n)))!.status).toBe("FAILED");
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("FAILED"); // never automatic
    expect(await sys.relayer.processor.retryFailed(wKey(1n))).toBe(true);
    expect(await sys.relayer.processor.rejectFailed(wKey(2n))).toBe(true);
    expect(await sys.relayer.processor.retryFailed(wKey(2n))).toBe(false);
    expect((await repo.get(wKey(2n)))!.status).toBe("REJECTED");
    expect((await repo.get(wKey(1n)))!.status).toBe("DETECTED");
  });

  it("halted (reorg) relayer submits nothing for existing orders, including due QUEUED ones", async () => {
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    await bridgeOut(world, world.act.user, 1500n * U);
    await bridgeOut(world, world.act.user2, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    await sys.relayer.tick();
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("QUEUED");
    await sys.db.query("update orders set status = 'WAITING', reason = 'quota' where src_event_nonce = 2");
    await world.bsc.testClient.increaseTime({ seconds: 12 * 3600 });
    await world.bsc.testClient.mine({ blocks: 1 });
    sys.safety.halt("wantos", "test");
    const before = await world.bsc.publicClient.getTransactionCount({ address: bscRelayer() });
    await sys.relayer.tick();
    expect(await world.bsc.publicClient.getTransactionCount({ address: bscRelayer() })).toBe(before);
    expect((await repo.get(wKey(1n)))!.status).toBe("QUEUED");
  });

  it("SUBMITTED with no attempt or with a dropped attempt → FAILED (manual)", async () => {
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    await bridgeOut(world, world.act.user, 100n * U);
    await bridgeOut(world, world.act.user2, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("SUBMITTED");
    // order 1: its attempt is "dropped" (nonce consumed elsewhere); order 2: SUBMITTED without any attempt (DB inconsistency)
    await sys.db.query("update tx_attempts set state = 'dropped'");
    await sys.db.query("update orders set status = 'SUBMITTED' where src_event_nonce = 2");
    // payout of order 1 is Released on-chain but not final: only the final read may settle it
    await sys.relayer.tick();
    expect((await repo.get(wKey(2n)))!.status).toBe("FAILED");
    expect((await repo.get(wKey(1n)))!.status).toBe("FAILED");
  });

  it("an attempt still in flight is never doubled: open attempt blocks re-evaluation", async () => {
    const sys = await buildRelayer(world);
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await world.bsc.testClient.setAutomine(false);
    await sys.relayer.tick();
    await sys.db.query("update orders set status = 'WAITING', reason = 'quota'"); // simulate a lost status update
    await sys.relayer.tick();
    const n = await sys.db.query<{ n: number }>("select count(*)::int as n from tx_attempts");
    expect(n.rows[0]!.n).toBe(1);
  });
});
