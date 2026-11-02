import { describe, expect, it } from "vitest";
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  encodeErrorResult,
  type Abi,
} from "viem";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import { ERROR_KEYS, translateError, describeError } from "../../src/lib/errors";
import { TargetNotAllowedError } from "../../src/lib/guard";
import { zh } from "../../src/i18n/zh";
import { en } from "../../src/i18n/en";

/** PR1-NOTES §5.11 (incl. "其余" list) — the documented custom errors, by name. */
const PR1_NOTES_ERRORS = [
  "BadPayoutStatus", "DailyCapExceeded", "AddrDailyCapExceeded", "SafeERC20FailedOperation", "EnforcedPause",
  "NotWhitelisted", "AmountAboveLimit", "NotReady", "AccessControlUnauthorizedAccount",
  "ZeroAddress", "ZeroAmount", "InvalidInit", "NotAdmin", "NotWhitelistManager", "NotAdminOrWhitelistManager",
  "NotTimelock", "NotAuthorized", "RecoveryInProgress", "KeyConflict", "InvalidRole", "BadBatchSize",
  "AddressesNotSorted", "BadNonce", "SignatureExpired", "DeadlineTooFar", "InvalidSigner", "WhitelistWritesBlocked",
  "Expired", "NotCandidate", "NothingPending", "NoRecovery", "RecoveryCooldown", "AmountBelowMinimum",
  "LengthMismatch", "NotTightening", "ParamOutOfRange", "ParamConstraint",
  "UnknownDeposit", "BadDepositStatus", "LegacyAlreadyPaid",
  "ContractCaller", "SupplyCeilingExceeded", "CeilingBelowSupply", "BadOrderStatus",
];

const abiErrorNames = (abi: Abi) => abi.filter((x) => x.type === "error").map((x) => (x as { name: string }).name);
const ALL_ABI_ERRORS = [...new Set([...abiErrorNames(bscVaultV2Abi as Abi), ...abiErrorNames(wantosBridgeV2Abi as Abi)])];

function revertOf(abi: Abi, errorName: string, args: readonly unknown[]): BaseError {
  const data = encodeErrorResult({ abi, errorName, args } as never);
  const cause = new ContractFunctionRevertedError({ abi, data, functionName: "bridgeOut" });
  return new ContractFunctionExecutionError(cause, { abi: wantosBridgeV2Abi as Abi, functionName: "bridgeOut", args: [1n] });
}

describe("error translation coverage", () => {
  it.each(PR1_NOTES_ERRORS)("PR1-NOTES error %s has a translation key present in zh and en", (name) => {
    const key = ERROR_KEYS[name];
    expect(key, name).toBeDefined();
    expect(zh[key!]?.length).toBeGreaterThan(0);
    expect(en[key!]?.length).toBeGreaterThan(0);
  });

  it.each(ALL_ABI_ERRORS)("ABI error %s has a translation key", (name) => {
    expect(ERROR_KEYS[name], name).toBeDefined();
  });
});

describe("translateError", () => {
  const ctx = { decimals: 18 };
  const U = 10n ** 18n;
  const W = wantosBridgeV2Abi as Abi;
  const B = bscVaultV2Abi as Abi;
  const someone = "0x5555555555555555555555555555555555555555";

  it("NotWhitelisted → '未开通跨出，请联系客服'", () => {
    const r = translateError(revertOf(W, "NotWhitelisted", [someone]), ctx);
    expect(r.key).toBe("err.notWhitelisted");
    expect(describeError(r, "zh")).toBe("未开通跨出，请联系客服");
  });

  it("EnforcedPause → maintenance", () => {
    expect(translateError(revertOf(W, "EnforcedPause", []), ctx).key).toBe("err.paused");
  });

  it("SupplyCeilingExceeded → supply ceiling notice", () => {
    expect(translateError(revertOf(W, "SupplyCeilingExceeded", [2n, 1n]), ctx).key).toBe("err.supplyCeiling");
  });

  it("amount errors carry formatted limits", () => {
    const below = translateError(revertOf(W, "AmountBelowMinimum", [5n * U, 10n * U]), ctx);
    expect(below).toEqual({ key: "err.amountBelowMinimum", params: { amount: "5", limit: "10" } });
    expect(describeError(below, "en")).toContain("10");
    const above = translateError(revertOf(B, "AmountAboveLimit", [3000n * U, 2000n * U]), ctx);
    expect(above).toEqual({ key: "err.amountAboveLimit", params: { amount: "3,000", limit: "2,000" } });
    const addr = translateError(revertOf(W, "AddrDailyCapExceeded", [someone, 2500n * U, 2000n * U]), ctx);
    expect(addr).toEqual({ key: "err.addrDailyCapExceeded", params: { used: "2,500", cap: "2,000" } });
    expect(translateError(revertOf(W, "DailyCapExceeded", [1n, 1n]), ctx).key).toBe("err.dailyCapExceeded");
  });

  it("contract wallets are explained", () => {
    expect(translateError(revertOf(W, "ContractCaller", [someone]), ctx).key).toBe("err.contractCaller");
  });

  it("user rejection is recognised", () => {
    const e = new UserRejectedRequestError(new Error("User rejected the request."));
    expect(translateError(e, ctx).key).toBe("err.userRejected");
    expect(translateError({ code: 4001, message: "rejected" }, ctx).key).toBe("err.userRejected");
  });

  it("our own target guard error is recognised", () => {
    expect(translateError(new TargetNotAllowedError(1, "0x00"), ctx).key).toBe("err.targetNotAllowed");
  });

  it("OZ ERC-20 and legacy string reverts map to balance / allowance", () => {
    const tokenAbi = [
      { type: "error", name: "ERC20InsufficientBalance", inputs: [{ type: "address", name: "s" }, { type: "uint256", name: "b" }, { type: "uint256", name: "n" }] },
    ] as const satisfies Abi;
    expect(translateError(revertOf(tokenAbi as Abi, "ERC20InsufficientBalance", [someone, 1n, 2n]), ctx).key).toBe("err.insufficientBalance");
    expect(translateError(new BaseError("execution reverted: BEP20: transfer amount exceeds allowance"), ctx).key).toBe("err.insufficientAllowance");
    expect(translateError(new BaseError("execution reverted: ERC20: transfer amount exceeds balance"), ctx).key).toBe("err.insufficientBalance");
    expect(translateError(new BaseError("insufficient funds for gas * price + value"), ctx).key).toBe("err.insufficientGas");
  });

  it("raw revert data nested anywhere in the cause chain is decoded", () => {
    const data = encodeErrorResult({ abi: W, errorName: "NotWhitelisted", args: [someone] });
    const e = Object.assign(new Error("call failed"), { cause: { data } });
    expect(translateError(e, ctx).key).toBe("err.notWhitelisted");
  });

  it("anything else falls back to a generic message without leaking internals", () => {
    const r = translateError(new Error("REVIEW HELD PENDING something"), ctx);
    expect(r.key).toBe("err.unknown");
    expect(describeError(r, "zh")).not.toMatch(/REVIEW|HELD|PENDING/);
  });
});
