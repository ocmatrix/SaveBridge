import { describe, expect, it } from "vitest";
import { A, BRIDGE, DAY, EXCH, Fx, H, MIN, PAIR, T0, U } from "./helpers/fx";
import { merge } from "../src/engine";
import { putState } from "../src/store";

const C = A("c001"); // controlled
const C2 = A("c002");
const S = A("5001"); // intermediate
const S2 = A("5002");
const X = A("a001"); // bridging user
const OTHER = A("0b01");
const T = T0 + 30 * DAY; // order time

const AUTO = { kind: "AUTO" } as const;
const freeze = (reason = "controlled_source") => ({ kind: "REVIEW", level: "freeze", reason });
const audit = (reason = "controlled_source") => ({ kind: "REVIEW", level: "audit", reason });

describe("fund-source ratio (§7 tracing)", () => {
  it("clean inflows → inner decision (AUTO)", async () => {
    const fx = await Fx.create();
    await fx.flow({ from: OTHER, to: X, amount: 1000n * U, at: T - 5 * DAY });
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(AUTO);
  });

  it("controlled source transfers directly → REVIEW(freeze)", async () => {
    const fx = await Fx.create();
    await fx.controlled(C);
    await fx.flow({ from: C, to: X, amount: 1000n * U, at: T - 5 * DAY });
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(freeze());
  });

  it("no USDT inflow at all → nothing to attribute (AUTO)", async () => {
    const fx = await Fx.create();
    await fx.controlled(C);
    await fx.flow({ from: C, to: X, amount: 1000n * U, at: T - 5 * DAY, asset: "MG" }); // MG is not valued (no price conversion)
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(AUTO);
  });

  it("pool swap sent by a controlled address → controlled, valued at the Swap amount", async () => {
    const fx = await Fx.create();
    await fx.controlled(C);
    // C swaps MG→USDT with to = X; Swap event says 300 USDT received (value), transfer says 300
    await fx.flow({ from: PAIR, to: X, amount: 300n * U, value: 300n * U, at: T - DAY, txFrom: C });
    await fx.flow({ from: OTHER, to: X, amount: 700n * U, at: T - DAY });
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(freeze()); // 30%
  });

  it("the user's own pool swap is not controlled", async () => {
    const fx = await Fx.create();
    await fx.controlled(C);
    await fx.flow({ from: PAIR, to: X, amount: 300n * U, at: T - DAY, txFrom: X });
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(AUTO);
  });

  it("2 hops: C → S → X attributes S's controlled share", async () => {
    const fx = await Fx.create();
    await fx.controlled(C);
    await fx.flow({ from: C, to: S, amount: 100n * U, at: T - 3 * DAY });
    await fx.flow({ from: OTHER, to: S, amount: 900n * U, at: T - 3 * DAY }); // S is 10% controlled
    await fx.flow({ from: S, to: X, amount: 1000n * U, at: T - 2 * DAY });
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(audit()); // 10%
  });

  it("2 hops through a pool: S's swap output to X carries S's share", async () => {
    const fx = await Fx.create();
    await fx.controlled(C);
    await fx.flow({ from: C, to: S, amount: 500n * U, at: T - 3 * DAY });
    await fx.flow({ from: PAIR, to: X, amount: 400n * U, at: T - 2 * DAY, txFrom: S }); // S swapped, to = X
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(freeze()); // S 100% controlled
  });

  it("3 hops are not traced (C → S2 → S → X)", async () => {
    const fx = await Fx.create();
    await fx.controlled(C);
    await fx.flow({ from: C, to: S2, amount: 1000n * U, at: T - 4 * DAY });
    await fx.flow({ from: S2, to: S, amount: 1000n * U, at: T - 3 * DAY });
    await fx.flow({ from: S, to: X, amount: 1000n * U, at: T - 2 * DAY });
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(AUTO);
  });

  it("bridge payouts, mints and exempt sources are not traced through", async () => {
    const fx = await Fx.create();
    await fx.controlled(C);
    for (const src of [BRIDGE, A(0), EXCH]) await fx.flow({ from: C, to: src, amount: 1000n * U, at: T - 3 * DAY });
    for (const src of [BRIDGE, A(0), EXCH]) await fx.flow({ from: src, to: X, amount: 1000n * U, at: T - 2 * DAY });
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(AUTO);
  });

  it.each([
    [499n, AUTO],
    [500n, audit()],
    [1999n, audit()],
    [2000n, freeze()],
  ])("boundary: controlled %s bps of 10000 → %o", async (bps, want) => {
    const fx = await Fx.create();
    await fx.controlled(C);
    await fx.flow({ from: C, to: X, amount: bps * U, at: T - DAY });
    await fx.flow({ from: OTHER, to: X, amount: (10_000n - bps) * U, at: T - DAY });
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(want);
  });

  it("30-day window: older inflows and inflows after the order are ignored", async () => {
    const fx = await Fx.create();
    await fx.controlled(C);
    await fx.flow({ from: C, to: X, amount: 1000n * U, at: T - 30 * DAY }); // exactly 30d before: outside (t-30d, t]
    await fx.flow({ from: C, to: X, amount: 1000n * U, at: T + MIN });
    await fx.flow({ from: OTHER, to: X, amount: 1000n * U, at: T - 29 * DAY });
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(AUTO);
  });

  it("window end is inclusive: an inflow in the order's own block counts", async () => {
    const fx = await Fx.create();
    await fx.controlled(C);
    await fx.flow({ from: C, to: X, amount: 1000n * U, at: T });
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(freeze());
  });

  it("self-transfers are not inflows (cannot dilute the ratio)", async () => {
    const fx = await Fx.create();
    await fx.controlled(C);
    await fx.flow({ from: C, to: X, amount: 1000n * U, at: T - DAY });
    await fx.flow({ from: X, to: X, amount: 100_000n * U, at: T - DAY });
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(freeze());
  });

  it("controlled_set.effective_from: only movements at/after it count (old vault after T)", async () => {
    const fx = await Fx.create();
    await fx.controlled(C, new Date(T - 2 * DAY));
    await fx.flow({ from: C, to: X, amount: 1000n * U, at: T - 3 * DAY });
    await fx.flow({ from: OTHER, to: X, amount: 9000n * U, at: T - 3 * DAY });
    const o = await fx.bridgeOut(X, 100n * U, T);
    expect(await fx.evaluate(o)).toEqual(AUTO);
    await fx.flow({ from: C, to: X, amount: 1000n * U, at: T - 2 * DAY }); // 1000 / 11000 = 9%
    expect(await fx.evaluate(o)).toEqual(audit());
  });

  it("adding an address to the set applies to past movements", async () => {
    const fx = await Fx.create();
    await fx.flow({ from: C2, to: X, amount: 1000n * U, at: T - 3 * DAY });
    const o = await fx.bridgeOut(X, 100n * U, T);
    expect(await fx.evaluate(o)).toEqual(AUTO);
    await fx.controlled(C2);
    expect(await fx.evaluate(o)).toEqual(freeze());
  });
});

describe("behaviour rules", () => {
  it.each([
    [9 * MIN, 500n * U, audit("fresh_funds")],
    [10 * MIN, 500n * U, audit("fresh_funds")],
    [10 * MIN + 1000, 500n * U, AUTO],
    [9 * MIN, 500n * U - 1n, AUTO],
  ])("fresh funds: first receipt %s ms before, amount %s → %o", async (gap, amount, want) => {
    const fx = await Fx.create();
    await fx.flow({ from: OTHER, to: X, amount: 2000n * U, at: T - gap });
    expect(await fx.evaluate(await fx.bridgeOut(X, amount, T))).toEqual(want);
  });

  it("fresh funds counts the FIRST receipt of any asset (native gas counts)", async () => {
    const fx = await Fx.create();
    await fx.flow({ from: OTHER, to: X, amount: 1n, asset: "NATIVE", at: T - DAY });
    await fx.flow({ from: OTHER, to: X, amount: 2000n * U, at: T - MIN });
    expect(await fx.evaluate(await fx.bridgeOut(X, 600n * U, T))).toEqual(AUTO);
  });

  it("fresh funds with a later first receipt in another asset still triggers", async () => {
    const fx = await Fx.create();
    await fx.flow({ from: OTHER, to: X, amount: 1n, asset: "MG", at: T - 5 * MIN });
    expect(await fx.evaluate(await fx.bridgeOut(X, 600n * U, T))).toEqual(audit("fresh_funds"));
  });

  it("one source funds 3 addresses that all bridge out within 24h → all REVIEW + alert", async () => {
    const fx = await Fx.create();
    const users = [A("a101"), A("a102"), A("a103")];
    for (const u of users) await fx.flow({ from: S, to: u, amount: 100n * U, at: T - 2 * H, asset: "MG" });
    const orders = [];
    for (const [i, u] of users.entries()) orders.push(await fx.bridgeOut(u, 100n * U, T + i * H));
    for (const o of orders) expect(await fx.evaluate(o)).toEqual(audit("common_funder"));
    expect(fx.alerts.alerts.filter((a) => a.kind === "COMMON_FUNDER").length).toBe(3);
    expect(fx.alerts.alerts[0]!.key).toBe(`common_funder:${S.toLowerCase()}`);
    expect(fx.alerts.alerts[0]!.data).toMatchObject({ addresses: users.map((u) => u.toLowerCase()) });
  });

  it("only 2 funded addresses bridge out → no REVIEW", async () => {
    const fx = await Fx.create();
    const users = [A("a101"), A("a102"), A("a103")];
    for (const u of users) await fx.flow({ from: S, to: u, amount: 100n * U, at: T - 2 * H });
    const o1 = await fx.bridgeOut(users[0]!, 100n * U, T);
    await fx.bridgeOut(users[1]!, 100n * U, T + H);
    expect(await fx.evaluate(o1)).toEqual(AUTO);
    expect(fx.alerts.alerts).toEqual([]);
  });

  it("funding older than 24h, or bridge-outs more than 24h apart, do not count", async () => {
    const fx = await Fx.create();
    const users = [A("a101"), A("a102"), A("a103")];
    await fx.flow({ from: S, to: users[0]!, amount: 1n, at: T - 2 * H });
    await fx.flow({ from: S, to: users[1]!, amount: 1n, at: T - 2 * H });
    await fx.flow({ from: S, to: users[2]!, amount: 1n, at: T - 25 * H }); // funded > 24h before
    const o = await fx.bridgeOut(users[0]!, 100n * U, T);
    await fx.bridgeOut(users[1]!, 100n * U, T);
    await fx.bridgeOut(users[2]!, 100n * U, T);
    expect(await fx.evaluate(o)).toEqual(AUTO);
    const fx2 = await Fx.create();
    for (const u of users) await fx2.flow({ from: S, to: u, amount: 1n, at: T - 2 * H });
    const o2 = await fx2.bridgeOut(users[0]!, 100n * U, T);
    await fx2.bridgeOut(users[1]!, 100n * U, T);
    await fx2.bridgeOut(users[2]!, 100n * U, T + 25 * H);
    expect(await fx2.evaluate(o2)).toEqual(AUTO);
  });

  it("only W2B orders count as bridge-outs of funded addresses", async () => {
    const fx = await Fx.create();
    const users = [A("a101"), A("a102"), A("a103")];
    for (const u of users) await fx.flow({ from: S, to: u, amount: 1n, at: T - H });
    const o = await fx.bridgeOut(users[0]!, 100n * U, T);
    await fx.bridgeOut(users[1]!, 100n * U, T);
    const o3 = await fx.bridgeOut(users[2]!, 100n * U, T);
    await fx.db.query("update orders set direction = 'B2W' where event_key = decode($1, 'hex')", [o3.eventKey.slice(2)]);
    expect(await fx.evaluate(o)).toEqual(AUTO);
  });

  it("bridge payouts / exempt / mint sources are never a common funder", async () => {
    const fx = await Fx.create();
    const users = [A("a101"), A("a102"), A("a103")];
    for (const src of [BRIDGE, EXCH, A(0)]) for (const u of users) await fx.flow({ from: src, to: u, amount: 1n, at: T - H });
    const o = await fx.bridgeOut(users[0]!, 100n * U, T);
    await fx.bridgeOut(users[1]!, 100n * U, T);
    await fx.bridgeOut(users[2]!, 100n * U, T);
    expect(await fx.evaluate(o)).toEqual(AUTO);
  });
});

describe("combination with the PR-3 engine", () => {
  it("inner WAIT is returned as is, without touching the index (even when broken)", async () => {
    const fx = await Fx.create();
    await putState(fx.db, { lastBlock: 0n, lastBlockHash: `0x${"00".repeat(32)}`, lastBlockTime: null, headBlock: null, checkedAt: null, broken: "x" });
    fx.inner = { kind: "WAIT", reason: "quota" };
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual({ kind: "WAIT", reason: "quota" });
  });

  it("inner DELAY kept when clean", async () => {
    const fx = await Fx.create();
    fx.inner = { kind: "DELAY" };
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual({ kind: "DELAY" });
  });

  it("inner REVIEW and findings merge into one REVIEW (highest level, all reasons)", async () => {
    const fx = await Fx.create();
    fx.inner = { kind: "REVIEW", level: "audit", reason: "amount_limit" };
    await fx.controlled(C);
    await fx.flow({ from: C, to: X, amount: 1000n * U, at: T - 5 * MIN });
    expect(await fx.evaluate(await fx.bridgeOut(X, 600n * U, T))).toEqual({ kind: "REVIEW", level: "freeze", reason: "amount_limit+controlled_source+fresh_funds" });
  });

  it("B2W orders pass straight through", async () => {
    const fx = await Fx.create();
    await putState(fx.db, { lastBlock: 0n, lastBlockHash: `0x${"00".repeat(32)}`, lastBlockTime: null, headBlock: null, checkedAt: null, broken: "x" });
    const o = await fx.bridgeOut(X, 100n * U, T);
    fx.inner = { kind: "DELAY" };
    expect(await fx.evaluate({ ...o, direction: "B2W" })).toEqual({ kind: "DELAY" });
  });

  it("merge(): no findings keeps the decision; reasonless REVIEW stays reasonless", () => {
    expect(merge({ kind: "AUTO" }, [])).toEqual({ kind: "AUTO" });
    expect(merge({ kind: "REVIEW", level: "freeze" }, [])).toEqual({ kind: "REVIEW", level: "freeze" });
    expect(merge({ kind: "DELAY" }, [{ level: "audit", reason: "fresh_funds" }, { level: "audit", reason: "fresh_funds" }])).toEqual(audit("fresh_funds"));
  });
});

describe("degradation: index unavailable or behind → WAIT(index)", () => {
  const WAIT = { kind: "WAIT", reason: "index" };
  const st = (o: Partial<Parameters<typeof putState>[1]>) => ({ lastBlock: 10n ** 10n, lastBlockHash: `0x${"11".repeat(32)}` as const, lastBlockTime: null, headBlock: 10n ** 10n + 6n, checkedAt: new Date(T0 + 40 * DAY), broken: null, ...o });

  it("no index state at all", async () => {
    const fx = await Fx.create();
    await fx.db.query("delete from risk_index_state");
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(WAIT);
  });
  it("broken (unresolved reorg)", async () => {
    const fx = await Fx.create();
    await putState(fx.db, st({ broken: "reorg" }));
    expect(await fx.evaluate(await fx.bridgeOut(X, 100n * U, T))).toEqual(WAIT);
  });
  it("stale: no successful tick within indexStaleMs (boundary)", async () => {
    const fx = await Fx.create();
    const o = await fx.bridgeOut(X, 100n * U, T);
    await putState(fx.db, st({ checkedAt: new Date(fx.clock.now - 2 * MIN) }));
    expect(await fx.evaluate(o)).toEqual(AUTO);
    await putState(fx.db, st({ checkedAt: new Date(fx.clock.now - 2 * MIN - 1) }));
    expect(await fx.evaluate(o)).toEqual(WAIT);
    await putState(fx.db, st({ checkedAt: null }));
    expect(await fx.evaluate(o)).toEqual(WAIT);
  });
  it("behind head by more than indexMaxLagBlocks (boundary)", async () => {
    const fx = await Fx.create();
    const o = await fx.bridgeOut(X, 100n * U, T);
    await putState(fx.db, st({ headBlock: 10n ** 10n + 600n }));
    expect(await fx.evaluate(o)).toEqual(AUTO);
    await putState(fx.db, st({ headBlock: 10n ** 10n + 601n }));
    expect(await fx.evaluate(o)).toEqual(WAIT);
  });
  it("index has not reached the order's block (boundary)", async () => {
    const fx = await Fx.create();
    const o = await fx.bridgeOut(X, 100n * U, T);
    await putState(fx.db, st({ lastBlock: o.srcBlockNumber!, headBlock: o.srcBlockNumber! + 6n }));
    expect(await fx.evaluate(o)).toEqual(AUTO);
    await putState(fx.db, st({ lastBlock: o.srcBlockNumber! - 1n, headBlock: o.srcBlockNumber! + 6n }));
    expect(await fx.evaluate(o)).toEqual(WAIT);
    expect(await fx.evaluate({ ...o, srcBlockNumber: null })).toEqual(WAIT);
  });
  it("order's own bridge-out transfer missing from the index", async () => {
    const fx = await Fx.create();
    const o = await fx.bridgeOut(X, 100n * U, T);
    await fx.db.query("delete from risk_flows");
    expect(await fx.evaluate(o)).toEqual(WAIT);
    expect(fx.alerts.alerts).toEqual([]); // a clean WAIT, not an error path
  });
  it("database error → WAIT(index) + INDEX_ERROR alert (rules never relaxed)", async () => {
    const fx = await Fx.create();
    const o = await fx.bridgeOut(X, 100n * U, T);
    await fx.db.query("drop table risk_flows");
    expect(await fx.evaluate(o)).toEqual(WAIT);
    expect(fx.alerts.alerts.map((a) => a.kind)).toEqual(["INDEX_ERROR"]);
  });
});

describe("idempotency", () => {
  it("repeated evaluation returns the same decision and writes nothing", async () => {
    const fx = await Fx.create();
    await fx.controlled(C);
    await fx.flow({ from: C, to: S, amount: 100n * U, at: T - 3 * DAY });
    await fx.flow({ from: OTHER, to: S, amount: 900n * U, at: T - 3 * DAY });
    await fx.flow({ from: S, to: X, amount: 1000n * U, at: T - 3 * MIN });
    const o = await fx.bridgeOut(X, 600n * U, T);
    const before = await fx.counts();
    const r1 = await fx.evaluate(o);
    const r2 = await fx.evaluate(o);
    fx.clock.now += 60_000; // time passing does not change it while the index stays healthy
    const r3 = await fx.evaluate(o);
    expect(r1).toEqual({ kind: "REVIEW", level: "audit", reason: "controlled_source+fresh_funds" });
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
    expect(await fx.counts()).toBe(before);
  });
});
