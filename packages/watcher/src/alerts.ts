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
  CHECK_OVERDUE: 1,
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
  ALERT_BACKLOG: 2, // level is overridden with the most severe queued item
  CLOCK_SKEW: 2,
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

const DAY = 86_400;
const REPEAT_LEVEL1_AFTER = DAY;

const OUTBOX_CAP_PER_CHANNEL = 500;
const MERGE_ABOVE = 3;

/**
 * Channels are independent (log, IM, phone …). Each failed (alert, channel) pair is queued in a
 * persisted outbox and retried for THAT channel only (A-3) — a healthy log channel never hides a dead
 * phone channel, and a dead phone channel never causes the log channel to repeat. A level-1 alert is
 * registered for 24h repeats once every channel has delivered it.
 */
export class AlertManager {
  private readonly channels: AlertSink[];
  constructor(
    channels: AlertSink | AlertSink[],
    private readonly meta: () => MetaState,
    private readonly clock: Clock,
  ) {
    this.channels = Array.isArray(channels) ? channels : [channels];
  }

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
    await this.dispatch(alert);
    return true;
  }

  private async dispatch(alert: Alert): Promise<void> {
    const m = this.meta();
    const id = `${alert.at}:${alert.code}:${Math.random().toString(36).slice(2, 10)}`;
    const results = await Promise.allSettled(this.channels.map((c) => c.send(alert)));
    let failed = false;
    results.forEach((r, channel) => {
      if (r.status === "rejected") {
        failed = true;
        this.enqueue(channel, { id, channel, alert });
      }
    });
    if (!failed) this.delivered(alert);
    else if (alert.level === 1 && !alert.repeat) m.pendingLevel1[id] = alert;
  }

  private enqueue(channel: number, e: { id: string; channel: number; alert: Alert }): void {
    const m = this.meta();
    m.outbox.push(e);
    const mine = m.outbox.filter((x) => x.channel === channel);
    if (mine.length > OUTBOX_CAP_PER_CHANNEL) {
      const drop = mine[0]!; // oldest first (B3 cap)
      m.outbox.splice(m.outbox.indexOf(drop), 1);
      m.outboxDropped[String(channel)] = (m.outboxDropped[String(channel)] ?? 0) + 1;
      this.settle(drop.id);
    }
  }

  /** An alert id with nothing left in the outbox is fully delivered → register level-1 repeats. */
  private settle(id: string): void {
    const m = this.meta();
    if (m.outbox.some((e) => e.id === id)) return;
    const a = m.pendingLevel1[id];
    if (a) {
      delete m.pendingLevel1[id];
      this.delivered(a);
    }
  }

  private delivered(alert: Alert): void {
    if (alert.level !== 1 || alert.repeat) return;
    const m = this.meta();
    m.openLevel1[alert.key ?? `${alert.code}:${alert.at}:${Object.keys(m.openLevel1).length}`] = { alert, lastSentAt: this.clock() };
  }

  /**
   * Retry queued alerts per channel. A backlog of more than 3 items is sent as ONE summary (B3: no
   * phone-call storm when a channel recovers); a failure keeps everything queued for the next tick.
   */
  async flushOutbox(): Promise<void> {
    const m = this.meta();
    for (let channel = 0; channel < this.channels.length; channel++) {
      const sink = this.channels[channel]!;
      const mine = m.outbox.filter((e) => e.channel === channel);
      if (mine.length === 0) continue;
      const dropped = m.outboxDropped[String(channel)] ?? 0;
      if (mine.length > MERGE_ABOVE || dropped > 0) {
        const level = Math.min(...mine.map((e) => e.alert.level)) as Alert["level"];
        const summary: Alert = {
          level,
          code: "ALERT_BACKLOG",
          title: `通道恢复：补发积压告警 ${mine.length} 条${dropped > 0 ? `（另有 ${dropped} 条因积压上限被丢弃）` : ""}`,
          detail: { items: mine.map((e) => ({ code: e.alert.code, level: e.alert.level, title: e.alert.title, at: e.alert.at, chain: e.alert.chain, key: e.alert.key, repeat: e.alert.repeat })), dropped },
          at: this.clock(),
        };
        try {
          await sink.send(summary);
        } catch {
          continue;
        }
        m.outbox = m.outbox.filter((e) => e.channel !== channel);
        delete m.outboxDropped[String(channel)];
        for (const e of mine) this.settle(e.id);
        continue;
      }
      for (const e of mine) {
        try {
          await sink.send(e.alert);
        } catch {
          break; // keep it (and the rest) queued
        }
        m.outbox.splice(m.outbox.indexOf(e), 1);
        this.settle(e.id);
      }
    }
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
        entry.lastSentAt = now; // failures are queued per channel by dispatch(), nothing is lost
        await this.dispatch({ ...entry.alert, at: now, repeat: true });
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
