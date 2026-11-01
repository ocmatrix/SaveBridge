import { describe, expect, it } from "vitest";
import { parseConfig, EXAMPLE_CONFIG } from "../src/config";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("config (DESIGN §6.2)", () => {
  it("example config parses and only contains placeholder hosts", () => {
    const c = parseConfig(clone(EXAMPLE_CONFIG));
    expect(c.wantos.confirmations).toBe(6);
    expect(c.bsc.rpcUrls.length).toBeGreaterThanOrEqual(2);
    const all = JSON.stringify(EXAMPLE_CONFIG);
    expect(all).not.toMatch(/wantos\.io|binance|bnbchain|bsc-dataseed|rpc1|rpc2|rpc3/i);
  });
  it("requires >= 2 BSC RPCs", () => {
    const raw = clone(EXAMPLE_CONFIG);
    raw.bsc.rpcUrls = [raw.bsc.rpcUrls[0]!];
    expect(() => parseConfig(raw)).toThrow(/at least 2/);
  });
  it("requires a WANTOS cross-check RPC distinct from the primary", () => {
    const raw = clone(EXAMPLE_CONFIG);
    raw.wantos.crossCheckRpcUrls = [];
    expect(() => parseConfig(raw)).toThrow(/cross-check/);
    const raw2 = clone(EXAMPLE_CONFIG);
    raw2.wantos.crossCheckRpcUrls = [raw2.wantos.primaryRpcUrl];
    expect(() => parseConfig(raw2)).toThrow(/distinct/);
  });
  it("refuses fewer than 6 WANTOS confirmations", () => {
    const raw = clone(EXAMPLE_CONFIG);
    raw.wantos.confirmations = 5;
    expect(() => parseConfig(raw)).toThrow(/confirmations/);
  });
  it("refuses any private key material in config", () => {
    const raw = clone(EXAMPLE_CONFIG) as unknown as Record<string, unknown>;
    (raw as any).bsc.privateKey = "0x" + "11".repeat(32);
    expect(() => parseConfig(raw as any)).toThrow(/key material/);
  });
  it("validates bridge addresses", () => {
    const raw = clone(EXAMPLE_CONFIG);
    raw.bsc.bridgeAddress = "0x1234" as `0x${string}`;
    expect(() => parseConfig(raw)).toThrow(/address/);
  });
});
