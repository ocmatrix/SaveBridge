/** GATE2 round-1 regressions (probes P1–P4, N14, D7). Each was green-for-the-wrong-reason / missing before the fix. */
import { describe, expect, it } from "vitest";
import { buildManifest } from "../../src/manifest.js";
import { preflightBatch } from "../../src/reconcile.js";
import { scanLegacy } from "../../src/scan.js";
import type { OldPayout, SourceOrder } from "../../src/types.js";
import { R, T, VAULT, tx } from "../helpers.js";

const header = { bscChainId: 56, vault: VAULT, cutoverT: T };
const none = async () => false;
const w2b: SourceOrder = { srcChainId: 13555, txHash: tx("a"), logIndex: 3, timestamp: T - 100, direction: "W2B", from: R(1), recipient: R(2), amount: "100" };
const b2w: SourceOrder = { srcChainId: 56, txHash: tx("b"), logIndex: 0, timestamp: T - 100, direction: "B2W", from: R(5), recipient: R(6), amount: "100" };
const status = (orders: SourceOrder[], payouts: OldPayout[], extra = {}) => scanLegacy({ orders, payouts }, { cutoverT: T, ...extra }).entries.map((e) => e.status);
const rows = (o: SourceOrder) => buildManifest(scanLegacy({ orders: [o], payouts: [] }, { cutoverT: T }).payable, header).entries;

describe("P1 / P4: a payout linked to the wrong logIndex is not silently ignored", () => {
  const mislinked: OldPayout = { chainId: 56, txHash: tx("c"), logIndex: 0, to: R(2), amount: "100", srcTxHash: tx("a"), srcLogIndex: 4 };
  it("scan: SUSPECT_PAID (and still reported as orphan)", () => {
    const r = scanLegacy({ orders: [w2b], payouts: [mislinked] }, { cutoverT: T });
    expect(r.entries[0]!.status).toBe("SUSPECT_PAID");
    expect(r.orphanPayouts).toHaveLength(1);
  });
  it("scan: same srcTxHash with another logIndex is suspect even when paid to another address", () => {
    expect(status([w2b], [{ ...mislinked, to: R(40) }])).toEqual(["SUSPECT_PAID"]);
  });
  it("scan: a payout linked to an unknown order but paid to this order's recipient is suspect", () => {
    expect(status([w2b], [{ ...mislinked, srcTxHash: tx("9"), srcLogIndex: 0 }])).toEqual(["SUSPECT_PAID"]);
  });
  it("scan: a payout correctly linked to ANOTHER known order of the same recipient does not taint this one", () => {
    const other: SourceOrder = { ...w2b, txHash: tx("d"), logIndex: 0 };
    const paid: OldPayout = { ...mislinked, srcTxHash: tx("d"), srcLogIndex: 0 };
    expect(status([w2b, other], [paid])).toEqual(["PAYABLE", "OLD_PAID"]);
  });
  it("preflight: blocks", async () => {
    const r = await preflightBatch(rows(w2b), { isLegacyPaid: none, oldPayouts: [mislinked] });
    expect(r.ok).toBe(false);
    expect(r.blockers.join()).toMatch(/names 0xa{64} without being linked/);
  });
  it("preflight: re-read orders let a correctly linked payout of another order through", async () => {
    const paid: OldPayout = { ...mislinked, srcTxHash: tx("d"), srcLogIndex: 0 };
    const other: SourceOrder = { ...w2b, txHash: tx("d"), logIndex: 0 };
    expect((await preflightBatch(rows(w2b), { isLegacyPaid: none, oldPayouts: [paid] })).ok).toBe(false); // default: strict
    expect((await preflightBatch(rows(w2b), { isLegacyPaid: none, oldPayouts: [paid], orders: [w2b, other] })).ok).toBe(true);
  });
});

describe("P2: a fee-reduced old payout to the same recipient is suspect (amount not compared)", () => {
  const fee: OldPayout = { chainId: 56, txHash: tx("c"), logIndex: 0, to: R(2), amount: "99.9" };
  it("scan", () => expect(status([w2b], [fee])).toEqual(["SUSPECT_PAID"]));
  it("preflight", async () => expect((await preflightBatch(rows(w2b), { isLegacyPaid: none, oldPayouts: [fee] })).ok).toBe(false));
});

describe("P3: B2W refunds the depositor but watches the WANTOS recipient too", () => {
  const credited: OldPayout = { chainId: 13555, txHash: tx("c"), logIndex: 0, to: R(6), amount: "100" };
  it("scan: payee is the depositor, srcRecipient the WANTOS recipient; a credit to the recipient makes it suspect", () => {
    const e = scanLegacy({ orders: [b2w], payouts: [] }, { cutoverT: T }).entries[0]!;
    expect([e.payee, e.srcRecipient, e.status]).toEqual([R(5), R(6), "PAYABLE"]);
    expect(status([b2w], [credited])).toEqual(["SUSPECT_PAID"]);
    expect(status([b2w], [{ ...credited, to: R(5) }])).toEqual(["SUSPECT_PAID"]);
  });
  it("preflight uses the published srcRecipient", async () => {
    const r = rows(b2w);
    expect(r[0]!.srcRecipient).toBe(R(6));
    expect((await preflightBatch(r, { isLegacyPaid: none, oldPayouts: [credited] })).blockers.join()).toContain(R(6));
  });
});

describe("N14: duplicate payout events differing only in hex case are counted once", () => {
  it("still OLD_PARTIAL (100 of 200), not OLD_PAID", () => {
    const p: OldPayout = { chainId: 56, txHash: tx("c"), logIndex: 0, to: R(2), amount: "100", srcTxHash: tx("a"), srcLogIndex: 3 };
    const upper: OldPayout = { ...p, txHash: `0x${"C".repeat(64)}`, srcTxHash: `0x${"A".repeat(64)}`, to: R(2).toLowerCase() as `0x${string}` };
    const r = scanLegacy({ orders: [{ ...w2b, amount: "200" }], payouts: [p, upper] }, { cutoverT: T });
    expect(r.entries[0]!.status).toBe("OLD_PARTIAL");
    expect(r.duplicatesDropped).toBe(1);
  });
});
