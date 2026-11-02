import { describe, expect, it } from "vitest";
import { w2bUserStatus, b2wUserStatus, parseRelayerOrders } from "../../src/lib/status";
import * as statusModule from "../../src/lib/status";

describe("user-visible order status (risk states never exposed)", () => {
  it("W2B: chain order status + BSC payout status", () => {
    expect(w2bUserStatus(1, 0)).toBe("processing");
    expect(w2bUserStatus(1, 1)).toBe("processing"); // queued (large amount) is not disclosed
    expect(w2bUserStatus(1, 2)).toBe("completed");
    expect(w2bUserStatus(1, 3)).toBe("processing"); // voided, refund not yet requested
    expect(w2bUserStatus(2, 3)).toBe("refunding");
    expect(w2bUserStatus(3, 3)).toBe("refunded");
    expect(w2bUserStatus(1, null)).toBe("processing"); // BSC unreadable
  });
  it("B2W: deposit refund status + WANTOS payout status", () => {
    expect(b2wUserStatus(0, 0)).toBe("awaitingCredit");
    expect(b2wUserStatus(0, 1)).toBe("awaitingCredit");
    expect(b2wUserStatus(0, 2)).toBe("completed");
    expect(b2wUserStatus(0, 3)).toBe("processing");
    expect(b2wUserStatus(1, 3)).toBe("refunding");
    expect(b2wUserStatus(2, 3)).toBe("refunded");
    expect(b2wUserStatus(0, null)).toBe("awaitingCredit");
  });
});

describe("parseRelayerOrders (shape requested from PR-3: ids + dstTxHash only)", () => {
  it("has no relayer-status mapping at all (status is always read on chain)", () => {
    expect("mapRelayerStatus" in statusModule).toBe(false);
  });
  it("keeps only well-formed entries and drops any status field", () => {
    const r = parseRelayerOrders({
      orders: [
        { direction: "W2B", srcEventNonce: "7", status: "REVIEW", dstTxHash: null },
        { direction: "B2W", srcEventNonce: "3", dstTxHash: "0x" + "ab".repeat(32) },
        { direction: "X", srcEventNonce: "1" },
        { direction: "W2B", srcEventNonce: "-1" },
        { direction: "W2B", srcEventNonce: "1", dstTxHash: "javascript:x" },
        "garbage",
      ],
    });
    expect(r).toEqual([
      { direction: "W2B", nonce: 7n, dstTxHash: null },
      { direction: "B2W", nonce: 3n, dstTxHash: "0x" + "ab".repeat(32) },
      { direction: "W2B", nonce: 1n, dstTxHash: null },
    ]);
  });
  it("returns [] for a non-conforming body", () => {
    expect(parseRelayerOrders(null)).toEqual([]);
    expect(parseRelayerOrders({ orders: "x" })).toEqual([]);
  });
});
