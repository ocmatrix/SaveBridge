import { describe, expect, it } from "vitest";
import { assertAllowedTarget, allowedTargets, TargetNotAllowedError } from "../../src/lib/guard";
import { testConfig, BRIDGE, W_USDT, B_USDT } from "../fixtures";

describe("target allow-list (DESIGN §8.1)", () => {
  it("contains exactly the two bridges and the two USDT tokens", () => {
    const t = allowedTargets(testConfig).map((x) => `${x.chainId}:${x.address.toLowerCase()}`).sort();
    expect(t).toEqual(
      [`13555:${BRIDGE}`, `13555:${W_USDT}`, `56:${BRIDGE}`, `56:${B_USDT}`].map((s) => s.toLowerCase()).sort(),
    );
  });

  it("accepts allowed targets (any case)", () => {
    expect(() => assertAllowedTarget(testConfig, 13555, BRIDGE)).not.toThrow();
    expect(() => assertAllowedTarget(testConfig, 13555, W_USDT.toUpperCase().replace("0X", "0x"))).not.toThrow();
    expect(() => assertAllowedTarget(testConfig, 56, B_USDT)).not.toThrow();
  });

  it("throws for an address outside the set", () => {
    expect(() => assertAllowedTarget(testConfig, 13555, "0x4444444444444444444444444444444444444444")).toThrow(TargetNotAllowedError);
  });

  it("throws for a token of the other chain (target must match the chain)", () => {
    expect(() => assertAllowedTarget(testConfig, 13555, B_USDT)).toThrow(TargetNotAllowedError);
    expect(() => assertAllowedTarget(testConfig, 56, W_USDT)).toThrow(TargetNotAllowedError);
  });

  it("throws for an unknown chain and for a missing target", () => {
    expect(() => assertAllowedTarget(testConfig, 1, BRIDGE)).toThrow(TargetNotAllowedError);
    expect(() => assertAllowedTarget(testConfig, 13555, undefined)).toThrow(TargetNotAllowedError);
  });
});
