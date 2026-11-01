import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, type Address } from "viem";
import { bscVaultV2Abi } from "@bridge/abi";
import { parseConfig } from "../../src/config.js";
import { describeCall } from "../../src/events.js";
import { buildRpc, startupGuard } from "../../src/wiring.js";

const A = "0x1111111111111111111111111111111111111111" as Address;
const T = "0x2222222222222222222222222222222222222222" as Address;

describe("misc", () => {
  it("B8: the entry point refuses to start without a wired PAUSER signer unless --dry-run", () => {
    expect(() => startupGuard({ args: [], signerWired: false })).toThrow(/PAUSER signer/);
    expect(startupGuard({ args: ["--dry-run"], signerWired: false })).toEqual({ dryRun: true });
    expect(startupGuard({ args: [], signerWired: true })).toEqual({ dryRun: false });
  });

  it("describeCall decodes bridge calls and falls back to the selector for unknown targets / data", () => {
    const data = encodeFunctionData({ abi: bscVaultV2Abi, functionName: "withdraw", args: [A, 5n] });
    expect(describeCall(A, data, A, T, "bsc").fn).toBe("withdraw");
    expect(describeCall("0x3333333333333333333333333333333333333333", data, A, T, "bsc").fn).toBe(data.slice(0, 10));
    expect(describeCall(T, "0xdeadbeef", A, T, "bsc").fn).toBe("0xdeadbeef");
  });

  it("buildRpc creates one independent client per configured URL (no network I/O at construction)", () => {
    const cfg = parseConfig(JSON.parse(readFileSync(join(__dirname, "../../config/watcher.example.json"), "utf8")));
    const rpc = buildRpc(cfg);
    expect(rpc.bsc.endpoints).toHaveLength(3);
    expect(rpc.wantos.endpoints).toHaveLength(2);
    expect(rpc.bsc.minAgree).toBe(2);
  });
});
