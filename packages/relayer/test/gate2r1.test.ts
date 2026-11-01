import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, keccak256, pad, toHex, type Abi, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import { startWorld, whitelistBoth, buildRelayer, bridgeOut, deposit, finalizeBsc, confirmWantos, WANTOS_ID, BSC_ID, type World } from "./helpers/system";
import { U, write } from "./helpers/deploy";
import { w2bEventKey, b2wEventKey } from "../src/eventKey";
import { OrderRepo } from "../src/orders";
import { reviewMessage } from "../src/review";
import { DefaultRiskEngine, type RiskEngine } from "../src/risk";
import { fromBytes } from "../src/bytes";
import type { Hex } from "../src/types";

const auto: RiskEngine = { evaluate: async () => ({ kind: "AUTO" }) };
const delay: RiskEngine = { evaluate: async () => ({ kind: "DELAY" }) };

/** Gate-2 round-1 regressions (aligner probes P1/P2/P3 + hard preconditions). */
describe("Gate2 r1: source-order hard preconditions, approvals, bump race", () => {
  let world: World;
  let snaps: { w: Hex; b: Hex };
  const wKey = (id: bigint) => w2bEventKey({ wantosChainId: BigInt(WANTOS_ID), wantosBridge: world.w.bridge, orderId: id });
  const bKey = (n: bigint) => b2wEventKey({ bscChainId: BigInt(BSC_ID), bscVault: world.b.bridge, depositNonce: n });
  const wan = (fn: string, args: unknown[] = [], from = world.act.admin) => write(world.wantos, from, world.w.bridge, wantosBridgeV2Abi as Abi, fn, args);
  const bsc = (fn: string, args: unknown[] = [], from = world.act.admin) => write(world.bsc, from, world.b.bridge, bscVaultV2Abi as Abi, fn, args);
  const bscRead = (fn: string, args: unknown[] = []) => world.bsc.publicClient.readContract({ address: world.b.bridge, abi: bscVaultV2Abi as Abi, functionName: fn, args });
  const actions = async (db: { query: Function }) => ((await (db as any).query("select action from tx_attempts order by id")).rows as { action: string }[]).map((r) => r.action);
  const approve = async (sys: Awaited<ReturnType<typeof buildRelayer>>, key: Hex) => {
    const exp = BigInt(Math.floor(sys.clock.now / 1000) + 600);
    const sig = await world.act.admin.signMessage({ message: reviewMessage({ chainId: BSC_ID, eventKey: key, decision: "approve", expires: exp }) });
    await sys.relayer.review.decide({ eventKey: key, decision: "approve", expires: exp, signature: sig });
  };

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

  it("A1/P1: approved REVIEW, then WANTOS refund requested → nothing is sent; REVIEW(freeze, onchain_mismatch)", async () => {
    let first = true;
    let inner: DefaultRiskEngine | null = null;
    const risk: RiskEngine = {
      evaluate: async (o, c) => {
        if (first) {
          first = false;
          return { kind: "REVIEW", level: "audit", reason: "pr4" };
        }
        return inner!.evaluate(o, c);
      },
    };
    const sys = await buildRelayer(world, { risk });
    inner = new DefaultRiskEngine(sys.relayer.wantosView, sys.relayer.bscView, sys.alerts);
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("REVIEW");
    await approve(sys, wKey(1n));
    await wan("requestRefund", [1n]);
    await confirmWantos(world);
    await sys.relayer.tick();
    await sys.relayer.tick();
    expect(await actions(sys.db)).toEqual([]);
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!).toMatchObject({ status: "REVIEW", reviewLevel: "freeze", reason: "onchain_mismatch" });
    expect(sys.alerts.byKind("ORDER_ONCHAIN_MISMATCH").length).toBeGreaterThan(0);
  });

  it("A1: the source-order check is a hard precondition even with a permissive risk engine", async () => {
    const sys = await buildRelayer(world, { risk: auto });
    await bridgeOut(world, world.act.user, 100n * U);
    await wan("requestRefund", [1n]);
    await confirmWantos(world);
    await sys.relayer.tick();
    expect(await actions(sys.db)).toEqual([]);
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!).toMatchObject({ status: "REVIEW", reviewLevel: "freeze", reason: "onchain_mismatch" });
  });

  it("A1: an approval only covers the level+reason it was given for", async () => {
    const seq: ReturnType<RiskEngine["evaluate"]> extends Promise<infer D> ? D[] : never = [
      { kind: "REVIEW", level: "audit", reason: "pr4-audit" },
      { kind: "REVIEW", level: "freeze", reason: "pr4-freeze" },
      { kind: "REVIEW", level: "freeze", reason: "pr4-freeze" },
    ];
    const risk: RiskEngine = { evaluate: async () => seq.shift() ?? { kind: "REVIEW", level: "freeze", reason: "pr4-freeze" } };
    const sys = await buildRelayer(world, { risk });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    await approve(sys, wKey(1n));
    await sys.relayer.tick(); // engine now says freeze for another reason
    await sys.relayer.tick();
    expect(await actions(sys.db)).toEqual([]);
    const o = (await new OrderRepo(sys.db).get(wKey(1n)))!;
    expect(o).toMatchObject({ status: "REVIEW", reviewLevel: "freeze", reason: "pr4-freeze" });
    expect(o.approvedAt).toBeNull();
  });

  it("A1: approval for the same level+reason still proceeds (via the delay queue)", async () => {
    const risk: RiskEngine = { evaluate: async () => ({ kind: "REVIEW", level: "audit", reason: "pr4-audit" }) };
    const sys = await buildRelayer(world, { risk });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    await approve(sys, wKey(1n));
    await sys.relayer.tick();
    expect(await actions(sys.db)).toEqual(["queueRelease"]);
  });

  it("A2/P2: QUEUED, then WANTOS refund requested → executeRelease is never sent; stays QUEUED(onchain_mismatch) + alert", async () => {
    const sys = await buildRelayer(world, { risk: delay });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("QUEUED");
    await wan("requestRefund", [1n]);
    await world.bsc.testClient.increaseTime({ seconds: 13 * 3600 });
    await world.bsc.testClient.mine({ blocks: 1 });
    await sys.relayer.tick();
    await sys.relayer.tick();
    expect(await actions(sys.db)).not.toContain("executeRelease");
    expect(((await bscRead("payouts", [wKey(1n)])) as readonly unknown[])[3]).toBe(1); // still Queued
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!).toMatchObject({ status: "QUEUED", reason: "onchain_mismatch" });
    expect(sys.alerts.byKind("ORDER_ONCHAIN_MISMATCH").length).toBeGreaterThan(0);
  });

  it("A2 (B2W): deposit refund requested on BSC → WANTOS queueRelease / executeRelease are not sent", async () => {
    const sys = await buildRelayer(world, { risk: auto });
    await deposit(world, world.act.user, 50n * U, world.act.user.address);
    await deposit(world, world.act.user2, 50n * U, world.act.user2.address);
    await bsc("requestDepositRefund", [1n]);
    await finalizeBsc(world);
    await sys.relayer.tick(); // deposit 1: blocked; deposit 2: queued
    await sys.relayer.tick();
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(bKey(1n)))!).toMatchObject({ status: "REVIEW", reviewLevel: "freeze", reason: "onchain_mismatch" });
    expect((await new OrderRepo(sys.db).get(bKey(2n)))!.status).toBe("QUEUED");
    await bsc("requestDepositRefund", [2n]);
    await world.wantos.testClient.increaseTime({ seconds: 16 * 60 });
    await world.wantos.testClient.mine({ blocks: 1 });
    await sys.relayer.tick();
    expect(await actions(sys.db)).toEqual(["queueRelease"]);
    expect((await new OrderRepo(sys.db).get(bKey(2n)))!).toMatchObject({ status: "QUEUED", reason: "onchain_mismatch" });
  });

  it("A3/P3: bump race — the ORIGINAL tx is mined after a bump → never FAILED; RELEASED once final", async () => {
    const sys = await buildRelayer(world);
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await world.bsc.testClient.setAutomine(false);
    try {
      await sys.relayer.tick();
      sys.clock.now += 61_000;
      await sys.relayer.tick();
      const rows = await sys.db.query<{ tx_hash: Uint8Array; raw_tx: Uint8Array }>("select tx_hash, raw_tx from tx_attempts order by id");
      expect(rows.rows).toHaveLength(2);
      await world.bsc.testClient.dropTransaction({ hash: fromBytes(rows.rows[1]!.tx_hash)! });
      await (world.bsc.publicClient as unknown as PublicClient).sendRawTransaction({ serializedTransaction: fromBytes(rows.rows[0]!.raw_tx)! });
      await world.bsc.testClient.mine({ blocks: 1 });
    } finally {
      await world.bsc.testClient.setAutomine(true);
    }
    await sys.relayer.tick();
    expect((await sys.db.query<{ state: string }>("select state from tx_attempts order by id")).rows.map((r) => r.state)).toEqual(["mined", "replaced"]);
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("SUBMITTED");
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("RELEASED");
  });

  it("B1: owner reject is refused when the payout is already Released; REJECTED never advances over a Released payout", async () => {
    const review: RiskEngine = { evaluate: async () => ({ kind: "REVIEW", level: "audit", reason: "pr4" }) };
    const sys = await buildRelayer(world, { risk: review });
    await bridgeOut(world, world.act.user, 100n * U);
    await bridgeOut(world, world.act.user2, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    // payouts released outside the relayer's own flow (e.g. a racing / compromised payout key)
    const relayer = privateKeyToAccount(world.bscRelayerKey);
    await write(world.bsc, relayer, world.b.bridge, bscVaultV2Abi as Abi, "release", [1n, world.act.user.address, 100n * U]);
    await write(world.bsc, relayer, world.b.bridge, bscVaultV2Abi as Abi, "release", [2n, world.act.user2.address, 100n * U]);
    const exp = BigInt(Math.floor(sys.clock.now / 1000) + 600);
    const sig = await world.act.admin.signMessage({ message: reviewMessage({ chainId: BSC_ID, eventKey: wKey(1n), decision: "reject", expires: exp }) });
    await expect(sys.relayer.review.decide({ eventKey: wKey(1n), decision: "reject", expires: exp, signature: sig })).rejects.toThrow(/released/i);
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("REVIEW");
    expect(sys.alerts.byKind("PAYOUT_ALREADY_RELEASED")).toHaveLength(1);
    expect(sys.alerts.byKind("PAYOUT_ALREADY_RELEASED")[0]!.level).toBe(1);
    // order 2 somehow ended up REJECTED (e.g. rejected before the release landed)
    await sys.db.query("update orders set status = 'REJECTED' where event_key = $1", [(await import("../src/bytes")).toBytes(wKey(2n))]);
    await finalizeBsc(world);
    await sys.relayer.tick();
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(2n)))!.status).toBe("REJECTED");
    expect(sys.alerts.byKind("PAYOUT_ALREADY_RELEASED").length).toBeGreaterThanOrEqual(2);
  });
});
