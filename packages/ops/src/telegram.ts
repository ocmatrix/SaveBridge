/**
 * Telegram alert transport (deploy-prep). Plain text only (no parse_mode → no markup injection),
 * dedup inside a window, a per-minute rate limit for level 2/3 (level 1 is never rate-limited),
 * redaction of every outgoing text and every error, and errors that never contain the bot token
 * (the request URL is never echoed). Callers decide what to do on failure:
 *   - relayer: local log + bounded retry outbox (TelegramAlertSink),
 *   - watcher: rethrow → AlertManager keeps a per-channel persisted outbox.
 */
import { redact } from "./redact.js";

export type Level = 1 | 2 | 3;

export interface TelegramMessage {
  level: Level;
  /** "付款程序" / "监控" — which service raised it. */
  service: string;
  code: string;
  title: string;
  chain?: string;
  /** Dedup / acknowledgement key (shown so the owner can ack level-1 alerts). */
  key?: string;
  detail?: Record<string, unknown>;
  at: Date;
  repeat?: boolean;
}

export type SendResult = "sent" | "deduped" | "rate-limited";

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

const MAX_LEN = 3800; // Telegram hard limit is 4096 characters

const HEAD: Record<Level, string> = {
  1: "【SaveBridge 一级告警】",
  2: "【SaveBridge 二级告警】",
  3: "【SaveBridge 日报/三级】",
};
const ACTION: Record<Level, string> = {
  1: "处置：请立即查看。可疑时用管理钱包或白名单钱包对受影响的链执行 pause()（防守动作可随时自行决定），再按应急手册排查。一级告警在确认（ack）前每 24 小时重复。",
  2: "处置：请尽快查看（不需要半夜处理的除外）；持续出现且原因不明时按一级处理。",
  3: "仅供知悉。",
};

const json = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export function formatTelegram(m: TelegramMessage, known: readonly string[] = []): string {
  const lines = [
    `${HEAD[m.level]}${m.repeat ? "（重复提醒）" : ""}${m.service}`,
    m.title,
    `代码：${m.code}${m.chain ? `　链：${m.chain}` : ""}`,
    `时间（UTC）：${m.at.toISOString().replace("T", " ").slice(0, 19)}`,
  ];
  if (m.key) lines.push(`确认键：${m.key}`);
  lines.push(ACTION[m.level]);
  if (m.detail && Object.keys(m.detail).length > 0) lines.push(`详情：${json(m.detail)}`);
  let text = redact(lines.join("\n"), known);
  if (text.length > MAX_LEN) text = `${text.slice(0, MAX_LEN)}…（已截断，完整内容见本机日志）`;
  return text;
}

export interface TelegramOptions {
  botToken: string;
  chatId: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Same level+code+key+title inside this window is sent once (default 10 min). */
  dedupWindowMs?: number;
  /** Level 2/3 messages per rolling minute (default 15). Level 1 always goes out. */
  maxPerMinute?: number;
  /** Local fallback log (one JSON line per event); never receives the token. */
  log?: (line: string) => void;
}

export class TelegramNotifier {
  private readonly sentAt: number[] = [];
  private readonly lastByKey = new Map<string, number>();
  private suppressed = 0;
  private readonly known: string[];

  constructor(private readonly o: TelegramOptions) {
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(o.botToken)) throw new Error("telegram: bot token has an invalid shape (value not shown)");
    if (!/^(-?\d{3,}|@[A-Za-z][A-Za-z0-9_]{4,})$/.test(o.chatId)) throw new Error("telegram: chat id has an invalid shape (value not shown)");
    this.known = [o.botToken, o.chatId];
  }

  /** Secrets this notifier knows; callers pass them to `redact()` for their own log lines. */
  get secrets(): readonly string[] {
    return this.known;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private log(event: string, extra: Record<string, unknown> = {}): void {
    (this.o.log ?? ((l: string) => process.stderr.write(`${l}\n`)))(redact(json({ event, ...extra }), this.known));
  }

  async send(m: TelegramMessage): Promise<SendResult> {
    const t = this.now();
    const dk = `${m.level}|${m.code}|${m.key ?? ""}|${m.title}|${m.repeat ? "r" : ""}`;
    const prev = this.lastByKey.get(dk);
    if (prev !== undefined && t - prev < (this.o.dedupWindowMs ?? 600_000)) return "deduped";
    while (this.sentAt.length > 0 && t - this.sentAt[0]! >= 60_000) this.sentAt.shift();
    if (m.level !== 1 && this.sentAt.length >= (this.o.maxPerMinute ?? 15)) {
      this.suppressed++;
      this.log("telegram_rate_limited", { code: m.code, level: m.level, title: m.title });
      return "rate-limited";
    }
    let text = formatTelegram(m, this.known);
    if (this.suppressed > 0) text += `\n（此前因限流有 ${this.suppressed} 条二/三级告警未推送，见本机日志）`;
    await this.post(text);
    this.suppressed = 0;
    this.sentAt.push(t);
    this.lastByKey.set(dk, t);
    if (this.lastByKey.size > 5000) for (const [k, v] of this.lastByKey) if (t - v > 3_600_000) this.lastByKey.delete(k);
    return "sent";
  }

  private async post(text: string): Promise<void> {
    const f = this.o.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`https://api.telegram.org/bot${this.o.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.o.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
    } catch (e) {
      throw new TelegramError(`telegram unreachable: ${redact(e instanceof Error ? e.message : String(e), this.known)}`);
    }
    if (res.ok) return;
    let retryAfter: number | undefined;
    let desc = "";
    try {
      const body = (await res.json()) as { description?: string; parameters?: { retry_after?: number } };
      retryAfter = body.parameters?.retry_after;
      desc = typeof body.description === "string" ? body.description.slice(0, 200) : "";
    } catch {
      /* non-JSON body */
    }
    throw new TelegramError(`telegram HTTP ${res.status}${desc ? `: ${redact(desc, this.known)}` : ""}`, retryAfter);
  }
}
