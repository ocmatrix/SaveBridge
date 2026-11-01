import type { Direction } from "./types";
import type { OrderStatus, ReviewLevel, WaitReason } from "./stateMachine";
import type { AlertKind } from "./alerts";

/** PR1-NOTES §5.3 payouts(eventKey).status. */
export enum PayoutStatus {
  None = 0,
  Queued = 1,
  Released = 2,
  Voided = 3,
}

export type PayoutAction = "release" | "queueRelease" | "executeRelease";

export interface OutcomeInput {
  direction: Direction;
  action: PayoutAction;
  /** Fresh read of payouts[eventKey].status after the failure (preferred source of truth). */
  payoutStatus?: PayoutStatus;
  errorName?: string;
  errorArgs?: readonly unknown[];
  errorMessage?: string;
}

export interface Outcome {
  status: OrderStatus;
  reason?: WaitReason;
  reviewLevel?: ReviewLevel;
  alert?: AlertKind;
}

const WAIT_BY_ERROR: Record<string, WaitReason> = {
  DailyCapExceeded: "quota",
  AddrDailyCapExceeded: "quota",
  SafeERC20FailedOperation: "reserve",
  ERC20InsufficientBalance: "reserve",
  EnforcedPause: "paused",
  NotWhitelisted: "whitelist",
};

function statusFromArgs(args?: readonly unknown[]): PayoutStatus | undefined {
  const v = args?.[1];
  if (v === undefined) return undefined;
  const n = Number(v);
  return n >= 0 && n <= 3 ? (n as PayoutStatus) : undefined;
}

function waitReasonFromError(i: OutcomeInput): WaitReason | undefined {
  if (i.errorName && WAIT_BY_ERROR[i.errorName]) return WAIT_BY_ERROR[i.errorName];
  if (i.errorName === "Error" && i.errorMessage && /exceeds balance|insufficient balance/i.test(i.errorMessage)) return "reserve";
  return undefined;
}

/**
 * DESIGN §6.3 回滚原因分类: read payouts[eventKey].status first —
 * Released→RELEASED; Queued→QUEUED; Voided→REJECTED; then
 * quota / reserve / paused / whitelist → WAITING(reason); amount above limit → REVIEW; anything else → FAILED.
 */
export function classifyOutcome(i: OutcomeInput): Outcome {
  const st = i.payoutStatus ?? (i.errorName === "BadPayoutStatus" ? statusFromArgs(i.errorArgs) : undefined);
  if (st === PayoutStatus.Released) return { status: "RELEASED" };
  if (st === PayoutStatus.Voided) return { status: "REJECTED" };
  if (st === PayoutStatus.Queued) {
    if (i.action !== "executeRelease" || !i.errorName || i.errorName === "NotReady" || i.errorName === "BadPayoutStatus") {
      return { status: "QUEUED" };
    }
    const r = waitReasonFromError(i);
    if (r && !(i.direction === "B2W" && r === "whitelist")) return { status: "QUEUED", reason: r };
    return { status: "FAILED", alert: alertFor(i.errorName) };
  }
  const reason = waitReasonFromError(i);
  if (reason) {
    if (i.direction === "B2W" && reason === "whitelist") return { status: "FAILED" };
    return { status: "WAITING", reason };
  }
  if (i.errorName === "AmountAboveLimit") return { status: "REVIEW", reviewLevel: "audit", reason: "amount_limit" };
  const alert = alertFor(i.errorName);
  return alert ? { status: "FAILED", alert } : { status: "FAILED" };
}

function alertFor(errorName?: string): AlertKind | undefined {
  return errorName === "AccessControlUnauthorizedAccount" ? "RELAYER_KEY_REVOKED" : undefined;
}
