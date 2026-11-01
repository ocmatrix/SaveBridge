import { describe, expect, it } from "vitest";
import { maxUint256 } from "viem";
import { buildExactApprove, InvalidApproveError } from "../../src/lib/approve";
import { testConfig, BRIDGE, W_USDT, B_USDT } from "../fixtures";

describe("exact approve", () => {
  it("approves exactly the input amount to the same-chain bridge", () => {
    const amount = 123_450_000_000_000_000_000n;
    const req = buildExactApprove(testConfig, 13555, amount);
    expect(req.address).toBe(W_USDT);
    expect(req.functionName).toBe("approve");
    expect(req.args).toEqual([BRIDGE, amount]);
    expect(req.args[1]).not.toBe(maxUint256);
    const b = buildExactApprove(testConfig, 56, 5n);
    expect(b.address).toBe(B_USDT);
    expect(b.args).toEqual([BRIDGE, 5n]);
  });

  it("refuses unlimited, zero and negative amounts", () => {
    expect(() => buildExactApprove(testConfig, 13555, maxUint256)).toThrow(InvalidApproveError);
    expect(() => buildExactApprove(testConfig, 13555, maxUint256 - 1n)).toThrow(InvalidApproveError);
    expect(() => buildExactApprove(testConfig, 13555, 0n)).toThrow(InvalidApproveError);
    expect(() => buildExactApprove(testConfig, 13555, -1n)).toThrow(InvalidApproveError);
  });

  it("refuses unknown chains", () => {
    expect(() => buildExactApprove(testConfig, 1, 5n)).toThrow();
  });
});
