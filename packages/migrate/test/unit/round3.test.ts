/** GATE2 round-3 regressions: preflight re-checks rows against the re-read orders (fix 1), srcTxHash-only payouts (fix 5). */
import { describe, expect, it } from "vitest";
import { buildManifest } from "../../src/manifest.js";
import { preflightBatch } from "../../src/reconcile.js";
import { scanLegacy } from "../../src/scan.js";
import type { ManifestEntry, OldPayout, SourceOrder } from "../../src/types.js";
import { R, T, VAULT, tx } from "../helpers.js";

const header = { bscChainId: 56, vault: VAULT, cutoverT: T };
const none = async () => false;
const w2b: SourceOrder = { srcChainId: 13555, txHash: tx("a"), logIndex: 3, timestamp: T - 100, direction: "W2B", from: R(1), recipient: R(2), amount: "100" };
const b2w: SourceOrder = { srcChainId: 56, txHash: tx("b"), logIndex: 0, timestamp: T - 100, direction: "B2W", from: R(5), recipient: R(6), amount: "100" };
const rows = (o: SourceOrder) => buildManifest(scanLegacy({ orders: [o], payouts: [] }, { cutoverT: T }).payable, header).entries;
const pf = (e: ManifestEntry[], orders: SourceOrder[], payouts: OldPayout[] = []) => preflightBatch(e, { isLegacyPaid: none, oldPayouts: payouts, orders });

describe("fix 1: preflight compares each manifest row with the re-read old order", () => {
  it("matching row passes", async () => {
    expect(await pf(rows(w2b), [w2b])).toEqual({ ok: true, blockers: [] });
    expect((await pf(rows(b2w), [b2w])).ok).toBe(true);
  });
  it("amount inflated (manifest 1000, real order 100) -> blocked", async () => {
    const r = await pf(rows(w2b).map((e) => ({ ...e, amount: 1000n * 10n ** 18n })), [w2b]);
    expect(r.ok).toBe(false);
    expect(r.blockers.join()).toMatch(/manifest amount differs/);
  });
  it("amount 1 wei short -> blocked", async () => {
    expect((await pf(rows(w2b).map((e) => ({ ...e, amount: e.amount - 1n })), [w2b])).blockers.join()).toMatch(/manifest amount differs/);
  });
  it("direction flipped (B2W published as W2B) -> blocked", async () => {
    const r = await pf(rows(b2w).map((e) => ({ ...e, direction: "W2B" as const })), [b2w]);
    expect(r.blockers.join()).toMatch(/manifest direction differs/);
  });
  it("recipient, srcRecipient or srcChainId changed -> blocked", async () => {
    expect((await pf(rows(w2b).map((e) => ({ ...e, to: R(9) })), [w2b])).blockers.join()).toMatch(/manifest to differs/);
    expect((await pf(rows(b2w).map((e) => ({ ...e, srcRecipient: R(9) })), [b2w])).blockers.join()).toMatch(/manifest srcRecipient differs/);
    expect((await pf(rows(w2b).map((e) => ({ ...e, srcChainId: 1 })), [w2b])).blockers.join()).toMatch(/manifest srcChainId differs/);
  });
  it("re-read order with an invalid amount -> blocked", async () => {
    expect((await pf(rows(w2b), [{ ...w2b, amount: "100.0000000000000000001" }])).blockers.join()).toMatch(/manifest amount differs/);
  });
});

describe("fix 5: old payouts that carry srcTxHash but no srcLogIndex", () => {
  const p: OldPayout = { chainId: 56, txHash: tx("c"), logIndex: 0, to: R(40), amount: "100", srcTxHash: tx("a") };
  it("scan: every order of that tx is SUSPECT_PAID (no crash, no time filter)", () => {
    const r = scanLegacy({ orders: [w2b, { ...w2b, logIndex: 4, recipient: R(3) }], payouts: [{ ...p, timestamp: 1 }] }, { cutoverT: T });
    expect(r.entries.map((e) => e.status)).toEqual(["SUSPECT_PAID", "SUSPECT_PAID"]);
    expect(r.orphanPayouts).toEqual([]); // not linked to an order, just naming a tx
  });
  it("scan: another tx is unaffected", () => {
    expect(scanLegacy({ orders: [{ ...w2b, txHash: tx("d") }], payouts: [p] }, { cutoverT: T }).entries[0]!.status).toBe("PAYABLE");
  });
  it("preflight: blocks", async () => {
    expect((await pf(rows(w2b), [w2b], [p])).blockers.join()).toMatch(/names 0xa{64}/);
  });
  it("srcLogIndex without srcTxHash is an unlinked payout (matched by address)", () => {
    const q: OldPayout = { chainId: 56, txHash: tx("c"), logIndex: 0, to: R(2), amount: "1", srcLogIndex: 3 };
    expect(scanLegacy({ orders: [w2b], payouts: [q] }, { cutoverT: T }).entries[0]!.status).toBe("SUSPECT_PAID");
    expect(scanLegacy({ orders: [w2b], payouts: [{ ...q, to: R(40) }] }, { cutoverT: T }).entries[0]!.status).toBe("PAYABLE");
  });
  it("a malformed srcTxHash is rejected", () => {
    expect(() => scanLegacy({ orders: [w2b], payouts: [{ ...p, srcTxHash: "0x12" as `0x${string}` }] }, { cutoverT: T })).toThrow(/bad payout srcTxHash/);
  });
});
