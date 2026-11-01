import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Address } from "viem";
import { bscVaultV2Abi } from "@bridge/abi";
import { MemoryAlertSink, MultiAlertSink } from "../../src/alerts.js";
import { parseConfig } from "../../src/config.js";
import { describeCall } from "../../src/events.js";
import { HttpHeartbeatDraft } from "../../src/heartbeat.js";
import { buildRpc } from "../../src/wiring.js";

const A = "0x1111111111111111111111111111111111111111" as Address;
const T = "0x2222222222222222222222222222222222222222" as Address;

describe("misc", () => {
  it("heartbeat draft builds a request and never sends", async () => {
    const h = new HttpHeartbeatDraft({ pingUrlRef: "env:HEARTBEAT_URL" });
    const r = h.buildRequest({ at: 1, cursors: { bsc: "1", wantos: null }, pendingChecks: 0 });
    expect(r.url).toBe("<env:HEARTBEAT_URL>");
    await expect(h.beat({ at: 1, cursors: { bsc: null, wantos: null }, pendingChecks: 0 })).rejects.toThrow(/draft/);
  });

  it("multi sink: one failing sink does not block the others; all failing throws", async () => {
    const ok = new MemoryAlertSink();
    const bad = { send: async () => Promise.reject(new Error("x")) };
    await new MultiAlertSink([bad, ok]).send({ level: 2, code: "PAUSED", title: "t", detail: {}, at: 1 });
    expect(ok.alerts).toHaveLength(1);
    await expect(new MultiAlertSink([bad]).send({ level: 2, code: "PAUSED", title: "t", detail: {}, at: 1 })).rejects.toThrow(/all alert sinks/);
  });

  it("describeCall decodes bridge calls and falls back to the selector for unknown targets / data", () => {
    const data = encodeFunctionData({ abi: bscVaultV2Abi, functionName: "withdraw", args: [A, 5n] });
    expect(describeCall(A, data, A, T, "bsc").fn).toBe("withdraw");
    expect(describeCall("0x3333333333333333333333333333333333333333", data, A, T, "bsc").fn).toBe(data.slice(0, 10));
    expect(describeCall(T, "0xdeadbeef", A, T, "bsc").fn).toBe("0xdeadbeef");
  });

  it("buildRpc creates one independent client per configured URL (no network I/O at construction)", () => {
    const cfg = parseConfig(JSON.parse(readFileSync(join(__dirname, "../../config/watcher.example.json"), "utf8")));
    const rpc = buildRpc(cfg);
    expect(rpc.bsc.endpoints).toHaveLength(3);
    expect(rpc.wantos.endpoints).toHaveLength(2);
    expect(rpc.bsc.minAgree).toBe(2);
  });
});
