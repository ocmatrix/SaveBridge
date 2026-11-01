import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AlertManager, ALERT_LEVELS, LogAlertSink, MemoryAlertSink } from "../../src/alerts.js";
import { FileStateStore, MemoryStateStore, initialState } from "../../src/state.js";

describe("state store", () => {
  it("file store round-trips and survives restart (atomic write)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watcher-state-"));
    const path = join(dir, "state.json");
    const a = new FileStateStore(path);
    const s = await a.load();
    expect(s).toEqual(initialState());
    s.derived.mintTotal = "123";
    s.meta.decided["x"] = 1;
    await a.save(s);
    const b = new FileStateStore(path);
    const t = await b.load();
    expect(t.derived.mintTotal).toBe("123");
    expect(t.meta.decided["x"]).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });

  it("file store persists bigints nested in alert details as decimal strings (regression)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watcher-state-"));
    const path = join(dir, "state.json");
    const st = new FileStateStore(path);
    const s = await st.load();
    s.meta.openLevel1["k"] = { alert: { level: 1, code: "KEY_CHANGE", title: "t", detail: { args: { amount: 5n } }, at: 1 }, lastSentAt: 1 };
    await st.save(s);
    const back = await new FileStateStore(path).load();
    expect(back.meta.openLevel1["k"]!.alert.detail).toEqual({ args: { amount: "5" } });
  });

  it("B8: file store keeps the previous version as .bak and falls back to it if the main file is corrupt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watcher-state-"));
    const path = join(dir, "state.json");
    const st = new FileStateStore(path);
    const s = await st.load();
    s.derived.mintTotal = "1";
    await st.save(s);
    s.derived.mintTotal = "2";
    await st.save(s);
    expect(JSON.parse(readFileSync(`${path}.bak`, "utf8")).derived.mintTotal).toBe("1");
    writeFileSync(path, "{ torn write");
    expect((await new FileStateStore(path).load()).derived.mintTotal).toBe("1");
  });

  it("file store refuses a state file of an unknown version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watcher-state-"));
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({ version: 99 }));
    await expect(new FileStateStore(path).load()).rejects.toThrow(/version/);
  });

  it("memory store returns deep copies", async () => {
    const m = new MemoryStateStore();
    const s = await m.load();
    s.derived.mintTotal = "5";
    expect((await m.load()).derived.mintTotal).toBe("0");
    await m.save(s);
    expect((await m.load()).derived.mintTotal).toBe("5");
  });
});

describe("alerts", () => {
  const mk = () => {
    const state = initialState();
    const sink = new MemoryAlertSink();
    let now = 1_000_000;
    const am = new AlertManager(sink, () => state.meta, () => now);
    return { state, sink, am, setNow: (t: number) => (now = t) };
  };

  it("levels follow DESIGN §9.3", () => {
    expect(ALERT_LEVELS.AUTO_PAUSE).toBe(1);
    expect(ALERT_LEVELS.TIMELOCK_PROPOSED).toBe(1);
    expect(ALERT_LEVELS.KEY_CHANGE).toBe(1);
    expect(ALERT_LEVELS.RESERVE_CRITICAL).toBe(1);
    expect(ALERT_LEVELS.RELAYER_UNREACHABLE).toBe(1);
    expect(ALERT_LEVELS.WANTOS_REORG).toBe(1);
    expect(ALERT_LEVELS.MINT_EXCESS).toBe(1);
    expect(ALERT_LEVELS.PAUSED).toBe(2);
    expect(ALERT_LEVELS.UNPAUSED).toBe(2);
    expect(ALERT_LEVELS.PAUSER_REVOKED).toBe(2);
    expect(ALERT_LEVELS.UPGRADE_EXECUTED).toBe(2);
    expect(ALERT_LEVELS.MINT).toBe(2);
    expect(ALERT_LEVELS.GAS_LOW).toBe(2);
    expect(ALERT_LEVELS.LEGACY_ACTIVITY).toBe(2);
    expect(ALERT_LEVELS.DAILY_REPORT).toBe(3);
  });

  it("dedupes by key and repeats level-1 alerts after 24h until acked", async () => {
    const { sink, am, setNow } = mk();
    expect(await am.raise("AUTO_PAUSE", { title: "x", key: "k1", chain: "bsc" })).toBe(true);
    expect(await am.raise("AUTO_PAUSE", { title: "x", key: "k1", chain: "bsc" })).toBe(false);
    expect(sink.alerts).toHaveLength(1);
    expect(sink.alerts[0]!.level).toBe(1);
    setNow(1_000_000 + 86_399);
    await am.repeatDue();
    expect(sink.alerts).toHaveLength(1);
    setNow(1_000_000 + 86_400);
    await am.repeatDue();
    expect(sink.alerts).toHaveLength(2);
    expect(sink.alerts[1]!.repeat).toBe(true);
    am.ack("k1");
    setNow(1_000_000 + 3 * 86_400);
    await am.repeatDue();
    expect(sink.alerts).toHaveLength(2);
  });

  it("B2: a failed send is queued (not lost), retried by flushOutbox; level-1 is registered for repeats only once delivered", async () => {
    const { state, sink, am } = mk();
    let fail = 1;
    const orig = sink.send.bind(sink);
    sink.send = async (a) => {
      if (fail-- > 0) throw new Error("channel down");
      return orig(a);
    };
    expect(await am.raise("AUTO_PAUSE", { title: "x", key: "kq" })).toBe(true);
    expect(sink.alerts).toHaveLength(0);
    expect(state.meta.outbox).toHaveLength(1);
    expect(state.meta.openLevel1["kq"]).toBeUndefined();
    expect(await am.raise("AUTO_PAUSE", { title: "x", key: "kq" })).toBe(false); // not queued twice
    await am.flushOutbox();
    expect(sink.alerts.map((a) => a.code)).toEqual(["AUTO_PAUSE"]);
    expect(state.meta.outbox).toHaveLength(0);
    expect(state.meta.openLevel1["kq"]).toBeDefined();
  });

  describe("A-3: per-channel outbox (log channel ok, phone channel down)", () => {
    class Flaky extends MemoryAlertSink {
      down = 0;
      override async send(a: Parameters<MemoryAlertSink["send"]>[0]): Promise<void> {
        if (this.down > 0) {
          this.down--;
          throw new Error("phone gateway down");
        }
        return super.send(a);
      }
    }
    const mk2 = () => {
      const state = initialState();
      const log = new MemoryAlertSink();
      const phone = new Flaky();
      let now = 1_000_000;
      const am = new AlertManager([log, phone], () => state.meta, () => now);
      return { state, log, phone, am, setNow: (t: number) => (now = t) };
    };

    it("only the failed channel is queued and retried; level-1 repeats are registered once every channel delivered", async () => {
      const { state, log, phone, am } = mk2();
      phone.down = 1;
      await am.raise("AUTO_PAUSE", { title: "x", key: "k" });
      expect(log.alerts).toHaveLength(1);
      expect(phone.alerts).toHaveLength(0);
      expect(state.meta.outbox.map((e) => e.channel)).toEqual([1]);
      expect(state.meta.openLevel1["k"]).toBeUndefined();
      await am.flushOutbox();
      expect(log.alerts).toHaveLength(1); // not re-sent to the healthy channel
      expect(phone.alerts.map((a) => a.code)).toEqual(["AUTO_PAUSE"]);
      expect(state.meta.outbox).toHaveLength(0);
      expect(state.meta.openLevel1["k"]).toBeDefined();
    });

    it("R33: a failed re-send keeps the item queued", async () => {
      const { state, phone, am } = mk2();
      phone.down = 2;
      await am.raise("AUTO_PAUSE", { title: "x", key: "k" });
      await am.flushOutbox();
      expect(state.meta.outbox).toHaveLength(1);
      await am.flushOutbox();
      expect(phone.alerts).toHaveLength(1);
    });

    it("R32: a 24h repeat that fails on the phone channel is queued, not lost", async () => {
      const { state, phone, am, setNow } = mk2();
      await am.raise("AUTO_PAUSE", { title: "x", key: "k" });
      phone.down = 1;
      setNow(1_000_000 + 86_400);
      await am.repeatDue();
      expect(state.meta.outbox).toHaveLength(1);
      await am.flushOutbox();
      expect(phone.alerts.filter((a) => a.repeat)).toHaveLength(1);
    });

    it("B3: a backlog is re-sent as ONE summary per channel (no call storm) and the queue is capped", async () => {
      const { state, log, phone, am } = mk2();
      phone.down = 1000;
      for (let i = 0; i < 6; i++) await am.raise("AUTO_PAUSE", { title: `x${i}`, key: `k${i}` });
      await am.raise("PAUSED", { title: "p" });
      expect(state.meta.outbox).toHaveLength(7);
      phone.down = 0;
      await am.flushOutbox();
      expect(phone.alerts).toHaveLength(1);
      expect(phone.alerts[0]!.code).toBe("ALERT_BACKLOG");
      expect(phone.alerts[0]!.level).toBe(1);
      expect((phone.alerts[0]!.detail["items"] as unknown[]).length).toBe(7);
      expect(log.alerts).toHaveLength(7);
      expect(Object.keys(state.meta.openLevel1)).toHaveLength(6);
      phone.down = 100_000;
      for (let i = 0; i < 600; i++) await am.raise("PAUSED", { title: "flood" });
      expect(state.meta.outbox.length).toBeLessThanOrEqual(500);
      expect(state.meta.outboxDropped["1"]).toBeGreaterThan(0);
    });
  });

  it("level-2 alerts are not repeated; keyless alerts always send", async () => {
    const { sink, am, setNow } = mk();
    await am.raise("PAUSED", { title: "p" });
    await am.raise("PAUSED", { title: "p" });
    setNow(1_000_000 + 90_000);
    await am.repeatDue();
    expect(sink.alerts.map((a) => a.code)).toEqual(["PAUSED", "PAUSED"]);
  });

  it("collects level-3 entries once per id and flushes a daily report at the UTC day change", async () => {
    const { sink, am, setNow, state } = mk();
    const day0 = Math.floor(1_000_000 / 86_400);
    am.daily({ kind: "WHITELIST_BATCH", chain: "bsc", id: "a", data: { count: 3 } });
    am.daily({ kind: "WHITELIST_BATCH", chain: "bsc", id: "a", data: { count: 3 } });
    am.daily({ kind: "SOURCE_VOIDED", chain: "wantos", id: "b", data: {} });
    expect(state.meta.daily.entries).toHaveLength(2);
    await am.flushDaily();
    expect(sink.alerts).toHaveLength(0);
    setNow((day0 + 1) * 86_400 + 5);
    await am.flushDaily();
    expect(sink.alerts).toHaveLength(1);
    const r = sink.alerts[0]!;
    expect(r.level).toBe(3);
    expect(r.code).toBe("DAILY_REPORT");
    expect(r.detail["counts"]).toEqual({ WHITELIST_BATCH: 1, SOURCE_VOIDED: 1 });
    expect(state.meta.daily.entries).toHaveLength(0);
    expect(state.meta.daily.day).toBe(day0 + 1);
  });

  it("log sink writes JSON lines (bigint-safe)", async () => {
    const lines: string[] = [];
    const log = new LogAlertSink((l) => lines.push(l));
    await log.send({ level: 2, code: "PAUSED", title: "t", detail: { n: 1n }, at: 1 });
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 2, code: "PAUSED", detail: { n: "1" } });
  });
});
