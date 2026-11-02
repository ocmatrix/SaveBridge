import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TelegramNotifier } from "@bridge/ops";
import { gatedHeartbeat, processAckInbox, resolveDeployConfig, TelegramChannel, MIN_TICK_SECONDS } from "../../src/deploy.js";
import type { AlertManager } from "../../src/alerts.js";
import type { MetaState } from "../../src/types.js";

const EXAMPLE = JSON.parse(readFileSync(resolve(__dirname, "../../../../deploy/watcher.config.example.json"), "utf8")) as Record<string, unknown>;
const clone = (): Record<string, any> => JSON.parse(JSON.stringify(EXAMPLE));
const ENV = {
  WANTOS_RPC3_LOCAL: "http://127.0.0.1:8545",
  WANTOS_RPC1_READONLY: "https://rpc.wantos.io",
  WANTOS_RPC2_READONLY: "https://rpc2.wantos.io",
  BSC_RPC_1: "https://bsc-a.example.com/k",
  BSC_RPC_2: "https://bsc-b.example.org",
  BSC_RPC_3: "https://bsc-c.example.net",
  PEER_BSC_RPC_HOSTS: "bsc.payout-provider-a.io,payout-provider-b.com",
};

describe("watcher deploy config", () => {
  it("the shipped template resolves: 3 independent WANTOS sources (rpc3 + rpc1 + rpc2), minAgree 2 kept", () => {
    const d = resolveDeployConfig(EXAMPLE, ENV);
    expect(d.core.minRpcAgreement).toBe(2);
    expect(d.core.chains.wantos.rpcUrls).toEqual(["http://127.0.0.1:8545", "https://rpc.wantos.io", "https://rpc2.wantos.io"]);
    expect(d.pauseWrite.wantos).toBe("http://127.0.0.1:8545");
    expect(d.runtime.tickIntervalSeconds).toBe(5);
    expect(d.runtime.pauser.kind).toBe("local-keystore");
    expect(d.warnings).toEqual([]);
    expect(JSON.stringify(EXAMPLE)).not.toMatch(/https?:\/\//);
  });

  it("refuses URLs in the file, rpcUrls in a deploy config and missing env", () => {
    const a = clone();
    a.chains.bsc.rpc = [{ env: "BSC_RPC_1" }];
    a.chains.bsc.note = "https://leak.example.com/key";
    expect(() => resolveDeployConfig(a, ENV)).toThrow(/URLs are not allowed/);
    const b = clone();
    b.chains.bsc.rpcUrls = ["x"];
    expect(() => resolveDeployConfig(b, ENV)).toThrow(/rpcUrls is not allowed/);
    expect(() => resolveDeployConfig(EXAMPLE, { ...ENV, BSC_RPC_2: undefined })).toThrow(/BSC_RPC_2 is not set/);
  });

  it("the PAUSER write endpoint may not be rpc1/rpc2", () => {
    const c = clone();
    c.runtime.pauseWriteRpcEnv.wantos = "WANTOS_RPC1_READONLY";
    expect(() => resolveDeployConfig(c, ENV)).toThrow(/read-only host/);
    expect(() => resolveDeployConfig(EXAMPLE, { ...ENV, BSC_RPC_1: "https://rpc2.wantos.io" })).toThrow(/read-only host|may not serve BSC/);
  });

  it("same node under two URLs is one source; too few → refuse, minAgree never lowered", () => {
    const c = clone();
    c.chains.wantos.rpc = [{ env: "WANTOS_RPC3_LOCAL", node: "rpc3" }, { env: "WANTOS_RPC3_PUBLIC", node: "rpc3" }];
    expect(() => resolveDeployConfig(c, { ...ENV, WANTOS_RPC3_PUBLIC: "https://rpc3.wantos.io" })).toThrow(/wantos: only 1 independent/);
    const d = clone();
    d.chains.wantos.rpc = [{ env: "WANTOS_RPC3_LOCAL", node: "rpc3" }, { env: "WANTOS_RPC1_READONLY" }];
    const r = resolveDeployConfig(d, ENV);
    expect(r.core.minRpcAgreement).toBe(2);
    expect(r.warnings.join()).toMatch(/design requires 3/);
    const e = clone();
    e.chains.wantos.rpc = [{ env: "WANTOS_RPC3_LOCAL" }, { env: "WANTOS_RPC1_READONLY" }];
    expect(() => resolveDeployConfig(e, ENV)).toThrow(/explicit node label/);
    const f = clone();
    f.minRpcAgreement = 1;
    expect(() => resolveDeployConfig(f, ENV)).toThrow(/minRpcAgreement must be ≥ 2/);
  });

  it("BSC providers must differ from the payout service's (fail-closed)", () => {
    expect(() => resolveDeployConfig(EXAMPLE, { ...ENV, PEER_BSC_RPC_HOSTS: "x.example.ORG" })).toThrow(/example\.org .*used by both/);
    expect(() => resolveDeployConfig(EXAMPLE, { ...ENV, PEER_BSC_RPC_HOSTS: undefined })).toThrow(/PEER_BSC_RPC_HOSTS is not set/);
    const c = clone();
    c.runtime.pauseWriteRpcEnv.bsc = "BSC_PAUSE";
    expect(() => resolveDeployConfig(c, { ...ENV, BSC_PAUSE: "https://p.payout-provider-b.com" })).toThrow(/payout-provider-b\.com/);
  });

  it("low-frequency rules: tick >= 5 s; getLogs window must fit the rpc1/rpc2 limit", () => {
    expect(MIN_TICK_SECONDS).toBe(5);
    const c = clone();
    c.runtime.tickIntervalSeconds = 2;
    expect(() => resolveDeployConfig(c, ENV)).toThrow(/tickIntervalSeconds/);
    const d = clone();
    d.chains.wantos.maxBlockRange = 2000;
    expect(() => resolveDeployConfig(d, ENV)).toThrow(/maxBlockRange/);
    const e = clone();
    e.runtime.externalRpc.maxRequestsPerMinute = 10_000;
    expect(() => resolveDeployConfig(e, ENV)).toThrow(/maxRequestsPerMinute/);
    const noDefaults = clone();
    delete noDefaults.runtime.tickIntervalSeconds;
    delete noDefaults.runtime.externalRpc;
    const r = resolveDeployConfig(noDefaults, ENV);
    expect(r.runtime.tickIntervalSeconds).toBe(5);
    expect(r.runtime.externalRpc).toEqual({ maxRequestsPerMinute: 120, burst: 20, maxLogsBlockRange: 200 });
  });

  it("runtime validation: pauser kinds, credentials, distinct keystores, telegram requirement, ackDir", () => {
    const set = (f: (c: Record<string, any>) => void) => {
      const c = clone();
      f(c);
      return () => resolveDeployConfig(c, ENV);
    };
    expect(set((c) => (c.runtime.pauser = { kind: "kms" }))()).toBeTruthy();
    expect(set((c) => (c.runtime.pauser = { kind: "none" }))().runtime.pauser.kind).toBe("none");
    expect(set((c) => (c.runtime.pauser = { kind: "hsm" }))).toThrow(/pauser.kind/);
    expect(set((c) => (c.runtime.pauser.wantos.keystorePath = c.runtime.pauser.bsc.keystorePath))).toThrow(/two keystores/);
    expect(set((c) => (c.runtime.pauser.bsc.keystorePath = "rel.json"))).toThrow(/absolute/);
    expect(set((c) => (c.runtime.pauser.bsc.address = "0x12"))).toThrow(/address/);
    expect(set((c) => (c.runtime.pauser.bsc.passphraseCredential = "a/b"))).toThrow(/credential name/);
    expect(set((c) => delete c.runtime.telegram)).toThrow(/requireTelegram/);
    expect(set((c) => (c.runtime.ackDir = "ack"))).toThrow(/ackDir/);
    expect(set((c) => (c.runtime.pauseWriteRpcEnv.bsc = "lower"))).toThrow(/environment variable name/);
    expect(set((c) => (c.chains.wantos.rpc[0].node = "bad label!"))).toThrow(/label/);
    expect(set((c) => (c.chains.wantos.rpc = "x"))).toThrow(/must be an array/);
    expect(set((c) => delete c.runtime.heartbeat)().runtime.heartbeat).toBeUndefined();
  });
});

describe("Telegram channel, gated heartbeat, ack inbox", () => {
  const TOKEN = "123456789:AAFakeTokenFakeTokenFakeTokenFakeTok";
  it("TelegramChannel maps watcher alerts and rethrows failures (AlertManager queues them)", async () => {
    const sent: string[] = [];
    let ok = true;
    const f = (async (_u: string, init: { body: string }) => {
      if (!ok) return new Response("{}", { status: 502 });
      sent.push(JSON.parse(init.body).text);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const ch = new TelegramChannel(new TelegramNotifier({ botToken: TOKEN, chatId: "-100123", fetch: f }));
    await ch.send({ level: 1, code: "AUTO_PAUSE", title: "已自动暂停 BSC", chain: "bsc", detail: {}, at: 1_700_000_000, key: "pause:1" });
    expect(sent[0]).toMatch(/一级告警[\s\S]*监控[\s\S]*AUTO_PAUSE[\s\S]*链：bsc[\s\S]*确认键：pause:1/);
    expect(sent[0]).toContain("2023-11-14 22:13:20");
    ok = false;
    await expect(ch.send({ level: 2, code: "GAS_LOW", title: "x", detail: {}, at: 1 })).rejects.toThrow(/HTTP 502/);
  });

  it("heartbeat is withheld only while a level-1 alert is stuck on the IM channel past the grace", async () => {
    let pings = 0;
    const meta = { outbox: [] as MetaState["outbox"] } as MetaState;
    let now = 10_000;
    const hb = gatedHeartbeat(async () => pings++, () => meta, 2, { nowSeconds: () => now, graceSeconds: 600 });
    const st = { at: 0, cursors: { bsc: null, wantos: null }, pendingChecks: 0 };
    await hb.beat(st);
    meta.outbox.push({ id: "a", channel: 2, alert: { level: 2, code: "GAS_LOW", title: "", detail: {}, at: 1 } });
    meta.outbox.push({ id: "b", channel: 1, alert: { level: 1, code: "AUTO_PAUSE", title: "", detail: {}, at: 1 } });
    await hb.beat(st);
    meta.outbox.push({ id: "c", channel: 2, alert: { level: 1, code: "AUTO_PAUSE", title: "", detail: {}, at: 9_500 } });
    await hb.beat(st);
    now = 10_101;
    await expect(hb.beat(st)).rejects.toThrow(/withheld/);
    expect(pings).toBe(3);
    await gatedHeartbeat(async () => pings++, () => undefined, undefined).beat(st);
    expect(pings).toBe(4);
  });

  const dir = mkdtempSync(join(tmpdir(), "sb-ack-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it("ack inbox applies known keys once, logs unknown ones, ignores symlinks / big files", () => {
    const acked: string[] = [];
    const mgr = { ack: (k: string) => acked.push(k) } as unknown as AlertManager;
    const logs: Array<Record<string, unknown>> = [];
    const ack = join(dir, "ack");
    mkdirSync(ack, { mode: 0o700 });
    writeFileSync(join(ack, "1.ack"), "pause:bsc:1\n");
    writeFileSync(join(ack, "2.ack"), "nope");
    writeFileSync(join(ack, "big.ack"), "x".repeat(600));
    writeFileSync(join(ack, "ignored.txt"), "pause:bsc:1");
    writeFileSync(join(dir, "target"), "pause:bsc:1");
    symlinkSync(join(dir, "target"), join(ack, "link.ack"));
    expect(processAckInbox(ack, mgr, () => ["pause:bsc:1"], (o) => logs.push(o))).toBe(1);
    expect(acked).toEqual(["pause:bsc:1"]);
    expect(existsSync(join(ack, "1.ack"))).toBe(false);
    expect(existsSync(join(ack, "2.ack"))).toBe(false);
    expect(existsSync(join(ack, "big.ack"))).toBe(true);
    expect(logs.map((l) => l.event).sort()).toEqual(["ack_applied", "ack_ignored", "ack_ignored", "ack_unknown_key"]);
    expect(processAckInbox(join(dir, "missing"), mgr, () => [], () => undefined)).toBe(0);
  });
});
