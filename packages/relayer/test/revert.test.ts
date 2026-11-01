import { describe, expect, it } from "vitest";
import { BaseError, encodeErrorResult, parseAbi } from "viem";
import { bscVaultV2Abi } from "@bridge/abi";
import { decodeRevert, decodeRevertData } from "../src/chain/revert";

describe("revert decoding", () => {
  it("decodes bridge custom errors", () => {
    const data = encodeErrorResult({ abi: bscVaultV2Abi, errorName: "DailyCapExceeded", args: [1n, 2n] });
    expect(decodeRevertData(data)).toMatchObject({ errorName: "DailyCapExceeded", args: [1n, 2n] });
  });
  it("decodes OZ ERC20InsufficientBalance bubbled from the token", () => {
    const abi = parseAbi(["error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)"]);
    const data = encodeErrorResult({ abi, errorName: "ERC20InsufficientBalance", args: ["0x0000000000000000000000000000000000000001", 1n, 2n] });
    expect(decodeRevertData(data).errorName).toBe("ERC20InsufficientBalance");
  });
  it("decodes Error(string)", () => {
    const abi = parseAbi(["error Error(string)"]);
    const data = encodeErrorResult({ abi, errorName: "Error", args: ["BEP20: transfer amount exceeds balance"] });
    expect(decodeRevertData(data)).toMatchObject({ errorName: "Error", message: "BEP20: transfer amount exceeds balance" });
  });
  it("unknown selector keeps raw data", () => {
    expect(decodeRevertData("0xdeadbeef")).toEqual({ raw: "0xdeadbeef" });
  });
  it("walks viem error chains for revert data", () => {
    const data = encodeErrorResult({ abi: bscVaultV2Abi, errorName: "EnforcedPause" });
    const inner = Object.assign(new BaseError("inner"), { data });
    const outer = new BaseError("outer", { cause: inner });
    expect(decodeRevert(outer).errorName).toBe("EnforcedPause");
    expect(decodeRevert(new Error("plain")).message).toBe("plain");
  });
});
