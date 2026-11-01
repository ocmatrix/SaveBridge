import { describe, expect, it } from "vitest";
import { w2bUserStatus, b2wUserStatus, mapRelayerStatus, parseRelayerOrders } from "../../src/lib/status";

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
  it.each(["DETECTED", "WAITING", "REVIEW", "HELD", "PENDING", "SUBMITTED", "QUEUED", "REJECTED", "FAILED", "weird", ""])(
    "relayer status %s maps to processing",
    (s) => expect(mapRelayerStatus(s)).toBe("processing"),
  );
  it("relayer terminal states map through", () => {
    expect(mapRelayerStatus("RELEASED")).toBe("completed");
    expect(mapRelayerStatus("REFUNDING")).toBe("refunding");
    expect(mapRelayerStatus("REFUNDED")).toBe("refunded");
  });
});

describe("parseRelayerOrders (shape requested from PR-3)", () => {
  it("keeps only well-formed entries", () => {
    const r = parseRelayerOrders({
      orders: [
        { direction: "W2B", srcEventNonce: "7", status: "REVIEW", dstTxHash: null },
        { direction: "B2W", srcEventNonce: "3", status: "RELEASED", dstTxHash: "0x" + "ab".repeat(32) },
        { direction: "X", srcEventNonce: "1", status: "RELEASED" },
        { direction: "W2B", srcEventNonce: "-1", status: "RELEASED" },
        { direction: "W2B", srcEventNonce: "1", status: "RELEASED", dstTxHash: "javascript:x" },
        "garbage",
      ],
    });
    expect(r).toEqual([
      { direction: "W2B", nonce: 7n, status: "processing", dstTxHash: null },
      { direction: "B2W", nonce: 3n, status: "completed", dstTxHash: "0x" + "ab".repeat(32) },
      { direction: "W2B", nonce: 1n, status: "completed", dstTxHash: null },
    ]);
  });
  it("returns [] for a non-conforming body", () => {
    expect(parseRelayerOrders(null)).toEqual([]);
    expect(parseRelayerOrders({ orders: "x" })).toEqual([]);
  });
});
