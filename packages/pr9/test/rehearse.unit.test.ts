import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, rpcUrls, validateConfig, type RehearsalConfig } from "../src/rehearse/config";
import { assertChainAllowed, assertTestnetAuthorized, assertUrlAllowed } from "../src/rehearse/guard";
import { loadOrCreateKeys } from "../src/rehearse/keys";
import { pct, reconcileOne, type ChainView, type Tracked } from "../src/rehearse/flows";
import { barrier } from "../src/rehearse/stages/roles";

const CFG = join(import.meta.dirname, "../config");
const local = (): RehearsalConfig => loadConfig(join(CFG, "rehearse.local.json"));

describe("network guard (never mainnet)", () => {
  it("refuses mainnet chain ids for every profile and side", () => {
    for (const p of ["local", "testnet"] as const) for (const s of ["wantos", "bsc"] as const) for (const id of [13555, 56, 1]) expect(() => assertChainAllowed(p, s, id)).toThrow(/mainnet/);
  });
  it("accepts only the profile's own chain ids", () => {
    expect(() => assertChainAllowed("testnet", "wantos", 1345)).not.toThrow();
    expect(() => assertChainAllowed("testnet", "bsc", 97)).not.toThrow();
    expect(() => assertChainAllowed("local", "wantos", 31337)).not.toThrow();
    expect(() => assertChainAllowed("local", "bsc", 31338)).not.toThrow();
    expect(() => assertChainAllowed("testnet", "bsc", 1345)).toThrow();
    expect(() => assertChainAllowed("local", "wantos", 1345)).toThrow();
  });
  it("local profile only talks to 127.0.0.1; production hosts are refused everywhere", () => {
    expect(() => assertUrlAllowed("local", "http://127.0.0.1:8545")).not.toThrow();
    expect(() => assertUrlAllowed("local", "https://bsc-testnet-rpc.publicnode.com")).toThrow(/127\.0\.0\.1/);
    for (const u of ["http://101.32.41.231:8545", "https://bsc-dataseed.bnbchain.org", "https://rpc.wantos.io", "https://eth-mainnet.example.com"]) expect(() => assertUrlAllowed("testnet", u)).toThrow(/forbidden/);
    expect(() => assertUrlAllowed("testnet", "http://127.0.0.1:18545")).not.toThrow(); // SSH tunnel to rpc-test
    expect(() => assertUrlAllowed("testnet", "not a url")).toThrow();
  });
  it("testnet runs need both the flag and the env authorization", () => {
    expect(() => assertTestnetAuthorized([], {})).toThrow(/authorization/);
    expect(() => assertTestnetAuthorized(["--authorized"], {})).toThrow();
    expect(() => assertTestnetAuthorized([], { PR9_TESTNET_AUTHORIZED: "1" })).toThrow();
    expect(() => assertTestnetAuthorized(["--authorized"], { PR9_TESTNET_AUTHORIZED: "1" })).not.toThrow();
  });
});

describe("config", () => {
  it("shipped configs are valid and the testnet one points at 1345 / 97 with ≥2 RPCs per chain", () => {
    expect(() => local()).not.toThrow();
    expect(() => loadConfig(join(CFG, "rehearse.local-realtime.json"))).not.toThrow();
    const t = loadConfig(join(CFG, "rehearse.testnet.json"));
    expect(t.chains.wantos.chainId).toBe(1345);
    expect(t.chains.bsc.chainId).toBe(97);
    expect(t.waitMode).toBe("real");
  });
  it("rejects mainnet ids, too-few RPCs, warp on testnet, fast-bound violations, bad mixes", () => {
    const bad = (f: (c: RehearsalConfig) => void) => {
      const c = local();
      f(c);
      return () => validateConfig(c);
    };
    expect(bad((c) => (c.chains.bsc.chainId = 56))).toThrow(/chainId/);
    expect(bad((c) => ((c.profile = "testnet"), (c.chains.wantos.chainId = 1345), (c.chains.bsc.chainId = 97), (c.waitMode = "real")))).toThrow(/≥2 RPC/);
    expect(bad((c) => ((c.profile = "testnet"), (c.chains.wantos.chainId = 1345), (c.chains.bsc.chainId = 97), (c.chains.wantos.rpcUrlEnvs = ["A", "B"]), (c.chains.bsc.rpcUrlEnvs = ["C", "D"])))).toThrow(/real time/);
    expect(bad((c) => (c.params.bsc.releaseDelaySec = 59))).toThrow(/releaseDelay/);
    expect(bad((c) => (c.params.wantos.b2wDelaySec = 29))).toThrow(/b2wDelay/);
    expect(bad((c) => (c.chains.wantos.confirmations = 5))).toThrow(/confirmations/);
    expect(bad((c) => (c.e2e.smallW2B = 41))).toThrow(/100/);
    expect(bad((c) => (c.params.bsc.largeThreshold = 301))).toThrow(/largeThreshold/);
    expect(bad((c) => (c.chains.bsc.rpcUrlEnvs = ["https://x"]))).toThrow(/env var/);
    expect(bad((c) => (c.waitMode = "real"))).toThrow(/localBlockTimeSec/);
  });
  it("RPC URLs only come from the environment", () => {
    const c = loadConfig(join(CFG, "rehearse.testnet.json"));
    expect(() => rpcUrls(c, "bsc", {})).toThrow(/BSC_TESTNET_RPC_1/);
    expect(rpcUrls(c, "wantos", { WANTON_RPC_PRIMARY: "http://127.0.0.1:1", WANTON_RPC_CROSSCHECK_1: "http://127.0.0.1:2" })).toEqual(["http://127.0.0.1:1", "http://127.0.0.1:2"]);
  });
});

describe("test keys", () => {
  it("are generated once, kept in the run dir with mode 0600, reloaded identically", () => {
    const d = mkdtempSync(join(tmpdir(), "pr9-keys-"));
    try {
      const p = join(d, "keys.json");
      const a = loadOrCreateKeys(p);
      expect(statSync(p).mode & 0o777).toBe(0o600);
      const b = loadOrCreateKeys(p);
      expect(b.role("admin").address).toBe(a.role("admin").address);
      expect(a.users(1, 100)).toHaveLength(100);
      expect(new Set(Object.values(a.addresses())).size).toBe(Object.keys(a.addresses()).length); // all distinct
      expect(readFileSync(p, "utf8")).not.toContain("mnemonic");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("rehearsal helpers", () => {
  it("barrier releases only when every side arrived, round after round", async () => {
    const sync = barrier(2);
    const log: string[] = [];
    const side = async (n: string, delay: number) => {
      await new Promise((r) => setTimeout(r, delay));
      log.push(`${n}1`);
      await sync();
      log.push(`${n}2`);
      await sync();
      log.push(`${n}3`);
    };
    await Promise.all([side("a", 0), side("b", 20)]);
    expect(log.indexOf("a2")).toBeGreaterThan(log.indexOf("b1"));
    expect(log.indexOf("b3")).toBeGreaterThan(log.indexOf("a2"));
  });

  const t = (dir: "W2B" | "B2W", expect: "RELEASED" | "REFUNDED"): Tracked => ({ kind: "x", dir, nonce: 1n, key: "0x01", user: "0x0000000000000000000000000000000000000001", to: "0x0000000000000000000000000000000000000001", amount: 1n, expect, sentAt: 0 });
  const v = (o: Partial<ChainView>): ChainView => ({ wantosOrder: 0, bscPayout: 0, bscDeposit: 0, wantosPayout: 0, ...o });
  it("3-way reconciliation flags the cross-chain double (released AND refunded) and any DB/chain divergence", () => {
    expect(reconcileOne(t("W2B", "RELEASED"), v({ wantosOrder: 1, bscPayout: 2 }), "RELEASED")).toBeNull();
    expect(reconcileOne(t("W2B", "REFUNDED"), v({ wantosOrder: 3, bscPayout: 3 }), "REFUNDED")).toBeNull();
    expect(reconcileOne(t("W2B", "REFUNDED"), v({ wantosOrder: 3, bscPayout: 2 }), "REFUNDED")).toMatch(/BOTH/);
    expect(reconcileOne(t("W2B", "RELEASED"), v({ wantosOrder: 1, bscPayout: 1 }), "RELEASED")).toMatch(/DB RELEASED/);
    expect(reconcileOne(t("W2B", "RELEASED"), v({ wantosOrder: 1, bscPayout: 2 }), "QUEUED")).toMatch(/expected/);
    expect(reconcileOne(t("B2W", "RELEASED"), v({ wantosPayout: 2 }), "RELEASED")).toBeNull();
    expect(reconcileOne(t("B2W", "REFUNDED"), v({ wantosPayout: 2, bscDeposit: 2 }), "REFUNDED")).toMatch(/BOTH/);
    expect(reconcileOne(t("B2W", "REFUNDED"), v({ wantosPayout: 3, bscDeposit: 2 }), "REFUNDED")).toBeNull();
  });
  it("percentiles", () => {
    expect(pct([], 50)).toBe(0);
    expect(pct([5, 1, 3], 50)).toBe(3);
    expect(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });
});
