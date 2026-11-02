import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TelegramNotifier } from "@bridge/ops";
import { EXAMPLE_CONFIG, parseConfig, keyRefs, type RelayerConfig } from "../src/config";
import { buildAlerts, gatedHeartbeat, resolveEndpoints } from "../src/bootstrap";
import { TelegramAlertSink } from "../src/telegramSink";

const clone = (): RelayerConfig => JSON.parse(JSON.stringify(EXAMPLE_CONFIG)) as RelayerConfig;
const TOKEN = "123456789:AAFakeTokenFakeTokenFakeTokenFakeTok";
const CHAT = "-1001234567890";

const deployCfg = (over: (c: RelayerConfig) => void = () => undefined): RelayerConfig => {
  const c = clone();
  c.wantos.primaryRpcUrlEnv = "WANTOS_RPC3";
  c.wantos.writeRpcUrlEnv = "WANTOS_RPC3";
  c.wantos.crossCheckRpcUrlEnvs = ["WANTOS_RPC1_READONLY", "WANTOS_RPC2_READONLY"];
  c.bsc.rpcUrlEnvs = ["BSC_RPC_1", "BSC_RPC_2", "BSC_RPC_3"];
  c.poll.intervalMs = 5000;
  c.rpcNodes = { WANTOS_RPC3: "rpc3" };
  over(c);
  return parseConfig(c);
};
const ENV = {
  WANTOS_RPC3: "https://rpc3.wantos.io",
  WANTOS_RPC1_READONLY: "https://rpc.wantos.io",
  WANTOS_RPC2_READONLY: "https://rpc2.wantos.io",
  BSC_RPC_1: "https://bsc-a.example.com/key1",
  BSC_RPC_2: "https://bsc-b.example.org",
  BSC_RPC_3: "https://bsc-c.example.net",
};

describe("endpoint policy (read/write split, independence, rpc1/rpc2 read-only)", () => {
  it("accepts rpc3 primary+write with rpc1/rpc2 as read-only cross-checks (3 WANTOS sources)", () => {
    const ep = resolveEndpoints(deployCfg(), ENV);
    expect(ep.wantos.write.url).toBe("https://rpc3.wantos.io");
    expect(ep.wantos.cross.map((c) => c.url)).toEqual(["https://rpc.wantos.io", "https://rpc2.wantos.io"]);
    expect(ep.bsc.write.label).toBe("BSC_RPC_1");
    expect(ep.usesExternalReadOnly).toBe(true);
    expect(ep.warnings).toEqual([]);
  });

  it("refuses a write endpoint on rpc1 / rpc2", () => {
    expect(() => resolveEndpoints(deployCfg((c) => (c.wantos.writeRpcUrlEnv = "WANTOS_RPC1_READONLY")), ENV)).toThrow(/read-only host/);
    expect(() => resolveEndpoints(deployCfg((c) => (c.wantos.writeRpcUrlEnv = "X_W")), { ...ENV, X_W: "https://RPC2.wantos.io:443/" })).toThrow(/read-only host/);
    expect(() => resolveEndpoints(deployCfg((c) => (c.bsc.writeRpcUrlEnv = "X_W")), { ...ENV, X_W: "https://rpc.wantos.io" })).toThrow(/read-only host/);
  });

  it("the default write endpoint is the primary, and rpc1/rpc2 can never be the primary nor a BSC source", () => {
    const c = deployCfg((x) => delete x.wantos.writeRpcUrlEnv);
    expect(resolveEndpoints(c, ENV).wantos.write.label).toBe("WANTOS_RPC3");
    expect(() => resolveEndpoints(c, { ...ENV, WANTOS_RPC3: "https://rpc2.wantos.io" })).toThrow(/read-only host/);
    const split = deployCfg((x) => (x.wantos.writeRpcUrlEnv = "W_WRITE"));
    expect(() => resolveEndpoints(split, { ...ENV, W_WRITE: "https://rpc3.wantos.io", WANTOS_RPC3: "https://rpc2.wantos.io" })).toThrow(/primary/);
    expect(() => resolveEndpoints(c, { ...ENV, BSC_RPC_2: "https://rpc.wantos.io" })).toThrow(/may not serve BSC/);
  });

  it("same node under two URLs is ONE source: rpc3 + rpc3-by-IP (labelled) is refused, never downgraded", () => {
    const c = deployCfg((x) => {
      x.wantos.crossCheckRpcUrlEnvs = ["WANTOS_RPC3_IP"];
      x.rpcNodes = { WANTOS_RPC3: "rpc3", WANTOS_RPC3_IP: "rpc3" };
    });
    expect(() => resolveEndpoints(c, { ...ENV, WANTOS_RPC3_IP: "http://43.128.14.237:8545" })).toThrow(/only 1 independent/);
    const sameHost = deployCfg((x) => (x.wantos.crossCheckRpcUrlEnvs = ["WANTOS_RPC3_ALT"]));
    expect(() => resolveEndpoints(sameHost, { ...ENV, WANTOS_RPC3_ALT: "https://rpc3.wantos.io:8443/other" })).toThrow(/only 1 independent/);
    expect(() => resolveEndpoints(deployCfg(), { ...ENV, BSC_RPC_2: "https://bsc-a.example.com/key2", BSC_RPC_3: "https://BSC-A.example.com/" })).toThrow(/bsc: only 1/);
  });

  it("warns (does not fail) when a chain has fewer than the design's 3 sources or duplicates", () => {
    const ep = resolveEndpoints(deployCfg((x) => (x.wantos.crossCheckRpcUrlEnvs = ["WANTOS_RPC1_READONLY"])), ENV);
    expect(ep.warnings.join()).toMatch(/wantos: 2 independent RPC sources, design requires 3/);
  });

  it("requires a poll interval >= 5 s when rpc1/rpc2 are used; missing env refuses", () => {
    expect(() => resolveEndpoints(deployCfg((x) => (x.poll.intervalMs = 3000)), ENV)).toThrow(/>= 5000/);
    const noExt = deployCfg((x) => {
      x.poll.intervalMs = 3000;
      x.wantos.crossCheckRpcUrlEnvs = ["W_OTHER"];
    });
    expect(resolveEndpoints(noExt, { ...ENV, W_OTHER: "https://wantos-node-b.example.com" }).usesExternalReadOnly).toBe(false);
    expect(() => resolveEndpoints(deployCfg(), { ...ENV, BSC_RPC_3: undefined })).toThrow(/BSC_RPC_3 is not set/);
  });
});

describe("config additions", () => {
  it("api must listen on loopback only", () => {
    expect(() => deployCfg((c) => (c.api.host = "0.0.0.0"))).toThrow(/loopback/);
    expect(deployCfg((c) => (c.api.host = "::1")).api.host).toBe("::1");
  });

  it("keystore refs: absolute paths, credential names, valid and distinct addresses / paths", () => {
    const ks = (p: string, a: string) => ({ keystorePath: p, passphraseCredential: "pass-x", address: a as `0x${string}` });
    const A = "0x0000000000000000000000000000000000000A01", B = "0x0000000000000000000000000000000000000A02", C = "0x0000000000000000000000000000000000000A03";
    const local = (w: object, b: object, s: object) => (c: RelayerConfig) => {
      c.signer = { kind: "local-keystore", wantos: w, bsc: b } as never;
      c.submitter = { kind: "local-keystore", ...s } as never;
    };
    const ok = deployCfg(local(ks("/k/w.json", A), ks("/k/b.json", B), ks("/k/s.json", C)));
    expect(keyRefs(ok).submitter).toMatchObject({ kind: "local-keystore", keystorePath: "/k/s.json" });
    expect(() => deployCfg(local(ks("k/w.json", A), ks("/k/b.json", B), ks("/k/s.json", C)))).toThrow(/absolute path/);
    expect(() => deployCfg(local(ks("/k/../w.json", A), ks("/k/b.json", B), ks("/k/s.json", C)))).toThrow(/absolute path/);
    expect(() => deployCfg(local(ks("/k/w.json", A), ks("/k/b.json", B), ks("/k/s.json", A)))).toThrow(/three different addresses/);
    expect(() => deployCfg(local(ks("/k/w.json", A), ks("/k/w.json", B), ks("/k/s.json", C)))).toThrow(/paths must be distinct/);
    expect(() => deployCfg(local({ ...ks("/k/w.json", A), passphraseCredential: "../x" }, ks("/k/b.json", B), ks("/k/s.json", C)))).toThrow(/credential name/);
    expect(() => deployCfg(local(ks("/k/w.json", "0x12"), ks("/k/b.json", B), ks("/k/s.json", C)))).toThrow(/valid address/);
    expect(() => deployCfg((c) => ((c.signer as { kind: string }).kind = "hsm"))).toThrow(/signer.kind/);
    expect(() => deployCfg((c) => ((c.submitter as { kind: string }).kind = "hsm"))).toThrow(/submitter.kind/);
    // a raw private key in the config is still rejected by the existing scan
    expect(() => deployCfg((c) => ((c as unknown as Record<string, unknown>).extra = "0x" + "11".repeat(32)))).toThrow(/key material/);
  });

  it("alerts / heartbeat / external limits validation", () => {
    expect(() => deployCfg((c) => (c.alerts = { requireTelegram: true }))).toThrow(/requireTelegram/);
    expect(() => deployCfg((c) => (c.alerts = { telegram: { botTokenCredential: "bad name", chatIdCredential: "x" } }))).toThrow(/credential name/);
    expect(() => deployCfg((c) => (c.alerts = { logFile: "rel.log" }))).toThrow(/absolute/);
    expect(() => deployCfg((c) => (c.heartbeat.urlCredential = "a/b"))).toThrow(/credential name/);
    expect(() => deployCfg((c) => (c.externalRpc = { maxRequestsPerMinute: 10_000, burst: 1, maxLogsBlockRange: 10 }))).toThrow(/externalRpc/);
    expect(() => deployCfg((c) => (c.rpcNodes = { WANTOS_RPC3: "bad label!" }))).toThrow(/node label/);
    expect(() => deployCfg((c) => (c.wantos.writeRpcUrlEnv = "https://x"))).toThrow();
    expect(() => deployCfg((c) => (c.poll.intervalMs = 10))).toThrow(/intervalMs/);
  });
});

describe("alert wiring", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-alerts-"));
  const cd = join(dir, "creds");
  mkdirSync(cd, { mode: 0o700 });
  writeFileSync(join(cd, "tg-token"), `${TOKEN}\n`, { mode: 0o400 });
  writeFileSync(join(cd, "tg-chat"), CHAT, { mode: 0o400 });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("stderr + file + Telegram; Telegram failure degrades to local logs without the token", async () => {
    const lines: string[] = [];
    const file: string[] = [];
    let up = false;
    const sent: string[] = [];
    const fakeFetch = (async (_u: string, init: { body: string }) => {
      if (!up) throw new Error(`getaddrinfo ENOTFOUND api.telegram.org/bot${TOKEN}`);
      sent.push(JSON.parse(init.body).text);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = deployCfg((c) => (c.alerts = { telegram: { botTokenCredential: "tg-token", chatIdCredential: "tg-chat" }, requireTelegram: true, logFile: "/var/log/savebridge/alerts.jsonl" }));
    const w = buildAlerts(cfg, { env: { CREDENTIALS_DIRECTORY: cd }, fetch: fakeFetch, stderr: (l) => lines.push(l), append: (_p, l) => file.push(l) });
    await w.sink.emit({ kind: "WANTOS_REORG", message: "WANTOS 回滚", key: "r1" });
    expect(file).toHaveLength(1);
    expect(lines.some((l) => l.includes("telegram_unreachable"))).toBe(true);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(w.telegram!.pending).toBe(1);
    expect(w.secrets).toContain(TOKEN);
    up = true;
    await w.telegram!.flush();
    expect(sent[0]).toContain("【SaveBridge 一级告警】付款程序");
    expect(w.telegram!.pending).toBe(0);
  });

  it("requires Telegram credentials when configured", () => {
    const cfg = deployCfg((c) => (c.alerts = { telegram: { botTokenCredential: "tg-missing", chatIdCredential: "tg-chat" } }));
    expect(() => buildAlerts(cfg, { env: { CREDENTIALS_DIRECTORY: cd } })).toThrow(/cannot stat/);
    const plain = buildAlerts(deployCfg(), { stderr: () => undefined });
    expect(plain.telegram).toBeUndefined();
  });
});

describe("TelegramAlertSink degradation", () => {
  const mk = (fail: () => boolean) => {
    const sent: string[] = [];
    const fakeFetch = (async (_u: string, init: { body: string }) => {
      if (fail()) return new Response('{"description":"Bad Gateway"}', { status: 502 });
      sent.push(JSON.parse(init.body).text);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return { sent, n: new TelegramNotifier({ botToken: TOKEN, chatId: CHAT, fetch: fakeFetch, maxPerMinute: 1000 }) };
  };

  it("keeps order while down, sends a single backlog summary (>3) on recovery", async () => {
    let down = true;
    const { sent, n } = mk(() => down);
    let now = 1000;
    const logs: string[] = [];
    const s = new TelegramAlertSink(n, { now: () => now, log: (l) => logs.push(l) });
    for (const k of ["a", "b", "c", "d"]) await s.emit({ kind: "GAS_LOW", message: `gas ${k}`, key: k });
    await s.emit({ kind: "PAYOUT_ALREADY_RELEASED", message: "dup", key: "e" });
    expect(s.pending).toBe(5);
    expect(s.undeliveredLevel1Since()).toBe(1000);
    down = false;
    now = 2000;
    await s.emit({ kind: "GAS_LOW", message: "gas f", key: "f" });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("补发积压告警 5 条");
    expect(sent[0]).toContain("一级"); // summary carries the most severe level
    expect(sent[1]).toContain("gas f");
    expect(s.pending).toBe(0);
    expect(s.undeliveredLevel1Since()).toBeNull();
  });

  it("flushes a small backlog item by item; caps the outbox dropping level-2 before level-1", async () => {
    let down = true;
    const { sent, n } = mk(() => down);
    const s = new TelegramAlertSink(n, { cap: 2, log: () => undefined });
    await s.emit({ kind: "WANTOS_REORG", message: "l1", key: "1" });
    await s.emit({ kind: "GAS_LOW", message: "l2a", key: "2" });
    await s.emit({ kind: "GAS_LOW", message: "l2b", key: "3" });
    expect(s.pending).toBe(2);
    down = false;
    await s.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("因积压上限丢弃");
    expect(sent[0]).toContain("l1");
    expect(sent[0]).toContain("l2b");
    expect(sent[0]).not.toContain("l2a");

    down = true;
    const s2 = new TelegramAlertSink(n, { log: () => undefined });
    await s2.emit({ kind: "GAS_LOW", message: "x1", key: "x1" });
    await s2.emit({ kind: "GAS_LOW", message: "x2", key: "x2" });
    down = false;
    await s2.flush();
    expect(sent.slice(1).map((t) => t.split("\n")[1])).toEqual(["x1", "x2"]);
    await s2.flush(); // empty: no-op
  });

  it("gated heartbeat goes silent while a level-1 alert is stuck past the grace period", async () => {
    const down = true;
    const { n } = mk(() => down);
    let now = 0;
    const s = new TelegramAlertSink(n, { now: () => now, log: () => undefined });
    let pings = 0;
    const hb = gatedHeartbeat(async () => pings++, s, { now: () => now, l1GraceMs: 1000 });
    await hb.ping({ at: new Date() });
    await s.emit({ kind: "WANTOS_REORG", message: "l1" });
    now = 500;
    await hb.ping({ at: new Date() });
    now = 1500;
    await expect(hb.ping({ at: new Date() })).rejects.toThrow(/withheld/);
    expect(pings).toBe(2);
    const plain = gatedHeartbeat(async () => pings++, undefined);
    await plain.ping({ at: new Date() });
    expect(pings).toBe(3);
  });
});

describe("shipped template deploy/relayer.config.example.json", () => {
  it("parses, holds no URLs / secrets, and resolves to rpc3 write + rpc1/rpc2 read-only cross-checks", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const text = readFileSync(resolve(__dirname, "../../../deploy/relayer.config.example.json"), "utf8");
    const raw = JSON.parse(text) as RelayerConfig;
    const cfg = parseConfig(raw);
    expect(text.replace(/"https:\/\/bridge\.wanto\.pro"/, "")).not.toMatch(/:\/\//);
    expect(text).not.toMatch(/[0-9a-fA-F]{64}/);
    expect(cfg.signer.kind).toBe("local-keystore");
    expect(cfg.api.host).toBe("127.0.0.1");
    const ep = resolveEndpoints(cfg, ENV);
    expect(ep.wantos.write.url).toBe("https://rpc3.wantos.io");
    expect(ep.warnings).toEqual([]);
    expect(cfg.poll.intervalMs).toBeGreaterThanOrEqual(5000);
  });
});
