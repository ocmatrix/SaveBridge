import { describe, expect, it } from "vitest";
import { classifyOutcome, PayoutStatus } from "../src/classify";

describe("revert / outcome classification (DESIGN §6.3, PR1-NOTES §5.11)", () => {
  const base = { direction: "W2B" as const, action: "release" as const };

  it("payout status read wins: Released -> RELEASED", () => {
    expect(classifyOutcome({ ...base, payoutStatus: PayoutStatus.Released, errorName: "BadPayoutStatus" })).toMatchObject({ status: "RELEASED" });
  });
  it("Queued -> QUEUED (incl. crash-replay of queueRelease which succeeds as a no-op)", () => {
    expect(classifyOutcome({ ...base, action: "queueRelease", payoutStatus: PayoutStatus.Queued })).toMatchObject({ status: "QUEUED" });
    expect(classifyOutcome({ ...base, action: "queueRelease", payoutStatus: PayoutStatus.Queued, errorName: "BadPayoutStatus" })).toMatchObject({ status: "QUEUED" });
  });
  it("Voided -> REJECTED", () => {
    expect(classifyOutcome({ ...base, payoutStatus: PayoutStatus.Voided, errorName: "BadPayoutStatus" })).toMatchObject({ status: "REJECTED" });
  });
  it.each([
    ["DailyCapExceeded", "quota"],
    ["AddrDailyCapExceeded", "quota"],
    ["SafeERC20FailedOperation", "reserve"],
    ["ERC20InsufficientBalance", "reserve"],
    ["EnforcedPause", "paused"],
    ["NotWhitelisted", "whitelist"],
  ])("%s -> WAITING(%s)", (errorName, reason) => {
    expect(classifyOutcome({ ...base, payoutStatus: PayoutStatus.None, errorName })).toEqual({ status: "WAITING", reason });
  });
  it("BEP20-style string balance revert -> WAITING(reserve)", () => {
    expect(
      classifyOutcome({ ...base, payoutStatus: PayoutStatus.None, errorName: "Error", errorMessage: "BEP20: transfer amount exceeds balance" }),
    ).toEqual({ status: "WAITING", reason: "reserve" });
  });
  it("AmountAboveLimit -> REVIEW(audit) with reason amount_limit", () => {
    expect(classifyOutcome({ ...base, payoutStatus: PayoutStatus.None, errorName: "AmountAboveLimit" })).toEqual({
      status: "REVIEW",
      reviewLevel: "audit",
      reason: "amount_limit",
    });
  });
  it("anything else -> FAILED", () => {
    for (const e of ["ZeroAmount", "Error", undefined, "AccessControlUnauthorizedAccount", "SomethingNew"]) {
      expect(classifyOutcome({ ...base, payoutStatus: PayoutStatus.None, errorName: e })).toMatchObject({ status: "FAILED" });
    }
  });
  it("relayer key revoked raises an alert hint", () => {
    expect(classifyOutcome({ ...base, payoutStatus: PayoutStatus.None, errorName: "AccessControlUnauthorizedAccount" })).toMatchObject({
      status: "FAILED",
      alert: "RELAYER_KEY_REVOKED",
    });
  });
  it("B2W has no whitelist reason: NotWhitelisted on B2W -> FAILED", () => {
    expect(classifyOutcome({ direction: "B2W", action: "queueRelease", payoutStatus: PayoutStatus.None, errorName: "NotWhitelisted" })).toMatchObject({
      status: "FAILED",
    });
  });
  it("executeRelease NotReady keeps QUEUED (retry later)", () => {
    expect(classifyOutcome({ ...base, action: "executeRelease", payoutStatus: PayoutStatus.Queued, errorName: "NotReady" })).toEqual({ status: "QUEUED" });
  });
  it("executeRelease on a Queued payout blocked by pause/whitelist stays QUEUED with the wait reason", () => {
    expect(classifyOutcome({ ...base, action: "executeRelease", payoutStatus: PayoutStatus.Queued, errorName: "EnforcedPause" })).toEqual({
      status: "QUEUED",
      reason: "paused",
    });
    expect(classifyOutcome({ ...base, action: "executeRelease", payoutStatus: PayoutStatus.Queued, errorName: "NotWhitelisted" })).toEqual({
      status: "QUEUED",
      reason: "whitelist",
    });
  });
  it("edge inputs: missing / out-of-range BadPayoutStatus arg, unrelated Error(string), B2W execute NotWhitelisted", () => {
    expect(classifyOutcome({ ...base, errorName: "BadPayoutStatus" })).toMatchObject({ status: "FAILED" });
    expect(classifyOutcome({ ...base, errorName: "BadPayoutStatus", errorArgs: ["0x", 9] })).toMatchObject({ status: "FAILED" });
    expect(classifyOutcome({ ...base, errorName: "Error", errorMessage: "something else" })).toMatchObject({ status: "FAILED" });
    expect(classifyOutcome({ direction: "B2W", action: "executeRelease", payoutStatus: PayoutStatus.Queued, errorName: "NotWhitelisted" })).toMatchObject({ status: "FAILED" });
    expect(classifyOutcome({ ...base, action: "executeRelease", payoutStatus: PayoutStatus.Queued, errorName: "AccessControlUnauthorizedAccount" })).toMatchObject({
      status: "FAILED",
      alert: "RELAYER_KEY_REVOKED",
    });
  });

  it("BadPayoutStatus with status arg is honoured when no separate read is available", () => {
    expect(classifyOutcome({ ...base, errorName: "BadPayoutStatus", errorArgs: ["0x00", 2] })).toMatchObject({ status: "RELEASED" });
    expect(classifyOutcome({ ...base, errorName: "BadPayoutStatus", errorArgs: ["0x00", 3n] })).toMatchObject({ status: "REJECTED" });
  });
});
