import type { Alert, AlertLevel, ChainName, Clock, DailyEntry, MetaState } from "./types.js";

/**
 * DESIGN §9.3 alert levels. One code per alert kind; the level comes from this table only.
 * 1 = phone + SMS, repeated after 24h until acknowledged; 2 = instant message; 3 = daily report.
 */
export const ALERT_LEVELS = {
  // level 1
  AUTO_PAUSE: 1,
  PAUSE_FAILED: 1,
  TIMELOCK_PROPOSED: 1,
  KEY_CHANGE: 1,
  RESERVE_CRITICAL: 1,
  RELAYER_UNREACHABLE: 1,
  WANTOS_REORG: 1,
  MINT_EXCESS: 1,
  // level 2
  PAUSED: 2,
  UNPAUSED: 2,
  PAUSER_REVOKED: 2,
  UPGRADE_EXECUTED: 2,
  MINT: 2,
  CONTROLLED_SET_CHANGED: 2,
  PARAMS_INCONSISTENT: 2,
  PARAMS_UPDATED: 2,
  SUPPLY_CEILING_UPDATED: 2,
  RESERVE_LOW: 2,
  WANTOS_BALANCE_LOW: 2,
  INDEX_LAG: 2,
  WANTOS_STALLED: 2,
  BSC_NO_FINALIZED: 2,
  RPC_UNREACHABLE: 2,
  RPC_DISAGREE: 2,
  CHECK_DEFERRED: 2,
  MISMATCH_ACKNOWLEDGED: 2,
  RECONCILE_SHORTFALL: 2,
  RECONCILE_FAILED: 2,
  GAS_LOW: 2,
  LEGACY_ACTIVITY: 2,
  CONTROLLED_FUNDS_MOVED: 2,
  WHITELIST_FROZEN: 2,
  VOID_FUTURE_SOURCE: 2,
  WITHDRAWN: 2,
  TIMELOCK_REMINDER: 2,
  TIMELOCK_CANCELLED: 2,
  HEARTBEAT_FAILED: 2,
  // level 3
  DAILY_REPORT: 3,
} as const satisfies Record<string, AlertLevel>;

export type AlertCode = keyof typeof ALERT_LEVELS;

export interface AlertSink {
  send(alert: Alert): Promise<void>;
}

const jsonSafe = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** Keeps alerts in memory (tests, and as the in-process audit trail). */
export class MemoryAlertSink implements AlertSink {
  readonly alerts: Alert[] = [];
  async send(alert: Alert): Promise<void> {
    this.alerts.push(alert);
  }
  codes(): string[] {
    return this.alerts.map((a) => a.code);
  }
}

/** Writes one JSON line per alert (stdout or an append-only file). */
export class LogAlertSink implements AlertSink {
  constructor(private readonly write: (line: string) => void) {}
  async send(alert: Alert): Promise<void> {
    this.write(jsonSafe(alert));
  }
}

/** Fans out to several sinks; a failing sink does not stop the others. */
export class MultiAlertSink implements AlertSink {
  constructor(private readonly sinks: AlertSink[]) {}
  async send(alert: Alert): Promise<void> {
    const results = await Promise.allSettled(this.sinks.map((s) => s.send(alert)));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length === this.sinks.length && failed.length > 0) throw new Error("all alert sinks failed");
  }
}

export interface DraftHttpRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * DRAFT ONLY. Builds the Telegram Bot API request body for an alert; it never performs a
 * network call (TRAIN.md / PR-7 boundary: no real Telegram/SMS/phone integration in this PR).
 * The token is referenced by name (`botTokenRef`), never embedded.
 */
export class TelegramDraftAdapter implements AlertSink {
  constructor(private readonly opts: { botTokenRef: string; chatId: string }) {}

  buildRequest(alert: Alert): DraftHttpRequest {
    const prefix = alert.level === 1 ? "🔴 一级" : alert.level === 2 ? "🟠 二级" : "⚪ 三级";
    return {
      method: "POST",
      url: "https://api.telegram.org/bot<bot-token>/sendMessage",
      headers: { "content-type": "application/json", "x-token-ref": this.opts.botTokenRef },
      body: jsonSafe({
        chat_id: this.opts.chatId,
        text: `${prefix} [${alert.code}] ${alert.title}\n${jsonSafe(alert.detail)}`,
        disable_notification: alert.level === 3,
      }),
    };
  }

  async send(_alert: Alert): Promise<void> {
    throw new Error("TelegramDraftAdapter is a draft: sending is not wired in PR-7");
  }
}

const DAY = 86_400;
const REPEAT_LEVEL1_AFTER = DAY;

export class AlertManager {
  constructor(
    private readonly sink: AlertSink,
    private readonly meta: () => MetaState,
    private readonly clock: Clock,
  ) {}

  /** Returns false when suppressed by `key` dedupe. */
  async raise(
    code: AlertCode,
    a: { title: string; chain?: ChainName; detail?: Record<string, unknown>; key?: string },
  ): Promise<boolean> {
    const m = this.meta();
    const now = this.clock();
    if (a.key !== undefined) {
      if (m.alertKeys[a.key] !== undefined) return false;
      m.alertKeys[a.key] = now;
    }
    const alert: Alert = {
      level: ALERT_LEVELS[code],
      code,
      title: a.title,
      detail: a.detail ?? {},
      at: now,
      ...(a.chain !== undefined ? { chain: a.chain } : {}),
      ...(a.key !== undefined ? { key: a.key } : {}),
    };
    if (alert.level === 1) m.openLevel1[a.key ?? `${code}:${now}:${Object.keys(m.openLevel1).length}`] = { alert, lastSentAt: now };
    await this.sink.send(alert);
    return true;
  }

  /** Allow a key to fire again (e.g. a condition that cleared). */
  clearKey(key: string): void {
    delete this.meta().alertKeys[key];
  }

  /** Owner acknowledged a level-1 alert: stop the 24h repeats. */
  ack(key: string): void {
    delete this.meta().openLevel1[key];
  }

  async repeatDue(): Promise<void> {
    const now = this.clock();
    for (const entry of Object.values(this.meta().openLevel1)) {
      if (now - entry.lastSentAt >= REPEAT_LEVEL1_AFTER) {
        entry.lastSentAt = now;
        await this.sink.send({ ...entry.alert, at: now, repeat: true });
      }
    }
  }

  daily(entry: DailyEntry): void {
    const d = this.meta().daily;
    if (d.day === 0) d.day = Math.floor(this.clock() / DAY);
    if (d.entries.some((e) => e.id === entry.id && e.kind === entry.kind)) return;
    d.entries.push(entry);
  }

  async flushDaily(): Promise<void> {
    const d = this.meta().daily;
    const today = Math.floor(this.clock() / DAY);
    if (d.day === 0) {
      d.day = today;
      return;
    }
    if (today <= d.day) return;
    const counts: Record<string, number> = {};
    for (const e of d.entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    const report = { day: new Date(d.day * DAY * 1000).toISOString().slice(0, 10), counts, entries: d.entries };
    d.entries = [];
    d.day = today;
    await this.raise("DAILY_REPORT", { title: `日报 ${report.day}`, detail: report });
  }
}
