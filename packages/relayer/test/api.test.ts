import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newMigratedDb } from "./helpers/db";
import { OrderRepo, type NewOrder } from "../src/orders";
import { createApi, publicStatus, ChainQuotaReader, DenyAllAdminSessions, type QuotaReader, type AdminSessionVerifier } from "../src/api";
import { startWorld, whitelistBoth, bridgeOut, type World } from "./helpers/system";
import { BridgeView } from "../src/chain/bridges";
import { U } from "./helpers/deploy";
import type { PublicClient } from "viem";
import { ALL_STATUSES } from "../src/stateMachine";

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
  it("public status hides risk states: REVIEW (and other pre-submit states) → processing", () => {
    expect(publicStatus("REVIEW")).toBe("processing");
    expect(publicStatus("WAITING")).toBe("processing");
    expect(publicStatus("DETECTED")).toBe("processing");
    expect(publicStatus("FAILED")).toBe("processing");
    expect(publicStatus("RELEASED")).toBe("released");
    expect(publicStatus("QUEUED")).toBe("queued");
    for (const s of ALL_STATUSES) expect(typeof publicStatus(s)).toBe("string");
  });

  it("GET /v1/orders?address= returns the address' orders without internal fields", async () => {
    const db = await newMigratedDb();
    const repo = new OrderRepo(db);
    await repo.insertDetected(mk(1));
    await repo.insertDetected(mk(2, "0x00000000000000000000000000000000000000bb"));
    const o = (await repo.get(key(1)))!;
    await repo.move(o, "REVIEW", { reason: "fund_source", reviewLevel: "freeze" });
    const api = createApi({ orders: repo, quota: fakeQuota, admin: DenyAllAdminSessions });
    const r = await api.handle({ method: "GET", url: `/v1/orders?address=${A}`, headers: {} });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({ direction: "W2B", nonce: "1", status: "processing", amount: "5000000000000000000" });
    expect(r.body).not.toMatch(/fund_source|freeze|REVIEW|reason|review/i);
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
