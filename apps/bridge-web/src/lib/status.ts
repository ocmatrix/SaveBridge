import { isHex, type Hex } from "viem";

/** The only order states a user ever sees. Risk-control states (REVIEW etc.) are all "processing" (DESIGN §7). */
export type UserStatus = "processing" | "completed" | "refunding" | "refunded" | "awaitingCredit";

/**
 * W2B. `orderStatus` = WANTOS orders(id).status (1 Locked / 2 Refunding / 3 Refunded);
 * `payoutStatus` = BSC payouts(eventKeyOf(id)).status (0 None / 1 Queued / 2 Released / 3 Voided), null if unreadable.
 */
export function w2bUserStatus(orderStatus: number, payoutStatus: number | null): UserStatus {
  if (orderStatus === 3) return "refunded";
  if (orderStatus === 2) return "refunding";
  if (payoutStatus === 2) return "completed";
  return "processing";
}

/**
 * B2W. `refundStatus` = BSC deposits(nonce).refundStatus (0 None / 1 Refunding / 2 Refunded);
 * `payoutStatus` = WANTOS payouts(eventKeyOf(nonce)).status, null if unreadable.
 */
export function b2wUserStatus(refundStatus: number, payoutStatus: number | null): UserStatus {
  if (refundStatus === 2) return "refunded";
  if (refundStatus === 1) return "refunding";
  if (payoutStatus === 2) return "completed";
  if (payoutStatus === 3) return "processing";
  return "awaitingCredit";
}

/** Relayer (§6.3) state → user state. Unknown or internal states are always "processing". */
export function mapRelayerStatus(s: string): UserStatus {
  switch (s) {
    case "RELEASED":
      return "completed";
    case "REFUNDING":
      return "refunding";
    case "REFUNDED":
      return "refunded";
    default:
      return "processing";
  }
}

export interface RelayerOrder {
  direction: "W2B" | "B2W";
  nonce: bigint;
  status: UserStatus;
  dstTxHash: Hex | null;
}

/**
 * Parses the response of `GET /v1/orders?address=` in the shape requested from PR-3 (docs/PR5-NOTES.md §4).
 * Untrusted input: malformed entries are dropped; no field is ever used as a transaction target.
 */
export function parseRelayerOrders(body: unknown): RelayerOrder[] {
  const list = (body as { orders?: unknown } | null)?.orders;
  if (!Array.isArray(list)) return [];
  const out: RelayerOrder[] = [];
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const { direction, srcEventNonce, status, dstTxHash } = o as Record<string, unknown>;
    if (direction !== "W2B" && direction !== "B2W") continue;
    if (typeof srcEventNonce !== "string" || !/^[1-9]\d{0,76}$/.test(srcEventNonce)) continue;
    if (typeof status !== "string") continue;
    const hash = typeof dstTxHash === "string" && isHex(dstTxHash, { strict: true }) && dstTxHash.length === 66 ? dstTxHash : null;
    out.push({ direction, nonce: BigInt(srcEventNonce), status: mapRelayerStatus(status), dstTxHash: hash });
  }
  return out;
}
