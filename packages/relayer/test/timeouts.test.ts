import { describe, expect, it } from "vitest";
import { newMigratedDb } from "./helpers/db";
import { MemoryAlertSink } from "../src/alerts";
import { OrderRepo, type NewOrder } from "../src/orders";
import { checkTimeouts } from "../src/timeouts";
import { Heartbeat, MemoryHeartbeatSink } from "../src/heartbeat";
import { toBytes } from "../src/bytes";
import type { OrderStatus } from "../src/stateMachine";

const MIN = 60_000;
const H = 60 * MIN;
const key = (i: number) => ("0x" + i.toString(16).padStart(64, "0")) as `0x${string}`;
const mkOrder = (i: number): NewOrder => ({
  eventKey: key(i),
  direction: "W2B",
  srcChain: 1,
  srcEventNonce: BigInt(i),
  srcTxHash: key(1000 + i),
  srcBlockNumber: 1n,
  srcBlockHash: key(2000 + i),
  userAddr: "0x00000000000000000000000000000000000000aa",
  toAddr: "0x00000000000000000000000000000000000000aa",
  amountWei: 1n,
});

/** [status, reason, reviewLevel, threshold ms, expected alert kind] — every non-terminal state. */
const CASES: [OrderStatus, string | null, string | null, number, string][] = [
  ["DETECTED", null, null, 10 * MIN, "STATE_TIMEOUT"],
  ["WAITING", "index", null, 10 * MIN, "WAIT_TIMEOUT"],
  ["WAITING", "whitelist", null, 30 * MIN, "WHITELIST_INCONSISTENT"],
  ["WAITING", "quota", null, 6 * H, "WAIT_TIMEOUT"],
  ["WAITING", "paused", null, 1 * H, "WAIT_TIMEOUT"],
  ["WAITING", "reserve", null, 0, "RESERVE_LOW"],
  ["REVIEW", "x", "audit", 72 * H, "STATE_TIMEOUT"],
  ["REVIEW", "x", "freeze", 7 * 24 * H, "STATE_TIMEOUT"],
  ["SUBMITTED", null, null, 30 * MIN, "STATE_TIMEOUT"],
  ["QUEUED", null, null, 24 * H, "STATE_TIMEOUT"],
  ["REJECTED", null, null, 72 * H, "STATE_TIMEOUT"],
  ["REFUNDING", null, null, 72 * H, "STATE_TIMEOUT"],
  ["FAILED", null, null, 0, "ORDER_FAILED"],
];

describe("per-state timeout alerts (§6.3)", () => {
  it.each(CASES)("%s(%s/%s) alerts after %d ms as %s, exactly once", async (status, reason, level, ms, kind) => {
    const db = await newMigratedDb();
    let now = new Date("2026-01-01T00:00:00Z").getTime();
    const repo = new OrderRepo(db, () => new Date(now));
    await repo.insertDetected(mkOrder(1));
    await db.query("update orders set status = $1, reason = $2, review_level = $3, state_since = $4", [status, reason, level, new Date(now)]);
    const alerts = new MemoryAlertSink();
    const run = () => checkTimeouts({ repo, alerts, now: () => new Date(now) });
    if (ms > 0) {
      now += ms - 1;
      expect(await run()).toBe(0);
      now += 1;
    }
    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
    expect(alerts.alerts.map((a) => a.kind)).toEqual([kind]);
  });

  it("QUEUED with executable_at alerts at eta + 30 min grace", async () => {
    const db = await newMigratedDb();
    let now = new Date("2026-01-01T00:00:00Z").getTime();
    const repo = new OrderRepo(db, () => new Date(now));
    await repo.insertDetected(mkOrder(1));
    await db.query("update orders set status = 'QUEUED', state_since = $1, executable_at = $2", [new Date(now), new Date(now + 12 * H)]);
    const alerts = new MemoryAlertSink();
    now += 12 * H + 29 * MIN;
    expect(await checkTimeouts({ repo, alerts, now: () => new Date(now) })).toBe(0);
    now += 2 * MIN;
    expect(await checkTimeouts({ repo, alerts, now: () => new Date(now) })).toBe(1);
  });

  it("re-arms after a reason change; terminal states never alert", async () => {
    const db = await newMigratedDb();
    let now = new Date("2026-01-01T00:00:00Z").getTime();
    const repo = new OrderRepo(db, () => new Date(now));
    await repo.insertDetected(mkOrder(1));
    await repo.insertDetected(mkOrder(2));
    await db.query("update orders set status = 'RELEASED', state_since = $1 where event_key = $2", [new Date(0), toBytes(key(2))]);
    let o = (await repo.get(key(1)))!;
    await repo.move(o, "WAITING", { reason: "reserve" });
    const alerts = new MemoryAlertSink();
    await checkTimeouts({ repo, alerts, now: () => new Date(now) });
    o = (await repo.get(key(1)))!;
    await repo.move(o, "WAITING", { reason: "quota" });
    now += 7 * H;
    await checkTimeouts({ repo, alerts, now: () => new Date(now) });
    expect(alerts.alerts.map((a) => a.kind)).toEqual(["RESERVE_LOW", "WAIT_TIMEOUT"]);
  });
});

describe("heartbeat (§9.3 心跳中断)", () => {
  it("alerts once when the loop goes silent and pings the external sink on every beat", async () => {
    let now = 0;
    const alerts = new MemoryAlertSink();
    const sink = new MemoryHeartbeatSink();
    const hb = new Heartbeat({ alerts, sink, staleAfterMs: 5 * MIN, now: () => new Date(now) });
    await hb.beat();
    now += 5 * MIN - 1;
    expect(await hb.watch()).toBe(false);
    now += 1;
    expect(await hb.watch()).toBe(true);
    expect(await hb.watch()).toBe(false);
    expect(alerts.byKind("HEARTBEAT_MISSED")).toHaveLength(1);
    expect(alerts.byKind("HEARTBEAT_MISSED")[0]!.level).toBe(1);
    await hb.beat();
    now += 5 * MIN;
    expect(await hb.watch()).toBe(true);
    expect(sink.pings).toHaveLength(2);
  });
  it("a failing external sink does not break the loop", async () => {
    const hb = new Heartbeat({ alerts: new MemoryAlertSink(), sink: { ping: async () => { throw new Error("down"); } }, staleAfterMs: 1, now: () => new Date() });
    await expect(hb.beat()).resolves.toBeUndefined();
  });
});
