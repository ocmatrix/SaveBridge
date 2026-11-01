import { describe, expect, it } from "vitest";
import {
  ALL_STATUSES,
  assertTransition,
  canTransition,
  isTerminal,
  timeoutFor,
  DEFAULT_TIMEOUTS,
  waitReasonsFor,
  type OrderStatus,
} from "../src/stateMachine";

const MIN = 60_000;
const H = 60 * MIN;

describe("order state machine (DESIGN §6.3)", () => {
  it("has exactly the §6.3 states", () => {
    expect([...ALL_STATUSES].sort()).toEqual(
      ["DETECTED", "WAITING", "REVIEW", "SUBMITTED", "QUEUED", "RELEASED", "REJECTED", "REFUNDING", "REFUNDED", "FAILED"].sort(),
    );
  });

  it("every non-terminal state has at least one exit, for both directions", () => {
    for (const dir of ["W2B", "B2W"] as const) {
      for (const s of ALL_STATUSES) {
        const exits = ALL_STATUSES.filter((t) => t !== s && canTransition(dir, s, t));
        if (isTerminal(s)) expect(exits, `${dir} ${s}`).toEqual([]);
        else expect(exits.length, `${dir} ${s} has no exit`).toBeGreaterThan(0);
      }
    }
  });

  it("RELEASED and REFUNDED are terminal", () => {
    expect(isTerminal("RELEASED")).toBe(true);
    expect(isTerminal("REFUNDED")).toBe(true);
    expect(isTerminal("FAILED")).toBe(false);
  });

  it.each([
    ["DETECTED", "WAITING"],
    ["DETECTED", "REVIEW"],
    ["DETECTED", "SUBMITTED"],
    ["WAITING", "SUBMITTED"],
    ["WAITING", "REVIEW"],
    ["REVIEW", "SUBMITTED"],
    ["REVIEW", "REJECTED"],
    ["SUBMITTED", "RELEASED"],
    ["SUBMITTED", "QUEUED"],
    ["SUBMITTED", "WAITING"],
    ["SUBMITTED", "REVIEW"],
    ["SUBMITTED", "REJECTED"],
    ["SUBMITTED", "FAILED"],
    ["QUEUED", "SUBMITTED"],
    ["QUEUED", "REJECTED"],
    ["REJECTED", "REFUNDING"],
    ["REFUNDING", "REFUNDED"],
    ["FAILED", "DETECTED"],
    ["FAILED", "REJECTED"],
  ] as [OrderStatus, OrderStatus][])("W2B allows %s -> %s", (a, b) => {
    expect(canTransition("W2B", a, b)).toBe(true);
    expect(() => assertTransition("W2B", a, b, b === "WAITING" ? "quota" : undefined)).not.toThrow();
  });

  it.each([
    ["RELEASED", "SUBMITTED"],
    ["REFUNDED", "REFUNDING"],
    ["REJECTED", "SUBMITTED"],
    ["REJECTED", "RELEASED"],
    ["REFUNDING", "SUBMITTED"],
    ["DETECTED", "REFUNDED"],
    ["QUEUED", "REFUNDING"],
    ["FAILED", "RELEASED"],
  ] as [OrderStatus, OrderStatus][])("forbids %s -> %s", (a, b) => {
    expect(canTransition("W2B", a, b)).toBe(false);
    expect(() => assertTransition("W2B", a, b)).toThrow(/illegal transition/);
  });

  it("B2W has no whitelist wait reason (§6.3)", () => {
    expect(waitReasonsFor("W2B")).toContain("whitelist");
    expect(waitReasonsFor("B2W")).not.toContain("whitelist");
    expect(waitReasonsFor("B2W")).toEqual(expect.arrayContaining(["reserve", "quota", "paused"]));
    expect(() => assertTransition("B2W", "DETECTED", "WAITING", "whitelist")).toThrow(/B2W/);
    expect(() => assertTransition("W2B", "DETECTED", "WAITING", "whitelist")).not.toThrow();
  });

  it("WAITING requires a known reason", () => {
    expect(() => assertTransition("W2B", "DETECTED", "WAITING")).toThrow(/reason/);
    expect(() => assertTransition("W2B", "DETECTED", "WAITING", "bogus" as any)).toThrow(/reason/);
  });

  describe("timeouts: every state has an alert threshold", () => {
    it("§6.3 values: index 10m, whitelist 30m, reserve immediate, review 72h, freeze 7d", () => {
      expect(timeoutFor({ status: "WAITING", reason: "index" })).toBe(10 * MIN);
      expect(timeoutFor({ status: "WAITING", reason: "whitelist" })).toBe(30 * MIN);
      expect(timeoutFor({ status: "WAITING", reason: "reserve" })).toBe(0);
      expect(timeoutFor({ status: "REVIEW", reviewLevel: "audit" })).toBe(72 * H);
      expect(timeoutFor({ status: "REVIEW", reviewLevel: "freeze" })).toBe(7 * 24 * H);
      expect(timeoutFor({ status: "FAILED" })).toBe(0);
    });
    it("non-terminal states all have a finite threshold; terminal states none", () => {
      for (const s of ALL_STATUSES) {
        const t = timeoutFor({ status: s, reason: s === "WAITING" ? "quota" : undefined, reviewLevel: s === "REVIEW" ? "audit" : undefined });
        if (isTerminal(s)) expect(t).toBeUndefined();
        else expect(Number.isFinite(t)).toBe(true);
      }
    });
    it("QUEUED is measured from executable_at plus grace", () => {
      const now = Date.now();
      const t = timeoutFor({ status: "QUEUED", executableAt: new Date(now + 15 * MIN), stateSince: new Date(now) });
      expect(t).toBe(15 * MIN + DEFAULT_TIMEOUTS.queuedGraceMs);
    });
  });
});
