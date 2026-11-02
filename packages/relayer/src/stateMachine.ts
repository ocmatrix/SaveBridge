import type { Direction } from "./types";

/** DESIGN §6.3 order states. */
export const ALL_STATUSES = [
  "DETECTED",
  "WAITING",
  "REVIEW",
  "SUBMITTED",
  "QUEUED",
  "RELEASED",
  "REJECTED",
  "REFUNDING",
  "REFUNDED",
  "FAILED",
] as const;
export type OrderStatus = (typeof ALL_STATUSES)[number];

/** §6.3 WAITING reasons: 索引、白名单、额度、储备、暂停、金额超限. */
export const WAIT_REASONS = ["index", "whitelist", "quota", "reserve", "paused", "amount_limit"] as const;
export type WaitReason = (typeof WAIT_REASONS)[number];
export type ReviewLevel = "audit" | "freeze";

export function waitReasonsFor(direction: Direction): readonly WaitReason[] {
  // §6.3 B2W: 储备、额度、暂停；没有白名单原因. "index" is kept for B2W too (data-source not ready).
  return direction === "B2W" ? WAIT_REASONS.filter((r) => r !== "whitelist" && r !== "amount_limit") : WAIT_REASONS;
}

const TERMINAL: ReadonlySet<OrderStatus> = new Set(["RELEASED", "REFUNDED"]);

/** Outcomes reachable from any pre-RELEASED active state by reading payouts[eventKey] (classification table). */
const CLASSIFIED: OrderStatus[] = ["WAITING", "REVIEW", "SUBMITTED", "QUEUED", "RELEASED", "REJECTED", "FAILED"];

const W2B: Record<OrderStatus, OrderStatus[]> = {
  DETECTED: CLASSIFIED,
  WAITING: CLASSIFIED,
  REVIEW: CLASSIFIED,
  SUBMITTED: CLASSIFIED,
  // QUEUED: due -> SUBMITTED (executeRelease); revoked / removed -> REJECTED; observed Released (e.g. after crash) -> RELEASED.
  QUEUED: ["QUEUED", "SUBMITTED", "RELEASED", "REJECTED", "FAILED"],
  // REJECTED: void finalized on the payout chain -> REFUNDING.
  REJECTED: ["REFUNDING"],
  // REFUNDING: refund executed -> REFUNDED; a cancelled refund stays REFUNDING (§6.3).
  REFUNDING: ["REFUNDING", "REFUNDED"],
  RELEASED: [],
  REFUNDED: [],
  // FAILED: manual only -> retry (back to DETECTED for re-evaluation) or REJECTED.
  FAILED: ["DETECTED", "REJECTED"],
};

export function isTerminal(s: OrderStatus): boolean {
  return TERMINAL.has(s);
}

export function canTransition(direction: Direction, from: OrderStatus, to: OrderStatus): boolean {
  void direction; // both directions share the table; direction-specific rules are on reasons
  return W2B[from].includes(to);
}

export function assertTransition(direction: Direction, from: OrderStatus, to: OrderStatus, reason?: WaitReason | null): void {
  if (!canTransition(direction, from, to)) throw new Error(`illegal transition ${direction} ${from} -> ${to}`);
  if (to === "WAITING") {
    if (!reason || !(WAIT_REASONS as readonly string[]).includes(reason)) throw new Error(`WAITING requires a known reason, got ${reason}`);
    if (!waitReasonsFor(direction).includes(reason)) throw new Error(`${direction} cannot wait for reason ${reason}`);
  }
}

const MIN = 60_000;
const H = 60 * MIN;

/** Alert thresholds per state (ms after entering the state). Unspecified values are PR3-NOTES deviations. */
export const DEFAULT_TIMEOUTS = {
  detectedMs: 10 * MIN,
  waiting: { index: 10 * MIN, whitelist: 30 * MIN, reserve: 0, quota: 6 * H, paused: 1 * H, amount_limit: 0 } as Record<WaitReason, number>,
  review: { audit: 72 * H, freeze: 7 * 24 * H } as Record<ReviewLevel, number>,
  submittedMs: 30 * MIN,
  queuedGraceMs: 30 * MIN,
  queuedNoEtaMs: 24 * H,
  rejectedMs: 72 * H,
  refundingMs: 72 * H,
  failedMs: 0,
};
export type Timeouts = typeof DEFAULT_TIMEOUTS;

export interface TimeoutInput {
  status: OrderStatus;
  reason?: WaitReason | string | null;
  reviewLevel?: ReviewLevel | string | null;
  executableAt?: Date | null;
  stateSince?: Date | null;
}

/** Milliseconds after `stateSince` at which an alert fires; undefined for terminal states. */
export function timeoutFor(o: TimeoutInput, t: Timeouts = DEFAULT_TIMEOUTS): number | undefined {
  switch (o.status) {
    case "DETECTED":
      return t.detectedMs;
    case "WAITING":
      return t.waiting[(o.reason as WaitReason) ?? "index"] ?? t.waiting.index;
    case "REVIEW":
      return t.review[(o.reviewLevel as ReviewLevel) ?? "audit"] ?? t.review.audit;
    case "SUBMITTED":
      return t.submittedMs;
    case "QUEUED":
      if (o.executableAt && o.stateSince) return Math.max(0, o.executableAt.getTime() - o.stateSince.getTime()) + t.queuedGraceMs;
      return t.queuedNoEtaMs;
    case "REJECTED":
      return t.rejectedMs;
    case "REFUNDING":
      return t.refundingMs;
    case "FAILED":
      return t.failedMs;
    case "RELEASED":
    case "REFUNDED":
      return undefined;
  }
}
