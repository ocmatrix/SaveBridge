import type { Hex } from "viem";
import type { ReviewDecision } from "./review";

/**
 * Relayer admin API through the Cloudflare Worker (DESIGN §8.2). The Worker only forwards; the relayer verifies the
 * SIWE session and every signed decision itself. PR-3 currently answers /admin/* with 401/501 (placeholder) — these
 * endpoint shapes are the PR-6 proposal (PR6-NOTES §4).
 */
export interface ReviewOrder {
  eventKey: Hex;
  direction: "W2B" | "B2W";
  srcEventNonce: string;
  user: string;
  to: string;
  amount: string; // wei, decimal string
  level: "audit" | "freeze";
  /** relayer reason code, e.g. onchain_mismatch (source-order check), amount_limit, whitelist_removed */
  reason: string | null;
  createdAt: string;
}
export interface AddressInfo {
  inNetwork: boolean | null;
  parent: string | null;
  bridgedOut: string | null;
}
export interface ReportLine {
  at: string;
  text: string;
}
export interface Report {
  reconciliation: ReportLine[];
  alerts: ReportLine[];
  whitelistDaily: ReportLine[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class AdminApi {
  constructor(
    private readonly base: string,
    private readonly authHeader: () => Promise<string>,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async req<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
    const res = await this.fetchFn(`${this.base.replace(/\/$/, "")}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: await this.authHeader(), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : undefined,
      credentials: "omit",
      cache: "no-store",
    });
    if (!res.ok) throw new ApiError(res.status === 401 ? "会话无效或已过期，请重新签名登录" : res.status === 501 ? "付款程序尚未实现该接口（占位）" : `接口错误 ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  reviewOrders = () => this.req<{ orders: ReviewOrder[] }>("/admin/orders?status=REVIEW").then((r) => r.orders);
  decide = (d: { eventKey: Hex; decision: ReviewDecision; expires: bigint; signature: Hex }) => this.req<unknown>("/admin/review", { method: "POST", body: d });
  addressInfo = (addrs: string[]) => this.req<Record<string, AddressInfo>>("/admin/address-info", { method: "POST", body: { addrs } });
  report = () => this.req<Report>("/admin/report");
}
