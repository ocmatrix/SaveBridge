import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount } from "../../src/amount.js";
import { OLD_KEY_ENCODING, oldKey } from "../../src/oldkey.js";

describe("amount", () => {
  it("parses decimals strictly to 18-decimal wei", () => {
    expect(parseAmount("100")).toBe(100n * 10n ** 18n);
    expect(parseAmount("250.5")).toBe(2505n * 10n ** 17n);
    expect(parseAmount("0.000000000000000001")).toBe(1n);
    expect(parseAmount("1.10")).toBe(11n * 10n ** 17n);
    expect(parseAmount("0")).toBe(0n);
    expect(parseAmount("12.345678", 6)).toBe(12345678n);
    expect(parseAmount("1.000000000000000000000")).toBe(10n ** 18n); // trailing zeros beyond 18 are not precision
  });
  it("rejects more precision than 18 decimals, signs, exponents, blanks", () => {
    for (const bad of ["1.0000000000000000001", "-1", "+1", "1e18", "", " 1", "1.", ".5", "01", "0x10", "1,5"]) expect(() => parseAmount(bad), bad).toThrow();
    expect(() => parseAmount(5 as unknown as string)).toThrow();
  });
  it("formats without trailing zeros and round-trips", () => {
    expect(formatAmount(2505n * 10n ** 17n)).toBe("250.5");
    expect(formatAmount(1n)).toBe("0.000000000000000001");
    expect(formatAmount(10n ** 18n)).toBe("1");
    expect(formatAmount(0n)).toBe("0");
    for (const s of ["7.5", "0.1", "123456789.000000000000000001"]) expect(formatAmount(parseAmount(s))).toBe(s);
    expect(() => formatAmount(-1n)).toThrow();
  });
});

describe("oldKey", () => {
  it("is keccak256(abi.encode(bytes32, uint256)) — vectors from `cast`", () => {
    expect(OLD_KEY_ENCODING).toBe("keccak256(abi.encode(bytes32 srcTxHash, uint256 srcLogIndex))");
    expect(oldKey(`0x${"11".repeat(32)}`, 7)).toBe("0xea2cda56caceff556aeeb2756e2c1a820445b6413765d79997510293af0f2e35");
    expect(oldKey("0xabcdef0000000000000000000000000000000000000000000000000000000001", 0)).toBe("0xba11ecff1fc13c024f1bf396025a539663d76a01d3785b11ea83d91cdafa4366");
  });
  it("is case-insensitive in the tx hash and distinguishes logIndex", () => {
    const h = `0x${"ab".repeat(32)}` as const;
    expect(oldKey(h.toUpperCase().replace("0X", "0x") as `0x${string}`, 1)).toBe(oldKey(h, 1));
    expect(oldKey(h, 1)).not.toBe(oldKey(h, 2));
  });
  it("rejects malformed inputs", () => {
    expect(() => oldKey("0x1234", 0)).toThrow();
    expect(() => oldKey(`0x${"11".repeat(32)}`, -1)).toThrow();
    expect(() => oldKey(`0x${"11".repeat(32)}`, 1.5)).toThrow();
  });
});
