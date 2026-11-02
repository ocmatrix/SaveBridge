import { errText, type TelegramMessage, type TelegramNotifier } from "@bridge/ops";
import { ALERT_LEVEL, type AlertInput, type AlertSink } from "./alerts";

interface Queued {
  a: AlertInput;
  at: number;
}

/**
 * Relayer → Telegram (DESIGN §6.5 / §9.3 "付款程序自己发告警"). Dedup / rate limit / redaction are in
 * the notifier. When Telegram is unreachable the alert is (1) written to the local log line by the
 * LogAlertSink that always runs next to this sink, (2) logged as `telegram_unreachable`, and (3) kept
 * in a bounded in-memory outbox that `flush()` retries (one summary message when > 3 are queued).
 * `undeliveredLevel1Since()` lets main.ts stop the external heartbeat when a level-1 alert cannot get
 * out, so the dead-man switch phones the owner instead (degradation path).
 */
export class TelegramAlertSink implements AlertSink {
  private readonly outbox: Queued[] = [];
  private dropped = 0;

  constructor(
    private readonly n: TelegramNotifier,
    private readonly o: { log?: (line: string) => void; now?: () => number; service?: string; cap?: number } = {},
  ) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }
  private log(event: string, extra: Record<string, unknown>): void {
    (this.o.log ?? ((l: string) => process.stderr.write(`${l}\n`)))(JSON.stringify({ event, ...extra }));
  }

  private msg(a: AlertInput, at: number): TelegramMessage {
    return { level: ALERT_LEVEL[a.kind], service: this.o.service ?? "付款程序", code: a.kind, title: a.message, key: a.key, detail: a.data, at: new Date(at) };
  }

  async emit(a: AlertInput): Promise<void> {
    const at = this.now();
    await this.flush();
    if (this.outbox.length > 0) return this.enqueue({ a, at }); // keep order while the channel is down
    try {
      await this.n.send(this.msg(a, at));
    } catch (e) {
      this.log("telegram_unreachable", { kind: a.kind, error: errText(e, this.n.secrets) });
      this.enqueue({ a, at });
    }
  }

  private enqueue(q: Queued): void {
    this.outbox.push(q);
    const cap = this.o.cap ?? 200;
    while (this.outbox.length > cap) {
      // drop the oldest NON-level-1 item first; level 1 is dropped only if nothing else is left
      const i = this.outbox.findIndex((x) => ALERT_LEVEL[x.a.kind] !== 1);
      this.outbox.splice(i >= 0 ? i : 0, 1);
      this.dropped++;
    }
  }

  get pending(): number {
    return this.outbox.length;
  }

  /** Oldest undelivered level-1 alert time, or null. */
  undeliveredLevel1Since(): number | null {
    const l1 = this.outbox.filter((q) => ALERT_LEVEL[q.a.kind] === 1);
    return l1.length > 0 ? Math.min(...l1.map((q) => q.at)) : null;
  }

  async flush(): Promise<void> {
    if (this.outbox.length === 0) return;
    try {
      if (this.outbox.length > 3 || this.dropped > 0) {
        const level = Math.min(...this.outbox.map((q) => ALERT_LEVEL[q.a.kind])) as 1 | 2 | 3;
        await this.n.send({
          level,
          service: this.o.service ?? "付款程序",
          code: "ALERT_BACKLOG",
          title: `Telegram 恢复：补发积压告警 ${this.outbox.length} 条${this.dropped > 0 ? `（另有 ${this.dropped} 条因积压上限丢弃，见本机日志）` : ""}`,
          detail: { items: this.outbox.map((q) => ({ kind: q.a.kind, level: ALERT_LEVEL[q.a.kind], message: q.a.message, key: q.a.key, at: new Date(q.at).toISOString() })) },
          at: new Date(this.now()),
        });
        this.outbox.length = 0;
        this.dropped = 0;
        return;
      }
      while (this.outbox.length > 0) {
        const q = this.outbox[0]!;
        await this.n.send(this.msg(q.a, q.at));
        this.outbox.shift();
      }
    } catch (e) {
      this.log("telegram_unreachable", { pending: this.outbox.length, error: errText(e, this.n.secrets) });
    }
  }
}
