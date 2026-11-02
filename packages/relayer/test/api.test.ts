import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newMigratedDb } from "./helpers/db";
import { OrderRepo, type NewOrder } from "../src/orders";
import { createApi, publicStatus, ChainQuotaReader, CachedQuotaReader, DenyAllAdminSessions, type QuotaReader, type AdminSessionVerifier } from "../src/api";
import { startWorld, whitelistBoth, bridgeOut, type World } from "./helpers/system";
import { BridgeView } from "../src/chain/bridges";
import { U } from "./helpers/deploy";
import type { PublicClient } from "viem";
import { ALL_STATUSES } from "../src/stateMachine";
import { toBytes } from "../src/bytes";

const A = "0x00000000000000000000000000000000000000aa";
const key = (i: number) => ("0x" + i.toString(16).padStart(64, "0")) as `0x${string}`;
const mk = (i: number, user = A): NewOrder => ({
  eventKey: key(i),
  direction: "W2B",
  srcChain: 13555,
  srcEventNonce: BigInt(i),
  srcTxHash: key(100 + i),
  srcBlockNumber: 1n,
  srcBlockHash: key(200 + i),
  userAddr: user as `0x${string}`,
  toAddr: user as `0x${string}`,
  amountWei: 5n * 10n ** 18n,
});
const fakeQuota: QuotaReader = {
  quota: async (addr) => ({ address: addr, whitelisted: { wantos: true, bsc: true }, w2b: { minAmount: "1", perAddrDailyCap: "10", usedToday: "3", remainingToday: "7" }, b2w: { minDeposit: "1", maxDepositPerTx: "9" } }),
};

describe("read-only API (for PR-5 / PR-6)", () => {
  it("public status helper still folds risk states (kept for PR-6 internal views)", () => {
    expect(publicStatus("REVIEW")).toBe("processing");
    expect(publicStatus("RELEASED")).toBe("released");
    for (const s of ALL_STATUSES) expect(typeof publicStatus(s)).toBe("string");
  });

  /** PR-5 parser (apps/bridge-web/src/lib/status.ts parseRelayerOrders), reproduced as the contract. */
  const pr5Parse = (body: unknown) => {
    const out: { direction: string; nonce: bigint; dstTxHash: string | null }[] = [];
    const orders = (body as { orders?: unknown }).orders;
    if (!Array.isArray(orders)) return out;
    for (const o of orders) {
      const { direction, srcEventNonce, dstTxHash } = o as Record<string, unknown>;
      if (direction !== "W2B" && direction !== "B2W") continue;
      if (typeof srcEventNonce !== "string" || !/^[1-9]\d{0,76}$/.test(srcEventNonce)) continue;
      const hash = typeof dstTxHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(dstTxHash) ? dstTxHash : null;
      out.push({ direction, nonce: BigInt(srcEventNonce), dstTxHash: hash });
    }
    return out;
  };

  it("E1: GET /v1/orders matches PR-5's contract: exactly {direction, srcEventNonce, dstTxHash}; no status", async () => {
    const db = await newMigratedDb();
    const repo = new OrderRepo(db);
    await repo.insertDetected(mk(1));
    await repo.insertDetected(mk(2));
    await repo.insertDetected(mk(3, "0x00000000000000000000000000000000000000bb"));
    await repo.insertDetected({ ...mk(4, "0x00000000000000000000000000000000000000bb"), direction: "B2W", toAddr: A }); // A is only the recipient
    await repo.insertDetected({ ...mk(5), direction: "B2W", toAddr: "0x00000000000000000000000000000000000000cc" }); // A is the depositor
    await repo.move((await repo.get(key(1)))!, "REVIEW", { reason: "fund_source", reviewLevel: "freeze" });
    // order 2: released by our mined release tx
    const relHash = ("0x" + "ab".repeat(32)) as `0x${string}`;
    await db.query("insert into tx_attempts (event_key, chain_id, nonce, tx_hash, state, action) values ($1, 56, 0, $2, 'replaced', 'release'), ($1, 56, 0, $3, 'mined', 'release')", [
      toBytes(key(2)),
      toBytes(("0x" + "cd".repeat(32)) as `0x${string}`),
      toBytes(relHash),
    ]);
    await db.query("update orders set status = 'RELEASED' where event_key = $1", [toBytes(key(2))]);
    const api = createApi({ orders: repo, quota: fakeQuota, admin: DenyAllAdminSessions });
    const r = await api.handle({ method: "GET", url: `/v1/orders?address=${A}`, headers: {} });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    for (const o of body.orders) expect(Object.keys(o).sort()).toEqual(["direction", "dstTxHash", "srcEventNonce"]);
    expect(r.body).not.toMatch(/status|fund_source|freeze|REVIEW|reason|review/i);
    const parsed = pr5Parse(body);
    expect(parsed).toHaveLength(3);
    expect(parsed).toEqual(
      expect.arrayContaining([
        { direction: "W2B", nonce: 1n, dstTxHash: null },
        { direction: "W2B", nonce: 2n, dstTxHash: relHash },
        { direction: "B2W", nonce: 5n, dstTxHash: null },
      ]),
    );
  });

  it("E1: at most 50 orders, newest first", async () => {
    const db = await newMigratedDb();
    let t = 0;
    const repo = new OrderRepo(db, () => new Date(1_700_000_000_000 + t++ * 1000));
    for (let i = 1; i <= 60; i++) await repo.insertDetected(mk(i));
    const api = createApi({ orders: repo, quota: fakeQuota, admin: DenyAllAdminSessions });
    const body = JSON.parse((await api.handle({ method: "GET", url: `/v1/orders?address=${A}`, headers: {} })).body);
    expect(body.orders).toHaveLength(50);
    expect(body.orders[0].srcEventNonce).toBe("60");
  });

  it("E1: CORS only for configured origins (default: none)", async () => {
    const repo = new OrderRepo(await newMigratedDb());
    const closed = createApi({ orders: repo, quota: fakeQuota, admin: DenyAllAdminSessions });
    const r0 = await closed.handle({ method: "GET", url: `/v1/orders?address=${A}`, headers: { origin: "https://bridge.wanto.pro" } });
    expect(r0.headers?.["access-control-allow-origin"]).toBeUndefined();
    const open = createApi({ orders: repo, quota: fakeQuota, admin: DenyAllAdminSessions, corsOrigins: ["https://bridge.wanto.pro"] });
    const r1 = await open.handle({ method: "GET", url: `/v1/orders?address=${A}`, headers: { origin: "https://bridge.wanto.pro" } });
    expect(r1.headers?.["access-control-allow-origin"]).toBe("https://bridge.wanto.pro");
    expect(r1.headers?.["vary"]).toBe("Origin");
    const pre = await open.handle({ method: "OPTIONS", url: `/v1/orders?address=${A}`, headers: { origin: "https://bridge.wanto.pro" } });
    expect(pre.status).toBe(204);
    expect(pre.headers?.["access-control-allow-methods"]).toBe("GET");
    const evil = await open.handle({ method: "GET", url: `/v1/orders?address=${A}`, headers: { origin: "https://evil.example" } });
    expect(evil.headers?.["access-control-allow-origin"]).toBeUndefined();
    const evilPre = await open.handle({ method: "OPTIONS", url: `/v1/orders?address=${A}`, headers: { origin: "https://evil.example" } });
    expect(evilPre.status).toBe(403);
  });

  it("validates input and methods", async () => {
    const api = createApi({ orders: new OrderRepo(await newMigratedDb()), quota: fakeQuota, admin: DenyAllAdminSessions });
    expect((await api.handle({ method: "GET", url: "/v1/orders", headers: {} })).status).toBe(400);
    expect((await api.handle({ method: "GET", url: "/v1/orders?address=0x123", headers: {} })).status).toBe(400);
    expect((await api.handle({ method: "GET", url: "/v1/quota?address=nope", headers: {} })).status).toBe(400);
    expect((await api.handle({ method: "POST", url: `/v1/orders?address=${A}`, headers: {} })).status).toBe(405);
    expect((await api.handle({ method: "GET", url: "/nope", headers: {} })).status).toBe(404);
  });

  it("GET /v1/quota?address= returns the quota view", async () => {
    const api = createApi({ orders: new OrderRepo(await newMigratedDb()), quota: fakeQuota, admin: DenyAllAdminSessions });
    const r = await api.handle({ method: "GET", url: `/v1/quota?address=${A}`, headers: {} });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).w2b.remainingToday).toBe("7");
  });

  it("quota backend failure → 503 without leaking details", async () => {
    const api = createApi({ orders: new OrderRepo(await newMigratedDb()), quota: { quota: async () => { throw new Error("rpc secret-host down"); } }, admin: DenyAllAdminSessions });
    const r = await api.handle({ method: "GET", url: `/v1/quota?address=${A}`, headers: {} });
    expect(r.status).toBe(503);
    expect(r.body).not.toMatch(/secret-host/);
  });

  it("admin routes: no/invalid SIWE session → 401; valid session → 501 (placeholder until PR-6)", async () => {
    const repo = new OrderRepo(await newMigratedDb());
    expect((await createApi({ orders: repo, quota: fakeQuota, admin: DenyAllAdminSessions }).handle({ method: "GET", url: "/admin/v1/orders", headers: {} })).status).toBe(401);
    const allow: AdminSessionVerifier = { verify: async (h) => (h["authorization"] === "Bearer ok" ? { address: A } : null) };
    const api = createApi({ orders: repo, quota: fakeQuota, admin: allow });
    expect((await api.handle({ method: "GET", url: "/admin/v1/orders", headers: { authorization: "Bearer bad" } })).status).toBe(401);
    expect((await api.handle({ method: "GET", url: "/admin/v1/orders", headers: { authorization: "Bearer ok" } })).status).toBe(501);
  });

  it("B5: /v1/quota is cached per address and globally rate-limited (429 when over budget)", async () => {
    let calls = 0;
    const inner: QuotaReader = { quota: async (a) => (calls++, fakeQuota.quota(a)) };
    let now = 0;
    const cached = new CachedQuotaReader(inner, { ttlMs: 15_000, maxPerSecond: 2, now: () => now });
    const api = createApi({ orders: new OrderRepo(await newMigratedDb()), quota: cached, admin: DenyAllAdminSessions });
    const get = (a: string) => api.handle({ method: "GET", url: `/v1/quota?address=${a}`, headers: {} });
    expect((await get(A)).status).toBe(200);
    expect((await get(A)).status).toBe(200);
    expect(calls).toBe(1); // cache hit
    expect((await get("0x00000000000000000000000000000000000000b1")).status).toBe(200);
    const limited = await get("0x00000000000000000000000000000000000000b2");
    expect(limited.status).toBe(429);
    expect(calls).toBe(2);
    expect((await get(A)).status).toBe(200); // cached answers are still served while limited
    now += 1_000;
    expect((await get("0x00000000000000000000000000000000000000b2")).status).toBe(200);
    now += 15_001;
    await get(A);
    expect(calls).toBe(4); // expired → refetched
  });

  it("serves over HTTP on 127.0.0.1", async () => {
    const api = createApi({ orders: new OrderRepo(await newMigratedDb()), quota: fakeQuota, admin: DenyAllAdminSessions });
    const srv = await api.listen(0, "127.0.0.1");
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/v1/orders?address=${A}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally {
      await srv.close();
    }
  });
});

describe("ChainQuotaReader against anvil", () => {
  let world: World;
  beforeAll(async () => {
    world = await startWorld();
    await whitelistBoth(world, [world.act.user.address]);
  });
  afterAll(async () => world?.stop());

  it("reports whitelist on both chains and today's remaining W2B allowance", async () => {
    const q = new ChainQuotaReader(
      new BridgeView("wantos", world.wantos.publicClient as unknown as PublicClient, world.w.bridge),
      new BridgeView("bsc", world.bsc.publicClient as unknown as PublicClient, world.b.bridge),
    );
    await bridgeOut(world, world.act.user, 300n * U);
    const r = await q.quota(world.act.user.address);
    expect(r.whitelisted).toEqual({ wantos: true, bsc: true });
    expect(r.w2b).toEqual({ minAmount: (10n * U).toString(), perAddrDailyCap: (2000n * U).toString(), usedToday: (300n * U).toString(), remainingToday: (1700n * U).toString() });
    expect(r.b2w).toEqual({ minDeposit: (10n * U).toString(), maxDepositPerTx: (2000n * U).toString() });
    expect((await q.quota(world.act.user2.address)).whitelisted).toEqual({ wantos: false, bsc: false });
  });
});
