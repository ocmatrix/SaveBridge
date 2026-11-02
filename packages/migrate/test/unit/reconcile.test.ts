import { describe, expect, it } from "vitest";
import { buildManifest } from "../../src/manifest.js";
import { preflightBatch, reconcileLegacy } from "../../src/reconcile.js";
import { scanLegacy } from "../../src/scan.js";
import type { LegacyPaidEvent } from "../../src/types.js";
import { R, T, VAULT, manyOrders, tx } from "../helpers.js";

const all = scanLegacy({ orders: manyOrders(5), payouts: [] }, { cutoverT: T }).payable;
const m = buildManifest(all.slice(0, 3), { bscChainId: 56, vault: VAULT, cutoverT: T });
const m2 = buildManifest(all.slice(3), { bscChainId: 56, vault: VAULT, cutoverT: T + 100 });
const ev = (i: number, over: Partial<LegacyPaidEvent> = {}): LegacyPaidEvent => ({ oldKey: m.entries[i]!.oldKey, to: m.entries[i]!.to, amount: m.entries[i]!.amount, ...over });

describe("reconcileLegacy", () => {
  it("complete when every row paid once and ΣLegacyPaid == Σmanifest", () => {
    const r = reconcileLegacy([m], [ev(0), ev(1), ev(2)]);
    expect(r).toMatchObject({ ok: true, complete: true, paidCount: 3, manifestCount: 3, unpaid: [] });
    expect(r.legacyPaidTotal).toBe(m.total);
    expect(r.manifestTotal).toBe(m.total);
  });
  it("partial batches: ok but not complete, unpaid listed", () => {
    const r = reconcileLegacy([m], [ev(2)]);
    expect(r.ok).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.unpaid.map((e) => e.oldKey)).toEqual([m.entries[0]!.oldKey, m.entries[1]!.oldKey]);
    expect(r.legacyPaidTotal).toBe(m.entries[2]!.amount);
  });
  it("several manifests are summed", () => {
    const evs = [...m.entries, ...m2.entries].map((e) => ({ oldKey: e.oldKey, to: e.to, amount: e.amount }));
    const r = reconcileLegacy([m, m2], evs);
    expect(r.complete).toBe(true);
    expect(r.manifestTotal).toBe(m.total + m2.total);
  });
  it("errors: unknown payment, double payment, wrong recipient, wrong amount, overlapping manifests", () => {
    expect(reconcileLegacy([m], [ev(0), { oldKey: tx("9"), to: R(1), amount: 5n }]).errors.join()).toMatch(/not in any published manifest/);
    const dup = reconcileLegacy([m], [ev(0), ev(0), ev(1), ev(2)]);
    expect(dup.errors.join()).toMatch(/paid more than once/);
    expect(dup.complete).toBe(false);
    expect(reconcileLegacy([m], [ev(0, { to: R(999) })]).errors.join()).toMatch(/paid to/);
    expect(reconcileLegacy([m], [ev(0, { amount: 1n })]).errors.join()).toMatch(/paid 1,/);
    expect(reconcileLegacy([m, m], []).errors.join()).toMatch(/more than one manifest/);
  });
  it("unknown payment makes Σ differ even if all rows are paid", () => {
    const r = reconcileLegacy([m], [ev(0), ev(1), ev(2), { oldKey: tx("9"), to: R(1), amount: 5n }]);
    expect(r.complete).toBe(false);
    expect(r.legacyPaidTotal).toBe(m.total + 5n);
  });
});

describe("preflightBatch", () => {
  const none = async () => false;
  it("passes when nothing is paid anywhere", async () => {
    expect(await preflightBatch(m.entries, { isLegacyPaid: none, oldPayouts: [] })).toEqual({ ok: true, blockers: [] });
  });
  it("blocks rows already paid on the new vault", async () => {
    const k = m.entries[1]!.oldKey;
    const r = await preflightBatch(m.entries, { isLegacyPaid: async (x) => x === k, oldPayouts: [] });
    expect(r.ok).toBe(false);
    expect(r.blockers).toEqual([`${k}: already paid on the new vault`]);
  });
  it("blocks rows the old bridge paid since the manifest (linked, or any loose payout to the row address)", async () => {
    const e = m.entries[0]!;
    const linked = { chainId: 56, txHash: tx("7"), logIndex: 0, to: e.to, amount: "1", srcTxHash: e.srcTxHash, srcLogIndex: e.srcLogIndex };
    expect((await preflightBatch(m.entries, { isLegacyPaid: none, oldPayouts: [linked] })).blockers.join()).toMatch(/old bridge paid/);
    const f = m.entries[2]!;
    const unlinked = { chainId: 56, txHash: tx("8"), logIndex: 0, to: f.to, amount: "3.25" };
    expect(f.amount).toBe(325n * 10n ** 16n);
    expect((await preflightBatch(m.entries, { isLegacyPaid: none, oldPayouts: [unlinked] })).blockers.join()).toMatch(/not linked to this order went to/);
    const other = { ...unlinked, to: R(4000) };
    expect((await preflightBatch(m.entries, { isLegacyPaid: none, oldPayouts: [other] })).ok).toBe(true);
  });
});
