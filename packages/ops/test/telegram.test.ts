import { describe, expect, it } from "vitest";
import { formatTelegram, TelegramError, TelegramNotifier, type TelegramMessage } from "../src/telegram";
import { HttpHeartbeat } from "../src/heartbeat";
import { redact, errText } from "../src/redact";

const TOKEN = "123456789:AAFakeTokenFakeTokenFakeTokenFakeTok";
const CHAT = "-1001234567890";

function fakeFetch(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; body: { chat_id: string; text: string } }> = [];
  const f = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = responses.shift() ?? { status: 200, body: { ok: true } };
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const msg = (over: Partial<TelegramMessage> = {}): TelegramMessage => ({ level: 2, service: "付款程序", code: "GAS_LOW", title: "BSC 付款钥匙 gas 不足", at: new Date("2026-11-02T01:02:03Z"), ...over });

describe("TelegramNotifier", () => {
  it("rejects malformed token / chat id without echoing them", () => {
    const e1 = (() => {
      try {
        new TelegramNotifier({ botToken: "abc-secret-value", chatId: CHAT });
      } catch (e) {
        return String(e);
      }
    })();
    expect(e1).toMatch(/invalid shape/);
    expect(e1).not.toContain("abc-secret-value");
    expect(() => new TelegramNotifier({ botToken: TOKEN, chatId: "not a chat" })).toThrow(/chat id/);
  });

  it("sends plain text to the configured chat; level-1 and level-2 wording differ", async () => {
    const { f, calls } = fakeFetch([]);
    const n = new TelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetch: f });
    expect(await n.send(msg({ level: 1, code: "WANTOS_REORG", title: "WANTOS 回滚", key: "reorg:1" }))).toBe("sent");
    expect(await n.send(msg())).toBe("sent");
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(calls[0]!.body.chat_id).toBe(CHAT);
    expect(calls[0]!.body.text).toContain("【SaveBridge 一级告警】");
    expect(calls[0]!.body.text).toContain("确认键：reorg:1");
    expect(calls[0]!.body.text).toContain("pause()");
    expect(calls[1]!.body.text).toContain("【SaveBridge 二级告警】");
    expect(JSON.stringify(calls[1]!.body)).not.toContain("parse_mode");
  });

  it("redacts secrets in title/detail (RPC keys, 64-hex, its own token)", async () => {
    const { f, calls } = fakeFetch([]);
    const n = new TelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetch: f });
    await n.send(msg({ title: `rpc https://user:pw@bsc.example.com/v1/KEY123?apikey=zz failed ${"ab".repeat(32)} ${TOKEN}`, detail: { err: `Bearer abc.def`, k: "0x" + "cd".repeat(32) } }));
    const t = calls[0]!.body.text;
    expect(t).not.toContain("KEY123");
    expect(t).not.toContain("pw@");
    expect(t).not.toContain("ab".repeat(32));
    expect(t).not.toContain("cd".repeat(32));
    expect(t).not.toContain(TOKEN);
    expect(t).not.toContain("abc.def");
    expect(t).toContain("bsc.example.com");
  });

  it("dedups the same alert inside the window, sends again after it", async () => {
    let now = 0;
    const { f, calls } = fakeFetch([]);
    const n = new TelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetch: f, now: () => now, dedupWindowMs: 1000 });
    expect(await n.send(msg())).toBe("sent");
    now = 999;
    expect(await n.send(msg())).toBe("deduped");
    expect(await n.send(msg({ key: "other" }))).toBe("sent");
    now = 2000;
    expect(await n.send(msg())).toBe("sent");
    expect(calls).toHaveLength(3);
  });

  it("rate-limits level 2/3 per minute, never level 1, and reports the suppressed count", async () => {
    let now = 0;
    const lines: string[] = [];
    const { f, calls } = fakeFetch([]);
    const n = new TelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetch: f, now: () => now, maxPerMinute: 2, log: (l) => lines.push(l) });
    expect(await n.send(msg({ key: "a" }))).toBe("sent");
    expect(await n.send(msg({ key: "b" }))).toBe("sent");
    expect(await n.send(msg({ key: "c" }))).toBe("rate-limited");
    expect(await n.send(msg({ key: "d", level: 1 }))).toBe("sent");
    expect(calls[2]!.body.text).toContain("1 条");
    expect(lines.join("\n")).toContain("telegram_rate_limited");
    expect(lines.join("\n")).not.toContain(TOKEN);
    now = 61_000;
    expect(await n.send(msg({ key: "e" }))).toBe("sent");
  });

  it("failures throw a TelegramError without the token or URL; 429 carries retry_after; failed sends are not deduped", async () => {
    const { f } = fakeFetch([new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`), { status: 429, body: { description: "Too Many Requests", parameters: { retry_after: 7 } } }, { status: 500, body: "x" }, { status: 200 }]);
    const n = new TelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetch: f });
    const e1 = await n.send(msg()).catch((e) => e);
    expect(e1).toBeInstanceOf(TelegramError);
    expect(String(e1.message)).not.toContain(TOKEN);
    expect(String(e1.message)).toMatch(/unreachable/);
    const e2 = (await n.send(msg()).catch((e) => e)) as TelegramError;
    expect(e2.retryAfterSeconds).toBe(7);
    expect(e2.message).toMatch(/HTTP 429/);
    await expect(n.send(msg())).rejects.toThrow(/HTTP 500/);
    expect(await n.send(msg())).toBe("sent");
    expect(n.secrets).toEqual([TOKEN, CHAT]);
  });

  it("truncates very long messages and formats repeats / daily", () => {
    const long = formatTelegram(msg({ detail: { x: "y".repeat(10_000) } }));
    expect(long.length).toBeLessThan(4096);
    expect(long).toContain("已截断");
    expect(formatTelegram(msg({ level: 1, repeat: true }))).toContain("重复提醒");
    expect(formatTelegram(msg({ level: 3, chain: "bsc" }))).toMatch(/日报[\s\S]*链：bsc/);
    expect(formatTelegram(msg({ detail: { big: 5n } }))).toContain('"big":"5"');
  });
});

describe("HttpHeartbeat", () => {
  it("pings at most once per interval, needs https, never leaks the URL", async () => {
    let now = 0;
    const url = "https://hc-ping.example/uuid-secret-123";
    const seen: string[] = [];
    const f = (async (u: string) => {
      seen.push(u);
      return new Response("", { status: seen.length === 3 ? 500 : 200 });
    }) as unknown as typeof fetch;
    const h = new HttpHeartbeat({ url, minIntervalMs: 60_000, fetch: f, now: () => now });
    expect(await h.ping()).toBe(true);
    now = 30_000;
    expect(await h.ping()).toBe(false);
    now = 60_000;
    expect(await h.ping()).toBe(true);
    now = 120_000;
    await expect(h.ping()).rejects.toThrow(/HTTP 500/);
    expect(await h.ping()).toBe(true); // failure did not advance the throttle
    expect(() => new HttpHeartbeat({ url: "http://x", minIntervalMs: 1 })).toThrow(/https/);
    expect(() => new HttpHeartbeat({ url: "nope", minIntervalMs: 1 })).toThrow(/invalid/);
    const bad = new HttpHeartbeat({ url, minIntervalMs: 1, fetch: (async () => { throw new Error(`fetch failed ${url}`); }) as unknown as typeof fetch });
    const e = await bad.ping().catch((x) => String(x));
    expect(e).not.toContain("uuid-secret-123");
  });
});

describe("redact", () => {
  it("scrubs tokens, URLs, auth values, key=value secrets, 64-hex and registered values", () => {
    const t = redact(`bot${TOKEN} ${TOKEN} https://a:b@h.io:8545/p?q=1 authorization: Bearer xyz token=abc passphrase=hunter2 0x${"11".repeat(32)} my-own-secret`, ["my-own-secret"]);
    for (const s of [TOKEN, "a:b@", "/p?q", "xyz", "abc", "hunter2", "11".repeat(32), "my-own-secret"]) expect(t).not.toContain(s);
    expect(t).toContain("h.io:8545");
    expect(errText(new Error("one\ntwo"))).toBe("one");
    expect(errText("plain")).toBe("plain");
  });
});
