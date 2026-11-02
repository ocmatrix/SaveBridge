import { describe, expect, it } from "vitest";
import { parseAmountInput, validateW2B, validateB2W, formatAmount } from "../../src/lib/amount";

const U = 10n ** 18n;

describe("parseAmountInput", () => {
  it("parses decimals exactly", () => {
    expect(parseAmountInput("12.5", 18)).toEqual({ ok: true, value: 125n * 10n ** 17n });
    expect(parseAmountInput(" 100 ", 18)).toEqual({ ok: true, value: 100n * U });
    expect(parseAmountInput("0.000001", 6)).toEqual({ ok: true, value: 1n });
  });
  it.each(["", "abc", "1e3", "-1", "1.2.3", "0", "0.00", "1,000", "0x10", ".", "1."])("rejects %j", (s) => {
    expect(parseAmountInput(s, 18).ok).toBe(false);
  });
  it("rejects more fractional digits than the token has", () => {
    const r = parseAmountInput("1.0000001", 6);
    expect(r).toEqual({ ok: false, error: { key: "amount.tooManyDecimals", params: { decimals: "6" } } });
  });
});

describe("validateW2B", () => {
  const base = { min: 10n * U, perAddrCap: 2000n * U, addrRemaining: 2000n * U, balance: 5000n * U, decimals: 18 };
  it("accepts amounts within min / remaining / balance", () => {
    expect(validateW2B({ ...base, amount: 10n * U })).toBeNull();
    expect(validateW2B({ ...base, amount: 2000n * U })).toBeNull();
  });
  it("rejects below the minimum", () => {
    expect(validateW2B({ ...base, amount: 9n * U })).toEqual({ key: "amount.belowMin", params: { min: "10" } });
  });
  it("rejects above the per-address daily cap (also the per-order cap)", () => {
    expect(validateW2B({ ...base, amount: 2001n * U })?.key).toBe("amount.aboveMax");
  });
  it("rejects above today's remaining quota", () => {
    expect(validateW2B({ ...base, addrRemaining: 500n * U, amount: 501n * U })).toEqual({
      key: "amount.aboveRemaining",
      params: { remaining: "500" },
    });
  });
  it("reports quota exhausted when remaining is below the minimum", () => {
    expect(validateW2B({ ...base, addrRemaining: 5n * U, amount: 10n * U })?.key).toBe("quota.exhausted");
  });
  it("rejects above balance", () => {
    expect(validateW2B({ ...base, balance: 50n * U, amount: 60n * U })?.key).toBe("amount.aboveBalance");
  });
});

describe("validateB2W", () => {
  const base = { minDeposit: 10n * U, maxDepositPerTx: 2000n * U, b2wRemaining: 3000n * U, balance: 5000n * U, decimals: 18 };
  it("accepts amounts within limits", () => {
    expect(validateB2W({ ...base, amount: 10n * U })).toBeNull();
    expect(validateB2W({ ...base, amount: 2000n * U })).toBeNull();
  });
  it("rejects below minDeposit and above maxDepositPerTx", () => {
    expect(validateB2W({ ...base, amount: 9n * U })?.key).toBe("amount.belowMin");
    expect(validateB2W({ ...base, amount: 2001n * U })).toEqual({ key: "amount.aboveMax", params: { max: "2,000" } });
  });
  it("rejects above the WANTOS daily inbound remaining (would be refunded instead)", () => {
    expect(validateB2W({ ...base, b2wRemaining: 100n * U, amount: 200n * U })?.key).toBe("amount.aboveRemaining");
    expect(validateB2W({ ...base, b2wRemaining: 0n, amount: 10n * U })?.key).toBe("quota.exhausted");
  });
  it("rejects above balance", () => {
    expect(validateB2W({ ...base, balance: 1n * U, amount: 10n * U })?.key).toBe("amount.aboveBalance");
  });
});

describe("formatAmount", () => {
  it("formats with grouping and trims to 6 decimals without rounding up", () => {
    expect(formatAmount(1234567n * 10n ** 15n, 18)).toBe("1,234.567");
    expect(formatAmount(2000n * U, 18)).toBe("2,000");
    expect(formatAmount(1n, 18)).toBe("<0.000001");
    expect(formatAmount(0n, 18)).toBe("0");
    expect(formatAmount(1999999999n * 10n ** 9n, 18)).toBe("1.999999");
  });
});

describe("recipient validation (review finding 1)", () => {
  it("rejects a mixed-case address with a bad checksum and the zero address", async () => {
    const { validRecipient } = await import("../../src/lib/amount");
    expect(validRecipient("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe(true);
    expect(validRecipient("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(true);
    expect(validRecipient("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD")).toBe(false);
    expect(validRecipient("0x0000000000000000000000000000000000000000")).toBe(false);
    expect(validRecipient("0x1234")).toBe(false);
  });
});
