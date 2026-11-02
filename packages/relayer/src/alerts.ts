/**
 * Relayer's own alert outputs (DESIGN §6.5 "付款程序自己发心跳和告警", §9.3). Only interfaces plus
 * memory/log implementations — no real Telegram/SMS integration in this PR.
 */
export const ALERT_LEVEL = {
  WANTOS_REORG: 1,
  HEARTBEAT_MISSED: 1,
  RESERVE_CRITICAL: 1,
  BSC_REORG: 1,
  /** A rejected / to-be-refunded order whose payout is Released: refunding it would pay twice. */
  PAYOUT_ALREADY_RELEASED: 1,
  /** A signed payout tx was about to be (re)broadcast or fee-bumped but its source order is no longer intact. */
  SIGNED_TX_SOURCE_MISMATCH: 1,
  WAIT_TIMEOUT: 2,
  STATE_TIMEOUT: 2,
  NONCE_MISMATCH: 2,
  KMS_FAILURE: 2,
  GAS_LOW: 2,
  BSC_FINALIZED_UNAVAILABLE: 2,
  RPC_UNAVAILABLE: 2,
  RPC_MISMATCH: 2,
  RESERVE_LOW: 2,
  RELAYER_KEY_REVOKED: 2,
  TX_STUCK: 2,
  ORDER_FAILED: 2,
  ORDER_ONCHAIN_MISMATCH: 2,
  WHITELIST_INCONSISTENT: 2,
  TIMELOCK_REMINDER: 2,
  TIMELOCK_EXECUTED: 3,
  TIMELOCK_EXEC_BLOCKED: 2,
  TIMELOCK_EXECUTOR_ERROR: 2,
  REVIEW_SIGNATURE_INVALID: 2,
  LOOP_ERROR: 2,
  ORDER_PROCESSING_ERROR: 2,
} as const;
export type AlertKind = keyof typeof ALERT_LEVEL;
export type AlertLevel = 1 | 2 | 3;

export interface AlertInput {
  kind: AlertKind;
  message: string;
  /** Dedup key; defaults to kind. */
  key?: string;
  data?: Record<string, unknown>;
}
export interface Alert extends AlertInput {
  level: AlertLevel;
  at: number;
}

export interface AlertSink {
  emit(a: AlertInput): Promise<void>;
}

function complete(a: AlertInput): Alert {
  return { ...a, level: ALERT_LEVEL[a.kind], at: Date.now() };
}

export class MemoryAlertSink implements AlertSink {
  readonly alerts: Alert[] = [];
  async emit(a: AlertInput): Promise<void> {
    this.alerts.push(complete(a));
  }
  byKind(kind: AlertKind): Alert[] {
    return this.alerts.filter((a) => a.kind === kind);
  }
  clear(): void {
    this.alerts.length = 0;
  }
}

export class LogAlertSink implements AlertSink {
  constructor(private readonly write: (line: string) => void = (l) => console.error(l)) {}
  async emit(a: AlertInput): Promise<void> {
    this.write(JSON.stringify(complete(a), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  }
}

export class FanoutAlertSink implements AlertSink {
  constructor(private readonly sinks: AlertSink[]) {}
  async emit(a: AlertInput): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.emit(a).catch(() => undefined)));
  }
}

/** Suppresses repeats of the same key inside `windowMs`. */
export class DedupAlertSink implements AlertSink {
  private readonly last = new Map<string, number>();
  constructor(
    private readonly inner: AlertSink,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  async emit(a: AlertInput): Promise<void> {
    const k = `${a.kind}:${a.key ?? ""}`;
    const t = this.now();
    const prev = this.last.get(k);
    if (prev !== undefined && t - prev < this.windowMs) return;
    this.last.set(k, t);
    await this.inner.emit(a);
  }
}
