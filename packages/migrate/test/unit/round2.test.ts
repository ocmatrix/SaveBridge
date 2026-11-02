/** GATE2 round-2 regressions: A-3 (W2B sender), B3, B5 (hex case at the entry), B7 (payout time). */
import { describe, expect, it } from "vitest";
import { buildManifest } from "../../src/manifest.js";
import { oldKey } from "../../src/oldkey.js";
import { preflightBatch } from "../../src/reconcile.js";
import { scanLegacy } from "../../src/scan.js";
import type { OldPayout, SourceOrder } from "../../src/types.js";
import { R, T, VAULT, tx } from "../helpers.js";

const header = { bscChainId: 56, vault: VAULT, cutoverT: T };
const none = async () => false;
const w2b: SourceOrder = { srcChainId: 13555, txHash: tx("a"), logIndex: 3, timestamp: T - 100, direction: "W2B", from: R(1), recipient: R(2), amount: "100" };
const b2w: SourceOrder = { srcChainId: 56, txHash: tx("b"), logIndex: 0, timestamp: T - 100, direction: "B2W", from: R(5), recipient: R(6), amount: "100" };
const status = (orders: SourceOrder[], payouts: OldPayout[]) => scanLegacy({ orders, payouts }, { cutoverT: T }).entries.map((e) => e.status);
const rows = (o: SourceOrder) => buildManifest(scanLegacy({ orders: [o], payouts: [] }, { cutoverT: T }).payable, header).entries;
const UP = (h: string) => `0x${h.slice(2).toUpperCase()}` as `0x${string}`;

describe("A-3: a W2B sender refunded by hand from the old WANTOS vault", () => {
  const refund: OldPayout = { chainId: 13555, txHash: tx("c"), logIndex: 0, to: R(1), amount: "100" };
  it("scan: SUSPECT_PAID", () => expect(status([w2b], [refund])).toEqual(["SUSPECT_PAID"]));
  it("preflight: blocks when the re-read orders give the sender", async () => {
    const r = await preflightBatch(rows(w2b), { isLegacyPaid: none, oldPayouts: [refund], orders: [w2b] });
    expect(r.ok).toBe(false);
    expect(r.blockers.join()).toContain(`went to ${R(1)}`);
  });
  it("preflight: a row whose order is not in the re-read orders is a blocker (re-org / wrong source)", async () => {
    const r = await preflightBatch(rows(w2b), { isLegacyPaid: none, oldPayouts: [], orders: [] });
    expect(r.blockers.join()).toMatch(/order not found in the re-read old orders/);
    expect((await preflightBatch(rows(w2b), { isLegacyPaid: none, oldPayouts: [], orders: [w2b] })).ok).toBe(true);
  });
});

describe("B3: B2W row (srcRecipient ≠ to), loose payout back to the depositor", () => {
  it("preflight blocks on the depositor (to) too", async () => {
    const r = rows(b2w);
    expect(r[0]!.to).not.toBe(r[0]!.srcRecipient);
    const back: OldPayout = { chainId: 56, txHash: tx("c"), logIndex: 0, to: R(5), amount: "100" };
    const res = await preflightBatch(r, { isLegacyPaid: none, oldPayouts: [back] });
    expect(res.ok).toBe(false);
    expect(res.blockers.join()).toContain(`went to ${R(5)}`);
  });
});

describe("B5: upper-case hex in offline JSON is normalised at the entry", () => {
  it("order txHash upper-case: same oldKey, lower-case srcTxHash in the entry", () => {
    const e = scanLegacy({ orders: [{ ...w2b, txHash: UP(tx("a")) }], payouts: [] }, { cutoverT: T }).entries[0]!;
    expect(e.srcTxHash).toBe(tx("a"));
    expect(e.oldKey).toBe(oldKey(tx("a"), 3));
  });
  it("upper-case order vs identical lower-case duplicate is deduped", () => {
    const r = scanLegacy({ orders: [w2b, { ...w2b, txHash: UP(tx("a")) }], payouts: [] }, { cutoverT: T });
    expect(r.entries).toHaveLength(1);
    expect(r.duplicatesDropped).toBe(1);
  });
  it("payout srcTxHash upper-case with another logIndex still flags the order (lower-case order)", () => {
    expect(status([w2b], [{ chainId: 56, txHash: tx("c"), logIndex: 0, to: R(40), amount: "1", srcTxHash: UP(tx("a")), srcLogIndex: 9 }])).toEqual(["SUSPECT_PAID"]);
  });
  it("lower-case payout srcTxHash vs upper-case order txHash: same-tx rule still applies", () => {
    expect(status([{ ...w2b, txHash: UP(tx("a")) }], [{ chainId: 56, txHash: tx("c"), logIndex: 0, to: R(40), amount: "1", srcTxHash: tx("a"), srcLogIndex: 9 }])).toEqual(["SUSPECT_PAID"]);
  });
  it("upper-case linked payout counts as linked (OLD_PAID)", () => {
    expect(status([w2b], [{ chainId: 56, txHash: UP(tx("c")), logIndex: 0, to: R(2), amount: "100", srcTxHash: UP(tx("a")), srcLogIndex: 3 }])).toEqual(["OLD_PAID"]);
  });
  it("preflight: upper-case srcTxHash in the payout blocks the row", async () => {
    const r = await preflightBatch(rows(w2b), { isLegacyPaid: none, oldPayouts: [{ chainId: 56, txHash: tx("c"), logIndex: 0, to: R(40), amount: "1", srcTxHash: UP(tx("a")), srcLogIndex: 9 }] });
    expect(r.ok).toBe(false);
  });
});

describe("B7: only loose payouts at or after the order time count", () => {
  const p = (timestamp?: number): OldPayout => ({ chainId: 56, txHash: tx("c"), logIndex: 0, to: R(2), amount: "5", ...(timestamp !== undefined ? { timestamp } : {}) });
  it("scan: before the order -> no hit; same second or after -> hit; unknown time -> hit", () => {
    expect(status([w2b], [p(T - 101)])).toEqual(["PAYABLE"]);
    expect(status([w2b], [p(T - 100)])).toEqual(["SUSPECT_PAID"]);
    expect(status([w2b], [p(T - 50)])).toEqual(["SUSPECT_PAID"]);
    expect(status([w2b], [p()])).toEqual(["SUSPECT_PAID"]);
    // the latest loose payout to the address decides
    expect(status([w2b], [p(T - 500), { ...p(T - 50), logIndex: 1 }])).toEqual(["SUSPECT_PAID"]);
    expect(status([w2b], [{ ...p(T - 50), logIndex: 1 }, p(T - 500)])).toEqual(["SUSPECT_PAID"]);
  });
  it("scan: same rule for the same-tx/other-logIndex link", () => {
    const linked = (timestamp: number): OldPayout => ({ chainId: 56, txHash: tx("c"), logIndex: 0, to: R(40), amount: "1", srcTxHash: tx("a"), srcLogIndex: 9, timestamp });
    expect(status([w2b], [linked(T - 101)])).toEqual(["PAYABLE"]);
    expect(status([w2b], [linked(T - 99)])).toEqual(["SUSPECT_PAID"]);
  });
  it("preflight: uses the re-read order time; without orders every loose payout counts", async () => {
    expect((await preflightBatch(rows(w2b), { isLegacyPaid: none, oldPayouts: [p(T - 101)], orders: [w2b] })).ok).toBe(true);
    expect((await preflightBatch(rows(w2b), { isLegacyPaid: none, oldPayouts: [p(T - 99)], orders: [w2b] })).ok).toBe(false);
    expect((await preflightBatch(rows(w2b), { isLegacyPaid: none, oldPayouts: [p(T - 101)] })).ok).toBe(false);
  });
  it("rejects a bad payout timestamp", () => {
    expect(() => status([w2b], [p(0)])).toThrow(/bad payout timestamp/);
  });
});
