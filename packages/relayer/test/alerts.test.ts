import { describe, expect, it, vi } from "vitest";
import { MemoryAlertSink, LogAlertSink, FanoutAlertSink, DedupAlertSink, ALERT_LEVEL } from "../src/alerts";

describe("alert outputs (DESIGN §9.3 relayer-own alerts)", () => {
  it("memory sink records alerts with §9.3 levels", async () => {
    const m = new MemoryAlertSink();
    await m.emit({ kind: "WANTOS_REORG", message: "hash changed" });
    await m.emit({ kind: "BSC_FINALIZED_UNAVAILABLE", message: "x" });
    expect(m.alerts.map((a) => a.level)).toEqual([1, 2]);
    expect(m.byKind("WANTOS_REORG")).toHaveLength(1);
    expect(ALERT_LEVEL.HEARTBEAT_MISSED).toBe(1);
  });
  it("log sink writes one JSON line", async () => {
    const lines: string[] = [];
    const s = new LogAlertSink((l) => lines.push(l));
    await s.emit({ kind: "GAS_LOW", message: "low", data: { wei: 1n } });
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "GAS_LOW", level: 2, data: { wei: "1" } });
  });
  it("fanout continues when one sink throws", async () => {
    const m = new MemoryAlertSink();
    const bad = { emit: vi.fn().mockRejectedValue(new Error("down")) };
    await new FanoutAlertSink([bad, m]).emit({ kind: "KMS_FAILURE", message: "x" });
    expect(m.alerts).toHaveLength(1);
  });
  it("dedup suppresses identical keys within the window", async () => {
    const m = new MemoryAlertSink();
    let now = 0;
    const d = new DedupAlertSink(m, 60_000, () => now);
    await d.emit({ kind: "RPC_UNAVAILABLE", message: "a", key: "k" });
    await d.emit({ kind: "RPC_UNAVAILABLE", message: "a", key: "k" });
    now = 61_000;
    await d.emit({ kind: "RPC_UNAVAILABLE", message: "a", key: "k" });
    expect(m.alerts).toHaveLength(2);
  });
});
