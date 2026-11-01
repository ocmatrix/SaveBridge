import { describe, expect, it } from "vitest";
import { parseConfig, resolveRpcUrls, EXAMPLE_CONFIG } from "../src/config";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const ENV = {
  WANTOS_RPC_PRIMARY: "http://127.0.0.1:1/a",
  WANTOS_RPC_CROSSCHECK_1: "http://127.0.0.1:2/b",
  BSC_RPC_1: "http://127.0.0.1:3/c",
  BSC_RPC_2: "http://127.0.0.1:4/d",
};

describe("config (DESIGN §6.2)", () => {
  it("example config parses; it holds env var NAMES only, never URLs or hosts", () => {
    const c = parseConfig(clone(EXAMPLE_CONFIG));
    expect(c.wantos.confirmations).toBe(6);
    expect(c.bsc.rpcUrlEnvs.length).toBeGreaterThanOrEqual(2);
    const all = JSON.stringify({ ...EXAMPLE_CONFIG, api: undefined });
    expect(all).not.toMatch(/:\/\//);
    expect(EXAMPLE_CONFIG.api.corsOrigins).toEqual(["https://bridge.wanto.pro"]);
    expect(all).not.toMatch(/wantos\.io|binance|bnbchain|bsc-dataseed|rpc1|rpc2|rpc3/i);
  });
  it("B3: refuses RPC URLs written into the config file", () => {
    const raw = clone(EXAMPLE_CONFIG) as any;
    raw.wantos.primaryRpcUrlEnv = "https://rpc.example.com/v2/key";
    expect(() => parseConfig(raw)).toThrow(/environment variable name/);
    const raw2 = clone(EXAMPLE_CONFIG) as any;
    raw2.bsc.rpcUrls = ["http://a", "http://b"];
    expect(() => parseConfig(raw2)).toThrow(/URL/);
  });
  it("requires >= 2 BSC RPCs", () => {
    const raw = clone(EXAMPLE_CONFIG);
    raw.bsc.rpcUrlEnvs = [raw.bsc.rpcUrlEnvs[0]!];
    expect(() => parseConfig(raw)).toThrow(/at least 2/);
  });
  it("requires a WANTOS cross-check RPC distinct from the primary", () => {
    const raw = clone(EXAMPLE_CONFIG);
    raw.wantos.crossCheckRpcUrlEnvs = [];
    expect(() => parseConfig(raw)).toThrow(/cross-check/);
    const raw2 = clone(EXAMPLE_CONFIG);
    raw2.wantos.crossCheckRpcUrlEnvs = [raw2.wantos.primaryRpcUrlEnv];
    expect(() => parseConfig(raw2)).toThrow(/distinct/);
  });
  it("resolves URLs from the environment; missing or duplicate URLs are refused", () => {
    const c = parseConfig(clone(EXAMPLE_CONFIG));
    const r = resolveRpcUrls(c, ENV);
    expect(r.wantosPrimary).toBe(ENV.WANTOS_RPC_PRIMARY);
    expect(r.bsc).toEqual([ENV.BSC_RPC_1, ENV.BSC_RPC_2]);
    expect(() => resolveRpcUrls(c, { ...ENV, BSC_RPC_2: undefined })).toThrow(/BSC_RPC_2 is not set/);
    expect(() => resolveRpcUrls(c, { ...ENV, BSC_RPC_2: ENV.BSC_RPC_1 })).toThrow(/distinct/);
    expect(() => resolveRpcUrls(c, { ...ENV, WANTOS_RPC_CROSSCHECK_1: ENV.WANTOS_RPC_PRIMARY })).toThrow(/distinct/);
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
