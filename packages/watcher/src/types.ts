import type { Address, Hex } from "viem";

export type ChainName = "bsc" | "wantos";
export const CHAINS: readonly ChainName[] = ["wantos", "bsc"] as const;
export const otherChain = (c: ChainName): ChainName => (c === "bsc" ? "wantos" : "bsc");

/** Unix seconds. */
export type Clock = () => number;

export type AlertLevel = 1 | 2 | 3;

export interface Alert {
  level: AlertLevel;
  code: string;
  title: string;
  chain?: ChainName;
  detail: Record<string, unknown>;
  at: number;
  key?: string;
  repeat?: boolean;
}

export interface DailyEntry {
  kind:
    | "WHITELIST_BATCH"
    | "EMERGENCY_REMOVAL"
    | "DAILY_CAP_70"
    | "RELEASE_QUEUED"
    | "REFUND_REQUESTED"
    | "DEPOSIT_REFUND_REQUESTED"
    | "SOURCE_VOIDED"
    | "LEGACY_PAID"
    | "RECONCILE_SURPLUS";
  chain: ChainName;
  id: string;
  data: Record<string, unknown>;
}

export interface Cursor {
  number: string; // bigint as decimal string
  hash: Hex;
  timestamp: number;
}

/**
 * §9.1 real-time checks. `targetChain` is where the checked event lives and therefore the
 * only chain that gets paused on a confirmed mismatch ("暂停只停受影响的那条链").
 *  - w2b:           BSC Released / ReleaseQueued       ↔ WANTOS BridgeOut           → pause BSC
 *  - b2w:           WANTOS ReleaseQueued               ↔ BSC finalized Deposited    → pause WANTOS
 *  - refund:        WANTOS RefundRequested             ↔ BSC payouts(key)=Voided    → pause WANTOS
 *  - depositRefund: BSC DepositRefundRequested         ↔ WANTOS payouts(key)=Voided → pause BSC
 */
export type CheckKind = "w2b" | "b2w" | "refund" | "depositRefund";

export interface PendingCheck {
  id: string;
  kind: CheckKind;
  targetChain: ChainName;
  eventName: string;
  block: string;
  timestamp: number;
  txHash: Hex;
  logIndex: number;
  nonce: string;
  to: Address;
  amount: string;
  eventKey: Hex;
  /** Earliest moment a mismatch may be acted upon (end of the grace period). */
  decideAt: number;
  pauseFailures?: number;
}

export interface TimelockOp {
  chain: ChainName;
  id: Hex;
  readyAt: number;
  calls: Array<{ target: Address; fn: string; args: unknown[] }>;
  remindersSent: number[];
}

export type Sums = Record<string, string>;

export interface ChainDerived {
  cursor: Cursor | null;
  /**
   * Latest observed `Unpaused` (block + block timestamp). An event counts as acknowledged by the owner
   * only if it is at/below that block AND the unpause happened after the event's grace period ended.
   */
  lastUnpaused: { block: string; timestamp: number } | null;
  sums: Sums;
}

export interface DerivedState {
  bsc: ChainDerived;
  wantos: ChainDerived;
  /** Gross WANTOS-USDT minted (Transfer from 0x0) since startBlock; never reset by pauses. */
  mintTotal: string;
  pending: PendingCheck[];
  timelockOps: Record<string, TimelockOp>;
  /** BSC Deposited nonce -> block number (to fetch the recipient from the right block). */
  depositBlocks: Record<string, string>;
  maxOrderId: string;
  maxDepositNonce: string;
}

export interface MetaState {
  decided: Record<string, number>;
  alertKeys: Record<string, number>;
  openLevel1: Record<string, { alert: Alert; lastSentAt: number }>;
  daily: { day: number; entries: DailyEntry[] };
  lastReconcileAt: number;
  lastHeartbeatAt: number;
  lastGasCheckAt: number;
  wantosHead: { number: string; seenAt: number } | null;
  watchedNonces: Record<string, string>;
  controlledSetHash: string | null;
  controlledSet: string[];
  snapshots: Array<{ wantosCursor: Cursor | null; derived: DerivedState }>;
}

export interface State {
  version: 1;
  derived: DerivedState;
  meta: MetaState;
}
