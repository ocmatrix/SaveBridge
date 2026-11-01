import { createServer, type IncomingHttpHeaders } from "node:http";
import { isAddress, getAddress } from "viem";
import type { BridgeView } from "./chain/bridges";
import type { OrderRepo } from "./orders";
import type { OrderStatus } from "./stateMachine";
import type { Address } from "./types";

/**
 * Status shown to users (PR-5) — §7 "对外不公开": REVIEW is always "processing"; the other
 * pre-submission states (DETECTED/WAITING/FAILED) are folded into it too so that REVIEW cannot be
 * told apart. Reasons, review levels and errors are never exposed.
 */
export type PublicStatus = "processing" | "submitted" | "queued" | "released" | "rejected" | "refunding" | "refunded";

export function publicStatus(s: OrderStatus): PublicStatus {
  switch (s) {
    case "SUBMITTED":
      return "submitted";
    case "QUEUED":
      return "queued";
    case "RELEASED":
      return "released";
    case "REJECTED":
      return "rejected";
    case "REFUNDING":
      return "refunding";
    case "REFUNDED":
      return "refunded";
    default:
      return "processing";
  }
}

/**
 * PR-5 contract (docs/PR5-NOTES §4, apps/bridge-web parseRelayerOrders): exactly these three fields.
 * No status of any kind is returned (decision 16: disclose less; REVIEW can never leak); the page
 * derives status from chain state. `dstTxHash` is set only once the order is RELEASED.
 */
export interface PublicOrder {
  direction: "W2B" | "B2W";
  srcEventNonce: string;
  dstTxHash: string | null;
}

export interface QuotaView {
  address: Address;
  whitelisted: { wantos: boolean; bsc: boolean };
  /** W2B per-address allowance on WANTOS for the current UTC day (raw token units, decimal strings). */
  w2b: { minAmount: string; perAddrDailyCap: string; usedToday: string; remainingToday: string };
  b2w: { minDeposit: string; maxDepositPerTx: string };
}

export interface QuotaReader {
  quota(addr: Address): Promise<QuotaView>;
}

/** Reads quota from chain (latest block). */
export class ChainQuotaReader implements QuotaReader {
  constructor(
    private readonly wantos: BridgeView,
    private readonly bsc: BridgeView,
  ) {}

  async quota(addr: Address): Promise<QuotaView> {
    const [wlW, wlB, wp, bp, day] = await Promise.all([
      this.wantos.whitelisted(addr),
      this.bsc.whitelisted(addr),
      this.wantos.wantosParams(),
      this.bsc.bscParams(),
      this.wantos.currentDay(),
    ]);
    const used = await this.wantos.addrDailyUsed(day, addr);
    const remaining = wp.w2bPerAddrDailyCap > used ? wp.w2bPerAddrDailyCap - used : 0n;
    return {
      address: addr,
      whitelisted: { wantos: wlW, bsc: wlB },
      w2b: { minAmount: wp.w2bMinAmount.toString(), perAddrDailyCap: wp.w2bPerAddrDailyCap.toString(), usedToday: used.toString(), remainingToday: remaining.toString() },
      b2w: { minDeposit: bp.minDeposit.toString(), maxDepositPerTx: bp.maxDepositPerTx.toString() },
    };
  }
}

export class QuotaRateLimited extends Error {
  constructor() {
    super("quota rate limited");
  }
}

/**
 * Gate2 B5: /v1/quota reads ~6 contract views on the payout nodes. Answers are cached per address for
 * `ttlMs`, and cache misses share a global budget of `maxPerSecond` backend lookups (fixed 1 s window).
 */
export class CachedQuotaReader implements QuotaReader {
  private readonly cache = new Map<string, { at: number; v: QuotaView }>();
  private windowStart = -Infinity;
  private used = 0;
  constructor(
    private readonly inner: QuotaReader,
    private readonly o: { ttlMs: number; maxPerSecond: number; now?: () => number; maxEntries?: number },
  ) {}

  async quota(addr: Address): Promise<QuotaView> {
    const now = (this.o.now ?? Date.now)();
    const k = addr.toLowerCase();
    const hit = this.cache.get(k);
    if (hit && now - hit.at <= this.o.ttlMs) return hit.v;
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.used = 0;
    }
    if (this.used >= this.o.maxPerSecond) throw new QuotaRateLimited();
    this.used++;
    const v = await this.inner.quota(addr);
    if (this.cache.size >= (this.o.maxEntries ?? 10_000)) this.cache.clear();
    this.cache.set(k, { at: now, v });
    return v;
  }
}

/**
 * Admin back-office session check (PR-6, §8.2): the Cloudflare Worker forwards a short-lived
 * session signed by the owner's wallet (SIWE). The relayer must verify it itself (the Worker is
 * untrusted): signature, domain admin.wanto.pro, nonce/expiry, and that the signer is the current
 * on-chain `adminWallet()` (or whitelist wallet where allowed). Placeholder interface in PR-3.
 */
export interface AdminSessionVerifier {
  verify(headers: IncomingHttpHeaders | Record<string, string | undefined>): Promise<{ address: Address } | null>;
}

export const DenyAllAdminSessions: AdminSessionVerifier = { verify: async () => null };

export interface ApiRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders | Record<string, string | undefined>;
}
export interface ApiResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

const json = (status: number, v: unknown): ApiResponse => ({ status, body: JSON.stringify(v) });

export const ORDERS_LIMIT = 50;

export function createApi(o: {
  orders: OrderRepo;
  quota: QuotaReader;
  admin: AdminSessionVerifier;
  /** Exact origins allowed by CORS on /v1/* (default none; production: ["https://bridge.wanto.pro"]). */
  corsOrigins?: string[];
}) {
  const cors = new Set(o.corsOrigins ?? []);
  const headerOf = (h: ApiRequest["headers"], name: string): string | undefined => {
    const v = (h as Record<string, string | string[] | undefined>)[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const withCors = (req: ApiRequest, r: ApiResponse): ApiResponse => {
    const origin = headerOf(req.headers, "origin");
    if (!origin || !cors.has(origin)) return r;
    return { ...r, headers: { ...(r.headers ?? {}), "access-control-allow-origin": origin, vary: "Origin" } };
  };
  const addrParam = (u: URL): Address | null => {
    const a = u.searchParams.get("address");
    return a && isAddress(a, { strict: false }) ? getAddress(a) : null;
  };

  async function handle(req: ApiRequest): Promise<ApiResponse> {
    const u = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS" && u.pathname.startsWith("/v1/")) {
      const origin = headerOf(req.headers, "origin");
      if (!origin || !cors.has(origin)) return { status: 403, body: "" };
      return withCors(req, { status: 204, body: "", headers: { "access-control-allow-methods": "GET", "access-control-max-age": "600" } });
    }
    return withCors(req, await route(req, u));
  }

  async function route(req: ApiRequest, u: URL): Promise<ApiResponse> {
    if (u.pathname.startsWith("/admin/")) {
      const s = await o.admin.verify(req.headers).catch(() => null);
      if (!s) return json(401, { error: "unauthorized" });
      return json(501, { error: "not implemented (PR-6)" });
    }
    if (u.pathname !== "/v1/orders" && u.pathname !== "/v1/quota") return json(404, { error: "not found" });
    if (req.method !== "GET") return json(405, { error: "method not allowed" });
    const addr = addrParam(u);
    if (!addr) return json(400, { error: "address required" });
    if (u.pathname === "/v1/orders") {
      const list = await o.orders.listForUser(addr, ORDERS_LIMIT);
      const orders: PublicOrder[] = [];
      for (const ord of list) {
        orders.push({
          direction: ord.direction,
          srcEventNonce: ord.srcEventNonce.toString(),
          dstTxHash: ord.status === "RELEASED" ? await o.orders.releaseTxHash(ord.eventKey) : null,
        });
      }
      return json(200, { orders });
    }
    try {
      return json(200, await o.quota.quota(addr));
    } catch (e) {
      if (e instanceof QuotaRateLimited) return json(429, { error: "too many requests" });
      return json(503, { error: "temporarily unavailable" });
    }
  }

  async function listen(port: number, host = "127.0.0.1") {
    const srv = createServer((req, res) => {
      handle({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers })
        .catch(() => json(500, { error: "internal error" }))
        .then((r) => {
          res.writeHead(r.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...(r.headers ?? {}) });
          res.end(r.body);
        });
    });
    await new Promise<void>((r) => srv.listen(port, host, r));
    return {
      port: (srv.address() as { port: number }).port,
      close: () => new Promise<void>((r) => srv.close(() => r())),
    };
  }

  return { handle, listen };
}
