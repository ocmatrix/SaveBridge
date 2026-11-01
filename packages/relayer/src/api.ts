import { createServer, type IncomingHttpHeaders } from "node:http";
import { isAddress, getAddress } from "viem";
import type { BridgeView } from "./chain/bridges";
import type { OrderRepo, Order } from "./orders";
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

export interface PublicOrder {
  direction: "W2B" | "B2W";
  srcChainId: number;
  nonce: string;
  eventKey: string;
  srcTxHash: string;
  from: Address;
  to: Address;
  amount: string;
  status: PublicStatus;
  executableAt: string | null;
  createdAt: string;
}

function toPublic(o: Order): PublicOrder {
  return {
    direction: o.direction,
    srcChainId: o.srcChain,
    nonce: o.srcEventNonce.toString(),
    eventKey: o.eventKey,
    srcTxHash: o.srcTxHash,
    from: o.userAddr,
    to: o.toAddr,
    amount: o.amountWei.toString(),
    status: publicStatus(o.status),
    executableAt: o.status === "QUEUED" && o.executableAt ? o.executableAt.toISOString() : null,
    createdAt: o.createdAt.toISOString(),
  };
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
}

const json = (status: number, v: unknown): ApiResponse => ({ status, body: JSON.stringify(v) });

export function createApi(o: { orders: OrderRepo; quota: QuotaReader; admin: AdminSessionVerifier }) {
  const addrParam = (u: URL): Address | null => {
    const a = u.searchParams.get("address");
    return a && isAddress(a, { strict: false }) ? getAddress(a) : null;
  };

  async function handle(req: ApiRequest): Promise<ApiResponse> {
    const u = new URL(req.url, "http://localhost");
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
      const list = await o.orders.listByAddress(addr, 100);
      return json(200, { address: addr, orders: list.map(toPublic) });
    }
    try {
      return json(200, await o.quota.quota(addr));
    } catch {
      return json(503, { error: "temporarily unavailable" });
    }
  }

  async function listen(port: number, host = "127.0.0.1") {
    const srv = createServer((req, res) => {
      handle({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers })
        .catch(() => json(500, { error: "internal error" }))
        .then((r) => {
          res.writeHead(r.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
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
