import { describe, expect, it } from "vitest";
import { oldKey } from "../../src/oldkey.js";
import { scanLegacy } from "../../src/scan.js";
import type { SourceOrder } from "../../src/types.js";
import { R, T, fixture, tx } from "../helpers.js";

const basic = fixture("legacy-basic.json");
const statusOf = (r: ReturnType<typeof scanLegacy>, h: string, li: number) => r.entries.find((e) => e.srcTxHash === h && e.srcLogIndex === li)?.status;

describe("scanLegacy on the basic fixture", () => {
  const r = scanLegacy(basic, { cutoverT: basic.cutoverT! });

  it("classifies every case", () => {
    expect(statusOf(r, tx("a"), 3)).toBe("PAYABLE");
    expect(statusOf(r, tx("a"), 7)).toBe("PAYABLE"); // same txHash, other logIndex = other order
    expect(statusOf(r, tx("b"), 0)).toBe("OLD_PAID");
    expect(statusOf(r, tx("c"), 1)).toBe("OLD_PARTIAL"); // duplicated 100 payout counted once (100 < 200)
    expect(statusOf(r, tx("d"), 2)).toBe("SUSPECT_PAID");
    expect(statusOf(r, tx("e"), 0)).toBe("INVALID_ZERO_ADDRESS");
    expect(statusOf(r, tx("f"), 0)).toBe("INVALID_ZERO_AMOUNT");
    expect(statusOf(r, tx("1"), 0)).toBe("INVALID_AMOUNT");
    expect(statusOf(r, tx("2"), 0)).toBe("AFTER_T"); // timestamp == T is already after
    expect(statusOf(r, tx("3"), 4)).toBe("PAYABLE");
    expect(statusOf(r, tx("4"), 9)).toBe("PAYABLE");
  });

  it("drops identical duplicates (1 order + 1 payout) and keeps oldKey unique", () => {
    expect(r.duplicatesDropped).toBe(2);
    expect(r.entries).toHaveLength(11);
    expect(new Set(r.entries.map((e) => e.oldKey)).size).toBe(11);
  });

  it("payable = exactly the PAYABLE rows, with correct payee and wei amount", () => {
    expect(r.payable.map((e) => [e.srcTxHash, e.srcLogIndex])).toEqual([
      [tx("3"), 4],
      [tx("4"), 9],
      [tx("a"), 3],
      [tx("a"), 7],
    ]);
    const a3 = r.payable[2]!;
    expect(a3.payee).toBe(R(1));
    expect(a3.amount).toBe(100n * 10n ** 18n);
    expect(a3.oldKey).toBe(oldKey(tx("a"), 3));
    expect(r.payable[3]!.amount).toBe(1n);
    expect(r.payable[1]!.payee).toBe(R(10)); // no recipient field -> sender
    expect(r.payable[0]!.payee).toBe(R(5)); // B2W refunds the BSC depositor, not the WANTOS recipient
    expect(r.payable[0]!.amount).toBe(12_345_678n * 10n ** 12n);
  });

  it("sorts by (srcChainId, txHash, logIndex)", () => {
    const keys = r.entries.map((e) => `${String(e.srcChainId).padStart(6, "0")}|${e.srcTxHash}|${String(e.srcLogIndex).padStart(6, "0")}`);
    expect(keys).toEqual([...keys].sort());
    expect(r.entries[0]!.srcChainId).toBe(56);
  });

  it("reports orphan linked payouts and notes", () => {
    expect(r.orphanPayouts.map((p) => p.txHash)).toEqual([tx("9")]);
    expect(r.entries.find((e) => e.status === "OLD_PARTIAL")!.note).toContain("paid 100000000000000000000 of 200000000000000000000");
    expect(r.entries.find((e) => e.status === "INVALID_AMOUNT")!.note).toContain("more than 18 decimals");
    expect(r.entries.find((e) => e.status === "OLD_PAID")!.note).toBeUndefined();
  });
});

describe("scanLegacy edge rules", () => {
  const base: SourceOrder = { srcChainId: 13555, txHash: tx("a"), logIndex: 0, timestamp: T - 1, direction: "W2B", from: R(1), recipient: R(2), amount: "10" };

  it("a conflicting duplicate order (same txHash/logIndex, other content) is fatal", () => {
    expect(() => scanLegacy({ orders: [base, { ...base, amount: "11" }], payouts: [] }, { cutoverT: T })).toThrow(/conflicting duplicate order/);
  });
  it("a conflicting duplicate payout is fatal", () => {
    const p = { chainId: 56, txHash: tx("b"), logIndex: 0, to: R(2), amount: "10" };
    expect(() => scanLegacy({ orders: [base], payouts: [p, { ...p, amount: "9" }] }, { cutoverT: T })).toThrow(/conflicting duplicate payout/);
  });
  it("linked payouts are summed: two partial payouts that add up mark it OLD_PAID", () => {
    const p1 = { chainId: 56, txHash: tx("b"), logIndex: 0, to: R(2), amount: "4", srcTxHash: tx("a"), srcLogIndex: 0 };
    const p2 = { ...p1, logIndex: 1, amount: "6" };
    expect(scanLegacy({ orders: [base], payouts: [p1, p2] }, { cutoverT: T }).entries[0]!.status).toBe("OLD_PAID");
    expect(scanLegacy({ orders: [base], payouts: [p1] }, { cutoverT: T }).entries[0]!.status).toBe("OLD_PARTIAL");
  });
  it("OLD_PAID to another address is noted", () => {
    const p = { chainId: 56, txHash: tx("b"), logIndex: 0, to: R(3), amount: "10", srcTxHash: tx("a"), srcLogIndex: 0 };
    expect(scanLegacy({ orders: [base], payouts: [p] }, { cutoverT: T }).entries[0]!.note).toContain(R(3));
  });
  it("an unlinked payout to another address does not flag the order", () => {
    const q = { chainId: 56, txHash: tx("b"), logIndex: 0, to: R(3), amount: "10" };
    expect(scanLegacy({ orders: [base], payouts: [q] }, { cutoverT: T }).entries[0]!.status).toBe("PAYABLE");
  });
  it("one second before T is payable", () => {
    expect(scanLegacy({ orders: [{ ...base, timestamp: T - 1 }], payouts: [] }, { cutoverT: T }).payable).toHaveLength(1);
  });
  it("rejects corrupt input instead of guessing", () => {
    const cases: Partial<SourceOrder>[] = [{ txHash: "0x12" as never }, { logIndex: -1 }, { timestamp: 0 }, { direction: "X" as never }, { from: "0xnope" as never }, { recipient: "0x12" as never }, { srcChainId: 0 }];
    for (const c of cases) expect(() => scanLegacy({ orders: [{ ...base, ...c }], payouts: [] }, { cutoverT: T }), JSON.stringify(c)).toThrow();
    expect(() => scanLegacy({ orders: [base], payouts: [] }, { cutoverT: 0 })).toThrow(/cutoverT/);
    expect(() => scanLegacy({ orders: [], payouts: [{ chainId: 56, txHash: "0x1" as never, logIndex: 0, to: R(1), amount: "1" }] }, { cutoverT: T })).toThrow();
    expect(() => scanLegacy({ orders: [], payouts: [{ chainId: 56, txHash: tx("c"), logIndex: 0, to: R(1), amount: "x" }] }, { cutoverT: T })).toThrow();
  });
});
