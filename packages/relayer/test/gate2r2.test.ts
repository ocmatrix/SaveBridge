import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToSignature, serializeSignature, toHex, type Abi, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import { startWorld, whitelistBoth, buildRelayer, bridgeOut, deposit, balanceOf, finalizeBsc, confirmWantos, WANTOS_ID, BSC_ID, type World } from "./helpers/system";
import { U, write } from "./helpers/deploy";
import { newMigratedDb } from "./helpers/db";
import { w2bEventKey, b2wEventKey } from "../src/eventKey";
import { OrderRepo } from "../src/orders";
import { reviewMessage, ReviewService } from "../src/review";
import { MemoryAlertSink } from "../src/alerts";
import { Processor } from "../src/processor";
import { Relayer } from "../src/relayer";
import { toBytes } from "../src/bytes";
import type { RiskEngine } from "../src/risk";
import type { Hex } from "../src/types";

const auto: RiskEngine = { evaluate: async () => ({ kind: "AUTO" }) };
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Gate-2 round-2 regressions: A-1 (signed tx re-broadcast / bump bypassing the source check), A-2 (review replay). */
describe("Gate2 r2", () => {
  let world: World;
  let snaps: { w: Hex; b: Hex };
  const wKey = (id: bigint) => w2bEventKey({ wantosChainId: BigInt(WANTOS_ID), wantosBridge: world.w.bridge, orderId: id });
  const bKey = (n: bigint) => b2wEventKey({ bscChainId: BigInt(BSC_ID), bscVault: world.b.bridge, depositNonce: n });
  const wan = (fn: string, args: unknown[] = [], from = world.act.admin) => write(world.wantos, from, world.w.bridge, wantosBridgeV2Abi as Abi, fn, args);
  const bsc = (fn: string, args: unknown[] = [], from = world.act.admin) => write(world.bsc, from, world.b.bridge, bscVaultV2Abi as Abi, fn, args);
  const payoutStatus = async (side: "bsc" | "wantos", key: Hex) => {
    const a = side === "bsc" ? world.bsc : world.wantos;
    const addr = side === "bsc" ? world.b.bridge : world.w.bridge;
    const abi = (side === "bsc" ? bscVaultV2Abi : wantosBridgeV2Abi) as Abi;
    return Number(((await a.publicClient.readContract({ address: addr, abi, functionName: "payouts", args: [key] })) as readonly unknown[])[3]);
  };
  const crashOnce = () => {
    let crashed = false;
    return {
      afterSign: () => {
        if (!crashed) {
          crashed = true;
          throw new Error("crash");
        }
      },
    };
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

  // ------------------------------------------------------------------ A-1
  it("A-1/P4: signed-not-broadcast release + WANTOS refund requested before restart → never broadcast, nonce cancelled, next order still pays", async () => {
    const db = (await buildRelayer(world)).db;
    const crashing = await buildRelayer(world, { db, risk: auto, senderHooks: { bsc: crashOnce() } });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await crashing.relayer.tick();
    expect((await new OrderRepo(db).get(wKey(1n)))!.status).toBe("SUBMITTED");
    await wan("requestRefund", [1n]);
    await confirmWantos(world);
    const restarted = await buildRelayer(world, { db, risk: auto });
    await restarted.relayer.tick();
    await finalizeBsc(world);
    await restarted.relayer.tick();
    expect(await payoutStatus("bsc", wKey(1n))).toBe(0);
    expect((await new OrderRepo(db).get(wKey(1n)))!).toMatchObject({ status: "REVIEW", reviewLevel: "freeze", reason: "onchain_mismatch" });
    const a = restarted.alerts.byKind("SIGNED_TX_SOURCE_MISMATCH");
    expect(a.length).toBeGreaterThan(0);
    expect(a[0]!.level).toBe(1);
    const rows = await db.query<{ state: string; action: string }>("select state, action from tx_attempts order by id");
    expect(rows.rows).toEqual([
      { state: "abandoned", action: "release" },
      { state: "mined", action: "cancel" },
    ]);
    // the nonce is healthy: a later order is paid
    await bridgeOut(world, world.act.user2, 100n * U);
    await confirmWantos(world);
    await restarted.relayer.tick();
    await restarted.relayer.tick();
    await finalizeBsc(world);
    await restarted.relayer.tick();
    expect((await new OrderRepo(db).get(wKey(2n)))!.status).toBe("RELEASED");
  });

  it("A-1 (B2W): signed-not-broadcast WANTOS queueRelease + BSC deposit refund requested → never broadcast", async () => {
    const db = (await buildRelayer(world)).db;
    const crashing = await buildRelayer(world, { db, risk: auto, senderHooks: { wantos: crashOnce() } });
    await deposit(world, world.act.user, 50n * U, world.act.user.address);
    await finalizeBsc(world);
    await crashing.relayer.tick();
    expect((await new OrderRepo(db).get(bKey(1n)))!.status).toBe("SUBMITTED");
    await bsc("requestDepositRefund", [1n]);
    const restarted = await buildRelayer(world, { db, risk: auto });
    await restarted.relayer.tick();
    await confirmWantos(world);
    await restarted.relayer.tick();
    expect(await payoutStatus("wantos", bKey(1n))).toBe(0);
    expect((await new OrderRepo(db).get(bKey(1n)))!).toMatchObject({ status: "REVIEW", reviewLevel: "freeze" });
    expect(restarted.alerts.byKind("SIGNED_TX_SOURCE_MISMATCH").length).toBeGreaterThan(0);
  });

  it("A-1: a stuck release is NOT fee-bumped once the WANTOS refund was requested; it is cancelled at the same nonce", async () => {
    const sys = await buildRelayer(world, { risk: auto });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await world.bsc.testClient.setAutomine(false);
    await sys.relayer.tick(); // release pending
    await wan("requestRefund", [1n]);
    sys.clock.now += 61_000;
    const before = await balanceOf(world.bsc, world.b.token, world.act.user.address);
    await sys.relayer.tick();
    const rows = await sys.db.query<{ action: string; state: string }>("select action, state from tx_attempts order by id");
    expect(rows.rows.map((r) => r.action)).toEqual(["release", "cancel"]); // no second "release"
    await world.bsc.testClient.mine({ blocks: 1 });
    await world.bsc.testClient.setAutomine(true);
    await sys.relayer.tick();
    expect(await payoutStatus("bsc", wKey(1n))).toBe(0);
    expect(await balanceOf(world.bsc, world.b.token, world.act.user.address)).toBe(before);
    expect(sys.alerts.byKind("SIGNED_TX_SOURCE_MISMATCH").length).toBeGreaterThan(0);
  });

  it("A-1: guard read failure (RPC error) → nothing broadcast this tick, retried next tick", async () => {
    const db = (await buildRelayer(world)).db;
    const crashing = await buildRelayer(world, { db, risk: auto, senderHooks: { bsc: crashOnce() } });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await crashing.relayer.tick();
    const relayer = new Relayer({ ...crashing.relayer.deps, senderHooks: undefined });
    const orig = relayer.wantosView.order.bind(relayer.wantosView);
    let fail = true;
    relayer.wantosView.order = async (id, at) => {
      if (fail) throw new Error("rpc down");
      return orig(id, at);
    };
    await relayer.start(); // recover → re-broadcast is guarded; the guard cannot read → nothing sent
    await relayer.tick();
    expect(await world.bsc.publicClient.getTransactionCount({ address: privateKeyToAccount(world.bscRelayerKey).address })).toBe(0);
    fail = false;
    await relayer.tick();
    expect(await payoutStatus("bsc", wKey(1n))).toBe(2);
  });

  it("A-1 safety net: refund requested while the release is mined but not final → level-1 PAYOUT_ALREADY_RELEASED", async () => {
    const sys = await buildRelayer(world, { risk: auto });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick(); // release mined (automine)
    await wan("requestRefund", [1n]);
    await sys.relayer.tick();
    await sys.relayer.tick();
    const a = sys.alerts.byKind("PAYOUT_ALREADY_RELEASED");
    expect(a).toHaveLength(1); // deduplicated per order
    expect(a[0]!.level).toBe(1);
    expect(a[0]!.message).toMatch(/cancelRefund/);
  });

  it("A-1 safety net: order reaching RELEASED while the WANTOS order is Refunding → level-1 alert", async () => {
    const sys = await buildRelayer(world, { risk: auto });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    await wan("requestRefund", [1n]);
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("RELEASED");
    expect(sys.alerts.byKind("PAYOUT_ALREADY_RELEASED")).toHaveLength(1);
  });

  it("A-1 safety net (B2W): deposit refund requested while the WANTOS executeRelease is mined → alert mentions cancelDepositRefund", async () => {
    const sys = await buildRelayer(world, { risk: auto });
    await deposit(world, world.act.user, 50n * U, world.act.user.address);
    await finalizeBsc(world);
    await sys.relayer.tick(); // queueRelease mined
    await confirmWantos(world);
    await sys.relayer.tick(); // QUEUED
    await world.wantos.testClient.increaseTime({ seconds: 16 * 60 });
    await world.wantos.testClient.mine({ blocks: 1 });
    await sys.relayer.tick(); // executeRelease mined (not final)
    expect(sys.alerts.byKind("PAYOUT_ALREADY_RELEASED")).toHaveLength(0);
    await bsc("requestDepositRefund", [1n]);
    await sys.relayer.tick();
    expect(sys.alerts.byKind("PAYOUT_ALREADY_RELEASED")[0]?.message).toMatch(/cancelDepositRefund/);
  });

  it("A-1 safety net is silent on a normal release", async () => {
    const sys = await buildRelayer(world, { risk: auto });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    await sys.relayer.tick();
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("RELEASED");
    expect(sys.alerts.byKind("PAYOUT_ALREADY_RELEASED")).toHaveLength(0);
  });

  // ------------------------------------------------------------------ A-2
  describe("A-2: review signatures are single-use", () => {
    const sign = async (key: Hex, decision: "approve" | "reject", exp: bigint) =>
      world.act.admin.signMessage({ message: reviewMessage({ chainId: BSC_ID, eventKey: key, decision, expires: exp }) });

    it("P5: replaying an approval after the REVIEW scope changed is refused; nothing is paid", async () => {
      let n = 0;
      const risk: RiskEngine = { evaluate: async () => (n++ < 1 ? { kind: "REVIEW", level: "audit", reason: "r1" } : { kind: "REVIEW", level: "freeze", reason: "r2" }) };
      const sys = await buildRelayer(world, { risk });
      await bridgeOut(world, world.act.user, 100n * U);
      await confirmWantos(world);
      await sys.relayer.tick();
      const exp = BigInt(Math.floor(sys.clock.now / 1000) + 600);
      const sig = await sign(wKey(1n), "approve", exp);
      await sys.relayer.review.decide({ eventKey: wKey(1n), decision: "approve", expires: exp, signature: sig });
      await sys.relayer.tick();
      expect((await new OrderRepo(sys.db).get(wKey(1n)))!.approvedAt).toBeNull();
      await expect(sys.relayer.review.decide({ eventKey: wKey(1n), decision: "approve", expires: exp, signature: sig })).rejects.toThrow(/already used/);
      // the malleated (high-s) form of the same signature is the same message → also refused
      const p = hexToSignature(sig);
      const flipped = serializeSignature({ r: p.r, s: toHex(SECP_N - BigInt(p.s), { size: 32 }), yParity: p.yParity === 0 ? 1 : 0 });
      await expect(sys.relayer.review.decide({ eventKey: wKey(1n), decision: "approve", expires: exp, signature: flipped })).rejects.toThrow(/already used|signature/);
      await sys.relayer.tick();
      expect((await sys.db.query("select 1 from tx_attempts")).rows).toHaveLength(0);
      expect((await sys.db.query<{ action: string }>("select action from audit_log")).rows.map((r) => r.action)).toEqual(["review.approve"]);
    });

    it("same-scope approval replay and reject replay are refused too", async () => {
      const risk: RiskEngine = { evaluate: async () => ({ kind: "REVIEW", level: "audit", reason: "r1" }) };
      const sys = await buildRelayer(world, { risk });
      await bridgeOut(world, world.act.user, 100n * U);
      await bridgeOut(world, world.act.user2, 100n * U);
      await confirmWantos(world);
      await sys.relayer.tick();
      const exp = BigInt(Math.floor(sys.clock.now / 1000) + 600);
      const sig = await sign(wKey(1n), "approve", exp);
      await sys.relayer.review.decide({ eventKey: wKey(1n), decision: "approve", expires: exp, signature: sig });
      await expect(sys.relayer.review.decide({ eventKey: wKey(1n), decision: "approve", expires: exp, signature: sig })).rejects.toThrow(/already used/);
      const rej = await sign(wKey(2n), "reject", exp);
      await sys.relayer.review.decide({ eventKey: wKey(2n), decision: "reject", expires: exp, signature: rej });
      await sys.db.query("update orders set status = 'REVIEW' where event_key = $1", [toBytes(wKey(2n))]);
      await expect(sys.relayer.review.decide({ eventKey: wKey(2n), decision: "reject", expires: exp, signature: rej })).rejects.toThrow(/already used/);
    });

    it("approve that updates no row (order left REVIEW concurrently) throws and writes no audit / no signature record", async () => {
      const db = await newMigratedDb();
      const repo = new OrderRepo(db);
      const key = ("0x" + "12".repeat(32)) as Hex;
      await repo.insertDetected({
        eventKey: key, direction: "W2B", srcChain: 1, srcEventNonce: 1n, srcTxHash: key, srcBlockNumber: 1n, srcBlockHash: key,
        userAddr: world.act.user.address, toAddr: world.act.user.address, amountWei: 1n,
      });
      await db.query("update orders set status = 'REVIEW', review_level = 'audit', reason = 'r1'");
      const alerts = new MemoryAlertSink();
      const client = {
        verifyMessage: async () => {
          await db.query("update orders set status = 'WAITING', reason = 'quota'"); // processor moved it meanwhile
          return true;
        },
      };
      const view = { adminWallet: async () => world.act.admin.address, payout: async () => ({ status: 0 }) };
      const svc = new ReviewService({ db, alerts, now: () => new Date(), payoutView: () => ({ view: view as any, chainId: BSC_ID, client: client as any }) });
      const exp = BigInt(Math.floor(Date.now() / 1000) + 600);
      await expect(svc.decide({ eventKey: key, decision: "approve", expires: exp, signature: "0x00" })).rejects.toThrow(/changed/);
      expect((await db.query("select 1 from audit_log")).rows).toHaveLength(0);
      expect((await db.query("select 1 from review_signatures")).rows).toHaveLength(0);
      expect((await repo.get(key))!.approvedAt).toBeNull();
    });
  });

  // ------------------------------------------------------------------ side items
  describe("source check: each field matters on its own (N03/N04/N06/N07)", () => {
    const blocked = async (sys: Awaited<ReturnType<typeof buildRelayer>>, key: Hex, spy: { mock: { calls: unknown[][] } }) => {
      expect((await new OrderRepo(sys.db).get(key))!).toMatchObject({ status: "REVIEW", reason: "onchain_mismatch" });
      expect(spy.mock.calls.length).toBe(0);
    };
    it.each(["user", "amount"] as const)("W2B: only the %s differs → blocked", async (field) => {
      const sys = await buildRelayer(world, { risk: auto });
      await bridgeOut(world, world.act.user, 100n * U);
      await confirmWantos(world);
      await sys.relayer.wantosScanner.scanOnce();
      if (field === "user") await sys.db.query("update orders set user_addr = $1", [toBytes(world.act.user2.address)]);
      else await sys.db.query("update orders set amount_wei = amount_wei + 1");
      const spy = vi.spyOn(sys.relayer.bscSender, "send");
      await sys.relayer.tick();
      await blocked(sys, wKey(1n), spy);
    });
    it.each(["user", "amount"] as const)("B2W: only the %s differs → blocked", async (field) => {
      const sys = await buildRelayer(world, { risk: auto });
      await deposit(world, world.act.user, 50n * U, world.act.user.address);
      await finalizeBsc(world);
      await sys.relayer.bscScanner.scanOnce();
      if (field === "user") await sys.db.query("update orders set user_addr = $1", [toBytes(world.act.user2.address)]);
      else await sys.db.query("update orders set amount_wei = amount_wei + 1");
      const spy = vi.spyOn(sys.relayer.wantosSender, "send");
      await sys.relayer.tick();
      await blocked(sys, bKey(1n), spy);
    });
  });

  describe("approval scope: level and reason each void it on their own (N08–N11)", () => {
    it.each([
      ["level changes, reason same", { kind: "REVIEW", level: "freeze", reason: "r1" }],
      ["reason changes, level same", { kind: "REVIEW", level: "audit", reason: "r2" }],
    ] as const)("%s → approval cleared, nothing sent", async (_n, second) => {
      let n = 0;
      const risk: RiskEngine = { evaluate: async () => (n++ < 1 ? { kind: "REVIEW", level: "audit", reason: "r1" } : (second as any)) };
      const sys = await buildRelayer(world, { risk });
      await bridgeOut(world, world.act.user, 100n * U);
      await confirmWantos(world);
      await sys.relayer.tick();
      const exp = BigInt(Math.floor(sys.clock.now / 1000) + 600);
      const sig = await world.act.admin.signMessage({ message: reviewMessage({ chainId: BSC_ID, eventKey: wKey(1n), decision: "approve", expires: exp }) });
      await sys.relayer.review.decide({ eventKey: wKey(1n), decision: "approve", expires: exp, signature: sig });
      await sys.relayer.tick();
      await sys.relayer.tick();
      const o = (await new OrderRepo(sys.db).get(wKey(1n)))!;
      expect(o.approvedAt).toBeNull();
      expect(o).toMatchObject({ status: "REVIEW", reviewLevel: second.level, reason: second.reason });
      expect((await sys.db.query("select 1 from tx_attempts")).rows).toHaveLength(0);
    });
  });

  it("B5: an RPC error while reading a mined revert's reason keeps SUBMITTED (alerted), classifies once the RPC is back", async () => {
    let fail = false;
    const base = await buildRelayer(world);
    const bc = new Proxy(world.bsc.publicClient as any, {
      get(t, p) {
        if (p === "call" && fail) {
          return async (args: { blockNumber?: bigint }) => {
            if (args.blockNumber !== undefined) throw new Error("socket hang up");
            return t.call(args);
          };
        }
        return t[p];
      },
    });
    const sys = await buildRelayer(world, { db: base.db, bsc: { ...base.relayer.deps.bsc, client: bc } });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await world.bsc.testClient.setAutomine(false);
    await sys.relayer.tick();
    await world.bsc.walletClient.writeContract({ address: world.b.bridge, abi: bscVaultV2Abi as Abi, functionName: "pause", account: world.act.pauser, chain: world.bsc.chain, gasPrice: 50_000_000_000n });
    await world.bsc.testClient.mine({ blocks: 1 });
    await world.bsc.testClient.setAutomine(true);
    fail = true;
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("SUBMITTED");
    expect(sys.alerts.byKind("RPC_UNAVAILABLE").length).toBeGreaterThan(0);
    fail = false;
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!).toMatchObject({ status: "WAITING", reason: "paused" });
  });
});

describe("B3/N13: lastAttempt picks the latest (signer, nonce) group, resolved row first", () => {
  it("across payout-key rotation and multiple nonces", async () => {
    const db = await newMigratedDb();
    const p = new Processor({ db } as any);
    const key = ("0x" + "34".repeat(32)) as Hex;
    const A = toBytes("0x00000000000000000000000000000000000000a1");
    const B = toBytes("0x00000000000000000000000000000000000000b2");
    const h = (n: number) => toBytes(("0x" + n.toString(16).padStart(64, "0")) as Hex);
    const ins = (from: Uint8Array, nonce: number, state: string, action: string, hash: number) =>
      db.query("insert into tx_attempts (event_key, chain_id, nonce, tx_hash, state, action, from_addr) values ($1, 56, $2, $3, $4, $5, $6)", [toBytes(key), nonce, h(hash), state, action, from]);
    await ins(A, 9, "mined", "queueRelease", 1); // old key, high nonce
    await ins(B, 0, "mined", "executeRelease", 2); // new key, executed (original)
    await ins(B, 0, "replaced", "executeRelease", 3); // its bump
    const att = await p.lastAttemptFor(key);
    expect(att).toMatchObject({ action: "executeRelease", state: "mined" });
    expect(att!.txHash).toBe(("0x" + (2).toString(16).padStart(64, "0")) as Hex);
  });
});
