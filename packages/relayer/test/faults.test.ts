import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, pad, parseEther, toHex, type Abi, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import {
  startWorld,
  whitelistBoth,
  buildRelayer,
  bridgeOut,
  deposit,
  balanceOf,
  finalizeBsc,
  confirmWantos,
  WANTOS_ID,
  BSC_ID,
  type World,
} from "./helpers/system";
import { applyWhitelist, tokenAbi, U, write } from "./helpers/deploy";
import { w2bEventKey, b2wEventKey } from "../src/eventKey";
import { OrderRepo } from "../src/orders";
import { ViemChainReader, type ChainReader } from "../src/chain/reader";
import { reviewMessage } from "../src/review";
import type { RiskEngine } from "../src/risk";
import type { Hex } from "../src/types";

const auto: RiskEngine = { evaluate: async () => ({ kind: "AUTO" }) };
const delay: RiskEngine = { evaluate: async () => ({ kind: "DELAY" }) };

/** Reader wrapper that can simulate a node without `finalized` support or a dead link. */
class Flaky implements ChainReader {
  noFinalized = false;
  down = false;
  constructor(
    readonly label: string,
    private readonly inner: ChainReader,
  ) {}
  private gate() {
    if (this.down) throw new Error(`${this.label}: ECONNREFUSED`);
  }
  async getBlockNumber() {
    this.gate();
    return this.inner.getBlockNumber();
  }
  async getBlock(a: Parameters<ChainReader["getBlock"]>[0]) {
    this.gate();
    if (this.noFinalized && "blockTag" in a && a.blockTag === "finalized") return null;
    return this.inner.getBlock(a);
  }
  async getLogs(a: Parameters<ChainReader["getLogs"]>[0]) {
    this.gate();
    return this.inner.getLogs(a);
  }
  async getTransactionReceipt(h: Hex) {
    this.gate();
    return this.inner.getTransactionReceipt(h);
  }
}

describe("fault injection (DESIGN §13 PR-3 acceptance) on anvil", () => {
  let world: World;
  let user3: PrivateKeyAccount;
  let snaps: { w: Hex; b: Hex };
  const wKey = (id: bigint) => w2bEventKey({ wantosChainId: BigInt(WANTOS_ID), wantosBridge: world.w.bridge, orderId: id });
  const bKey = (n: bigint) => b2wEventKey({ bscChainId: BigInt(BSC_ID), bscVault: world.b.bridge, depositNonce: n });
  const bsc = (fn: string, args: unknown[] = [], from = world.act.admin) => write(world.bsc, from, world.b.bridge, bscVaultV2Abi as Abi, fn, args);
  const wan = (fn: string, args: unknown[] = [], from = world.act.admin) => write(world.wantos, from, world.w.bridge, wantosBridgeV2Abi as Abi, fn, args);
  const bscRead = (fn: string, args: unknown[] = []) => world.bsc.publicClient.readContract({ address: world.b.bridge, abi: bscVaultV2Abi as Abi, functionName: fn, args });
  const tighten = (p: Partial<Record<string, bigint>>) =>
    bsc("setParams", [{ dailyCap: 5000n * U, perAddrDailyCap: 2000n * U, largeThreshold: 1000n * U, releaseDelay: 12n * 3600n, minDeposit: 10n * U, maxDepositPerTx: 2000n * U, ...p }]);
  const drainVault = async () => {
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [world.b.bridge, 0n]));
    await world.bsc.testClient.setStorageAt({ address: world.b.token, index: slot, value: pad(toHex(0n)) });
  };

  beforeAll(async () => {
    world = await startWorld();
    await whitelistBoth(world, [world.act.user.address, world.act.user2.address]);
    user3 = privateKeyToAccount(generatePrivateKey());
    await world.wantos.testClient.setBalance({ address: user3.address, value: parseEther("10") });
    await write(world.wantos, world.act.funder, world.w.token, tokenAbi as Abi, "transfer", [user3.address, 5_000n * U]);
    await write(world.wantos, user3, world.w.token, tokenAbi as Abi, "approve", [world.w.bridge, 2n ** 255n]);
  });
  afterAll(async () => world?.stop());
  beforeEach(async () => {
    snaps = { w: await world.wantos.testClient.snapshot(), b: await world.bsc.testClient.snapshot() };
  });
  afterEach(async () => {
    await world.wantos.testClient.revert({ id: snaps.w });
    await world.bsc.testClient.revert({ id: snaps.b });
  });

  // ---------------------------------------------------------------- WAITING via the default risk engine
  it("quota insufficient → WAITING(quota); next UTC day → released", async () => {
    await tighten({ dailyCap: 1000n * U, perAddrDailyCap: 1000n * U, largeThreshold: 1000n * U });
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    await bridgeOut(world, world.act.user, 900n * U);
    await bridgeOut(world, world.act.user2, 200n * U);
    await confirmWantos(world);
    await sys.relayer.tick(); // order 1 submitted, order 2 waits for the serial sender
    await sys.relayer.tick();
    expect((await repo.get(wKey(2n)))!).toMatchObject({ status: "WAITING", reason: "quota" });
    await world.bsc.testClient.increaseTime({ seconds: 86_400 });
    await world.bsc.testClient.mine({ blocks: 1 });
    await sys.relayer.tick();
    await sys.relayer.tick();
    expect((await repo.get(wKey(2n)))!.status).toBe("SUBMITTED");
  });

  it("reserve insufficient → WAITING(reserve) with an immediate RESERVE_LOW alert", async () => {
    await drainVault();
    const sys = await buildRelayer(world);
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!).toMatchObject({ status: "WAITING", reason: "reserve" });
    expect(sys.alerts.byKind("RESERVE_LOW")).toHaveLength(1);
  });

  it("whitelist on WANTOS but not yet on BSC → WAITING(whitelist), 30-min alert, proceeds once BSC is written", async () => {
    await applyWhitelist(world.wantos, "wantos", world.w.bridge, world.act, [user3.address], true);
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    await bridgeOut(world, user3, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!).toMatchObject({ status: "WAITING", reason: "whitelist" });
    sys.clock.now += 31 * 60_000;
    await sys.relayer.tick();
    expect(sys.alerts.byKind("WHITELIST_INCONSISTENT")).toHaveLength(1);
    await applyWhitelist(world.bsc, "bsc", world.b.bridge, world.act, [user3.address], true);
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("SUBMITTED");
  });

  it("removed from the WANTOS whitelist after the order was created → REVIEW (owner decides reject)", async () => {
    const sys = await buildRelayer(world);
    await bridgeOut(world, world.act.user, 100n * U);
    await applyWhitelist(world.wantos, "wantos", world.w.bridge, world.act, [world.act.user.address], false);
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!).toMatchObject({ status: "REVIEW", reason: "whitelist_removed" });
  });

  it("bridge paused → WAITING(paused); after unpause it is submitted", async () => {
    await bsc("pause", [], world.act.pauser);
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!).toMatchObject({ status: "WAITING", reason: "paused" });
    expect(await world.bsc.publicClient.getTransactionCount({ address: privateKeyToAccount(world.bscRelayerKey).address })).toBe(0);
    await bsc("unpause");
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("SUBMITTED");
  });

  it("amount above the current per-address cap → REVIEW(amount_limit)", async () => {
    const sys = await buildRelayer(world);
    await bridgeOut(world, world.act.user, 900n * U);
    await tighten({ perAddrDailyCap: 500n * U, largeThreshold: 500n * U });
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!).toMatchObject({ status: "REVIEW", reason: "amount_limit", reviewLevel: "audit" });
  });

  it("WANTOS order no longer Locked (refund requested) → never paid, REVIEW(freeze) + ORDER_ONCHAIN_MISMATCH", async () => {
    const sys = await buildRelayer(world);
    await bridgeOut(world, world.act.user, 100n * U);
    await wan("requestRefund", [1n]);
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!).toMatchObject({ status: "REVIEW", reviewLevel: "freeze" });
    expect(sys.alerts.byKind("ORDER_ONCHAIN_MISMATCH")).toHaveLength(1);
    expect(await world.bsc.publicClient.getTransactionCount({ address: privateKeyToAccount(world.bscRelayerKey).address })).toBe(0);
  });

  it("B2W over b2wDailyCap → WAITING(quota) (B2W has no whitelist reason)", async () => {
    const sys = await buildRelayer(world);
    const repo = new OrderRepo(sys.db);
    await deposit(world, world.act.user, 2000n * U, world.act.pauser.address);
    await deposit(world, world.act.user2, 1500n * U, world.act.pauser.address);
    await finalizeBsc(world);
    await sys.relayer.tick();
    await sys.relayer.tick();
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await repo.get(bKey(1n)))!.status).toBe("QUEUED");
    expect((await repo.get(bKey(2n)))!).toMatchObject({ status: "WAITING", reason: "quota" });
  });

  // ---------------------------------------------------------------- revert classification (contract is the judge)
  describe("revert classification with a permissive risk engine (contract reverts are classified)", () => {
    it("DailyCapExceeded → WAITING(quota)", async () => {
      await tighten({ dailyCap: 1000n * U, perAddrDailyCap: 1000n * U, largeThreshold: 1000n * U });
      const sys = await buildRelayer(world, { risk: auto });
      await bridgeOut(world, world.act.user, 900n * U);
      await bridgeOut(world, world.act.user2, 200n * U);
      await confirmWantos(world);
      await sys.relayer.tick();
      await sys.relayer.tick();
      expect((await new OrderRepo(sys.db).get(wKey(2n)))!).toMatchObject({ status: "WAITING", reason: "quota" });
    });
    it("ERC20 insufficient balance → WAITING(reserve)", async () => {
      await drainVault();
      const sys = await buildRelayer(world, { risk: auto });
      await bridgeOut(world, world.act.user, 100n * U);
      await confirmWantos(world);
      await sys.relayer.tick();
      expect((await new OrderRepo(sys.db).get(wKey(1n)))!).toMatchObject({ status: "WAITING", reason: "reserve" });
    });
    it("EnforcedPause → WAITING(paused)", async () => {
      await bsc("pause", [], world.act.pauser);
      const sys = await buildRelayer(world, { risk: auto });
      await bridgeOut(world, world.act.user, 100n * U);
      await confirmWantos(world);
      await sys.relayer.tick();
      expect((await new OrderRepo(sys.db).get(wKey(1n)))!).toMatchObject({ status: "WAITING", reason: "paused" });
    });
    it("NotWhitelisted → WAITING(whitelist)", async () => {
      await applyWhitelist(world.wantos, "wantos", world.w.bridge, world.act, [user3.address], true);
      const sys = await buildRelayer(world, { risk: auto });
      await bridgeOut(world, user3, 100n * U);
      await confirmWantos(world);
      await sys.relayer.tick();
      expect((await new OrderRepo(sys.db).get(wKey(1n)))!).toMatchObject({ status: "WAITING", reason: "whitelist" });
    });
    it("AmountAboveLimit → REVIEW", async () => {
      const sys = await buildRelayer(world, { risk: auto });
      await bridgeOut(world, world.act.user, 1500n * U); // release() caps at largeThreshold
      await confirmWantos(world);
      await sys.relayer.tick();
      expect((await new OrderRepo(sys.db).get(wKey(1n)))!).toMatchObject({ status: "REVIEW", reason: "amount_limit" });
    });
    it("payout already Released (DB lost the update) → RELEASED without a new tx", async () => {
      const sys = await buildRelayer(world);
      await bridgeOut(world, world.act.user, 100n * U);
      await confirmWantos(world);
      await sys.relayer.tick();
      await finalizeBsc(world);
      await sys.db.query("update orders set status = 'DETECTED'");
      await sys.db.query("update tx_attempts set state = 'mined'");
      await sys.relayer.tick();
      expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("RELEASED");
      const n = await sys.db.query<{ n: number }>("select count(*)::int as n from tx_attempts");
      expect(n.rows[0]!.n).toBe(1);
    });
    it("payout Voided by the owner → REJECTED → (void final) REFUNDING → (refund executed) REFUNDED", async () => {
      const sys = await buildRelayer(world);
      const repo = new OrderRepo(sys.db);
      await bridgeOut(world, world.act.user, 100n * U);
      await bsc("voidSource", [1n]);
      await finalizeBsc(world);
      await confirmWantos(world);
      await sys.relayer.tick();
      expect((await repo.get(wKey(1n)))!.status).toBe("REJECTED");
      await sys.relayer.tick();
      expect((await repo.get(wKey(1n)))!.status).toBe("REFUNDING");
      await wan("requestRefund", [1n]);
      await world.wantos.testClient.increaseTime({ seconds: 86_401 });
      await wan("executeRefund", [1n], world.act.funder);
      await sys.relayer.tick();
      expect((await repo.get(wKey(1n)))!.status).toBe("REFUNDING"); // needs 6 confirmations
      await confirmWantos(world);
      await sys.relayer.tick();
      expect((await repo.get(wKey(1n)))!.status).toBe("REFUNDED");
      const n = await sys.db.query<{ n: number }>("select count(*)::int as n from tx_attempts");
      expect(n.rows[0]!.n).toBe(0);
    });
    it("anything else (relayer key revoked) → FAILED + RELAYER_KEY_REVOKED", async () => {
      await bsc("revokeKey", [keccak256(toHex("RELAYER_ROLE")), privateKeyToAccount(world.bscRelayerKey).address]);
      const sys = await buildRelayer(world);
      await bridgeOut(world, world.act.user, 100n * U);
      await confirmWantos(world);
      await sys.relayer.tick();
      expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("FAILED");
      expect(sys.alerts.byKind("RELAYER_KEY_REVOKED")).toHaveLength(1);
      sys.clock.now += 1;
      await sys.relayer.tick();
      expect(sys.alerts.byKind("ORDER_FAILED")).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------- crashes / restarts
  it("crash after sign, before broadcast → restart re-broadcasts the same raw tx; paid exactly once", async () => {
    const db = (await buildRelayer(world)).db;
    const crashing = await buildRelayer(world, { db, senderHooks: { bsc: { afterSign: () => { throw new Error("crash"); } } } });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await crashing.relayer.tick(); // one order failing never stops the loop; it is alerted
    expect(crashing.alerts.byKind("ORDER_PROCESSING_ERROR")).toHaveLength(1);
    const repo = new OrderRepo(db);
    expect((await repo.get(wKey(1n)))!.status).toBe("SUBMITTED");
    expect(await world.bsc.publicClient.getTransactionCount({ address: privateKeyToAccount(world.bscRelayerKey).address })).toBe(0);
    const before = await balanceOf(world.bsc, world.b.token, world.act.user.address);
    const restarted = await buildRelayer(world, { db });
    await restarted.relayer.tick();
    await finalizeBsc(world);
    await restarted.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("RELEASED");
    expect(await balanceOf(world.bsc, world.b.token, world.act.user.address)).toBe(before + 100n * U);
    const rows = await db.query<{ n: number }>("select count(*)::int as n from tx_attempts");
    expect(rows.rows[0]!.n).toBe(1);
  });

  it("crash after queueRelease (state lost) → replay returns already-Queued, quota not charged twice", async () => {
    const sys = await buildRelayer(world);
    await bridgeOut(world, world.act.user, 1500n * U);
    await confirmWantos(world);
    await sys.relayer.tick(); // queueRelease mined, not finalized
    const day = (await bscRead("currentDay")) as bigint;
    expect(await bscRead("dailyUsed", [day])).toBe(1500n * U);
    // process dies and its DB is lost entirely; a fresh instance rescans and re-sends queueRelease
    const fresh = await buildRelayer(world);
    await fresh.relayer.tick();
    const att = await fresh.db.query<{ action: string; state: string }>("select action, state from tx_attempts");
    expect(att.rows[0]).toMatchObject({ action: "queueRelease" });
    await fresh.relayer.tick();
    expect(await bscRead("dailyUsed", [day])).toBe(1500n * U); // contract no-op replay
    await finalizeBsc(world);
    await fresh.relayer.tick();
    expect((await new OrderRepo(fresh.db).get(wKey(1n)))!.status).toBe("QUEUED");
    expect(fresh.alerts.byKind("NONCE_MISMATCH").length).toBeGreaterThan(0); // DB lost → key history unknown
  });

  it("an RPC error while handling one order does not block the others", async () => {
    const sys = await buildRelayer(world);
    await bridgeOut(world, world.act.user, 100n * U);
    await bridgeOut(world, world.act.user2, 100n * U);
    await confirmWantos(world);
    const view = sys.relayer.wantosView;
    const orig = view.order.bind(view);
    view.order = async (id, at) => {
      if (id === 1n) throw new Error("rpc hiccup");
      return orig(id, at);
    };
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("DETECTED");
    expect((await new OrderRepo(sys.db).get(wKey(2n)))!.status).toBe("SUBMITTED");
    expect(sys.alerts.byKind("ORDER_PROCESSING_ERROR")).toHaveLength(1);
  });

  it("process restart mid-flight continues from the DB; duplicate events never duplicate orders", async () => {
    const a = await buildRelayer(world);
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await a.relayer.tick();
    const b = await buildRelayer(world, { db: a.db });
    await finalizeBsc(world);
    await b.relayer.tick();
    await b.relayer.tick();
    expect((await new OrderRepo(a.db).get(wKey(1n)))!.status).toBe("RELEASED");
    expect(await new OrderRepo(a.db).count()).toBe(1);
  });

  // ---------------------------------------------------------------- data sources
  it("BSC finalized unavailable → SUBMITTED never becomes RELEASED; no fallback to latest", async () => {
    const bc = world.bsc.publicClient as unknown as PublicClient;
    const flaky = new Flaky("bsc-b", new ViemChainReader("bsc-b", bc));
    const sys = await buildRelayer(world);
    const sys2 = await buildRelayer(world, { db: sys.db, bsc: { ...(sys.relayer as any).deps.bsc, readers: [new ViemChainReader("bsc-a", bc), flaky] } });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await sys2.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("SUBMITTED");
    flaky.noFinalized = true;
    await finalizeBsc(world);
    await sys2.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("SUBMITTED");
    expect(sys2.alerts.byKind("BSC_FINALIZED_UNAVAILABLE").length).toBeGreaterThan(0);
    flaky.noFinalized = false;
    await sys2.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("RELEASED");
  });

  it("network down (all RPCs, then partial) → no crash, alerts, resumes", async () => {
    const wc = world.wantos.publicClient as unknown as PublicClient;
    const bc = world.bsc.publicClient as unknown as PublicClient;
    const wp = new Flaky("w-primary", new ViemChainReader("w", wc));
    const wx = new Flaky("w-cross", new ViemChainReader("wx", wc));
    const ba = new Flaky("b-a", new ViemChainReader("ba", bc));
    const bb = new Flaky("b-b", new ViemChainReader("bb", bc));
    const base = await buildRelayer(world);
    const d = (base.relayer as any).deps;
    const sys = await buildRelayer(world, { db: base.db, wantos: { ...d.wantos, primary: wp, crossChecks: [wx] }, bsc: { ...d.bsc, readers: [ba, bb] } });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    for (const f of [wp, wx, ba, bb]) f.down = true;
    await expect(sys.relayer.tick()).resolves.toBeUndefined();
    expect(sys.alerts.byKind("RPC_UNAVAILABLE").length).toBeGreaterThan(0);
    expect(await sys.relayer.orders.count()).toBe(0);
    wp.down = false; // cross-check still down → WANTOS events not processed
    await sys.relayer.tick();
    expect(await sys.relayer.orders.count()).toBe(0);
    wx.down = false;
    await sys.relayer.tick();
    expect(await sys.relayer.orders.count()).toBe(1);
    ba.down = false;
    bb.down = false;
    await sys.relayer.tick();
    expect((await new OrderRepo(base.db).get(wKey(1n)))!.status).toBe("SUBMITTED");
  });

  it("WANTOS block hash change (real reorg on anvil) → WANTOS_REORG level 1, halt, no further sends", async () => {
    const sys = await buildRelayer(world);
    const seen: string[] = [];
    sys.safety.onReorg((s) => seen.push(s));
    await world.wantos.testClient.mine({ blocks: 10 });
    const fork = await world.wantos.testClient.snapshot();
    await world.wantos.testClient.mine({ blocks: 10 });
    await sys.relayer.tick(); // cursor inside the soon-to-be-replaced range
    await world.wantos.testClient.revert({ id: fork });
    await world.wantos.testClient.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(Date.now() / 1000) + 7777) });
    await bridgeOut(world, world.act.user, 100n * U); // different block contents → different hashes
    await world.wantos.testClient.mine({ blocks: 12 });
    await sys.relayer.tick();
    expect(sys.alerts.byKind("WANTOS_REORG")).toHaveLength(1);
    expect(sys.alerts.byKind("WANTOS_REORG")[0]!.level).toBe(1);
    expect(seen).toEqual(["wantos"]);
    await sys.relayer.tick();
    expect(await world.bsc.publicClient.getTransactionCount({ address: privateKeyToAccount(world.bscRelayerKey).address })).toBe(0);
  });

  it("stuck BSC tx is fee-bumped at the same nonce and the order still settles", async () => {
    const sys = await buildRelayer(world);
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await world.bsc.testClient.setAutomine(false);
    try {
      await sys.relayer.tick();
      sys.clock.now += 61_000;
      await sys.relayer.tick();
      const rows = await sys.db.query<{ nonce: string }>("select nonce from tx_attempts order by id");
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]!.nonce).toBe(rows.rows[1]!.nonce);
      await world.bsc.testClient.mine({ blocks: 1 });
    } finally {
      await world.bsc.testClient.setAutomine(true);
    }
    await sys.relayer.tick();
    await finalizeBsc(world);
    await sys.relayer.tick();
    expect((await new OrderRepo(sys.db).get(wKey(1n)))!.status).toBe("RELEASED");
  });

  // ---------------------------------------------------------------- review (owner-signed decisions verified by the relayer)
  it("REVIEW: owner approval (admin wallet signature) → queued; reject → REJECTED; forged signature refused", async () => {
    const review: RiskEngine = { evaluate: async () => ({ kind: "REVIEW", level: "audit" }) };
    const sys = await buildRelayer(world, { risk: review });
    const repo = new OrderRepo(sys.db);
    await bridgeOut(world, world.act.user, 100n * U);
    await bridgeOut(world, world.act.user2, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    expect((await repo.get(wKey(1n)))!.status).toBe("REVIEW");
    const exp = BigInt(Math.floor(sys.clock.now / 1000) + 600);
    const far = BigInt(Math.floor(sys.clock.now / 1000) + 2 * 86_400);
    const farSig = await world.act.admin.signMessage({ message: reviewMessage({ chainId: BSC_ID, eventKey: wKey(1n), decision: "approve", expires: far }) });
    await expect(sys.relayer.review.decide({ eventKey: wKey(1n), decision: "approve", expires: far, signature: farSig })).rejects.toThrow(/expires/);
    const past = BigInt(Math.floor(sys.clock.now / 1000) - 1);
    await expect(sys.relayer.review.decide({ eventKey: wKey(1n), decision: "approve", expires: past, signature: farSig })).rejects.toThrow(/expired/);
    await expect(sys.relayer.review.decide({ eventKey: ("0x" + "77".repeat(32)) as Hex, decision: "approve", expires: exp, signature: farSig })).rejects.toThrow(/unknown/);
    const forged = await world.act.user.signMessage({ message: reviewMessage({ chainId: BSC_ID, eventKey: wKey(1n), decision: "approve", expires: exp }) });
    await expect(sys.relayer.review.decide({ eventKey: wKey(1n), decision: "approve", expires: exp, signature: forged })).rejects.toThrow(/signature/);
    expect(sys.alerts.byKind("REVIEW_SIGNATURE_INVALID")).toHaveLength(1);
    const ok = await world.act.admin.signMessage({ message: reviewMessage({ chainId: BSC_ID, eventKey: wKey(1n), decision: "approve", expires: exp }) });
    await sys.relayer.review.decide({ eventKey: wKey(1n), decision: "approve", expires: exp, signature: ok });
    await sys.relayer.tick();
    const att = await sys.db.query<{ action: string }>("select action from tx_attempts");
    expect(att.rows.map((r) => r.action)).toEqual(["queueRelease"]); // approved REVIEW goes through the delay queue
    const rej = await world.act.admin.signMessage({ message: reviewMessage({ chainId: BSC_ID, eventKey: wKey(2n), decision: "reject", expires: exp }) });
    await sys.relayer.review.decide({ eventKey: wKey(2n), decision: "reject", expires: exp, signature: rej });
    expect((await repo.get(wKey(2n)))!.status).toBe("REJECTED");
    const audit = await sys.db.query<{ action: string }>("select action from audit_log order by id");
    expect(audit.rows.map((r) => r.action)).toEqual(["review.approve", "review.reject"]);
  });

  it("DELAY decision for a small W2B uses queueRelease", async () => {
    const sys = await buildRelayer(world, { risk: delay });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    const att = await sys.db.query<{ action: string }>("select action from tx_attempts");
    expect(att.rows.map((r) => r.action)).toEqual(["queueRelease"]);
  });
});
