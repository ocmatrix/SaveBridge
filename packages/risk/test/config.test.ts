import { describe, expect, it } from "vitest";
import { A, MG, PAIR, USDT, newRiskDb, testConfig } from "./helpers/fx";
import { defaultParams, parseRiskConfig, type RiskConfig } from "../src/config";
import { loadPairsFromFactory, type ContractReader } from "../src/pairs";
import { listControlled, removeControlled, upsertControlled } from "../src/store";

const base = (): RiskConfig => ({ ...testConfig(), params: defaultParams(18) });

describe("config", () => {
  it("defaults are the DESIGN §7 targets", () => {
    const p = defaultParams(18);
    expect(p).toMatchObject({ lookbackMs: 30 * 86_400_000, freezeBps: 2000, auditBps: 500, freshWindowMs: 600_000, funderWindowMs: 86_400_000, funderMinAddrs: 3 });
    expect(p.freshMinAmount).toBe(500n * 10n ** 18n);
    expect(defaultParams(6).freshMinAmount).toBe(500_000_000n);
    expect(p.funderMinAmount).toEqual({ USDT: 10n ** 18n, NATIVE: 10n ** 18n });
    expect(defaultParams(6).funderMinAmount.USDT).toBe(1_000_000n);
  });
  it("normalises addresses", () => {
    const c = parseRiskConfig({ ...base(), usdt: USDT.toLowerCase() as `0x${string}` });
    expect(c.usdt).toBe(USDT);
  });
  it.each([
    ["auditBps 0", (c: RiskConfig) => (c.params.auditBps = 0)],
    ["audit > freeze", (c: RiskConfig) => (c.params.auditBps = 2001)],
    ["freeze > 100%", (c: RiskConfig) => ((c.params.freezeBps = 10_001), (c.params.auditBps = 500))],
    ["lookback 0", (c: RiskConfig) => (c.params.lookbackMs = 0)],
    ["fresh window < 0", (c: RiskConfig) => (c.params.freshWindowMs = -1)],
    ["funder window 0", (c: RiskConfig) => (c.params.funderWindowMs = 0)],
    ["funderMinAddrs 1", (c: RiskConfig) => (c.params.funderMinAddrs = 1)],
    ["freshMinAmount < 0", (c: RiskConfig) => (c.params.freshMinAmount = -1n)],
    ["stale 0", (c: RiskConfig) => (c.params.indexStaleMs = 0)],
    ["lag 0", (c: RiskConfig) => (c.params.indexMaxLagBlocks = 0)],
    ["funderMinAmount 0", (c: RiskConfig) => (c.params.funderMinAmount = { USDT: 0n })],
    ["funderMinAmount negative", (c: RiskConfig) => (c.params.funderMinAmount = { NATIVE: -1n })],
    ["no pairs", (c: RiskConfig) => (c.pairs = [])],
    ["dup pair", (c: RiskConfig) => (c.pairs = [{ address: PAIR, usdtIndex: 1 }, { address: PAIR, usdtIndex: 1 }])],
    ["bad address", (c: RiskConfig) => (c.bridge = "0x1234" as `0x${string}`)],
  ])("rejects %s", (_n, mut) => {
    const c = base();
    c.params = { ...c.params };
    mut(c);
    expect(() => parseRiskConfig(c)).toThrow();
  });
  it("accepts audit == freeze", () => {
    const c = base();
    c.params = { ...c.params, auditBps: 2000 };
    expect(parseRiskConfig(c).params.auditBps).toBe(2000);
  });
});

describe("loadPairsFromFactory", () => {
  const P1 = A("9a11");
  const P2 = A("9a12");
  const P3 = A("9a13");
  const reader = (n: bigint): ContractReader => ({
    readContract: async ({ address, functionName, args }) => {
      if (functionName === "allPairsLength") return n;
      if (functionName === "allPairs") return [P1, P2, P3][Number(args![0])];
      const t: Record<string, [string, string]> = { [P1]: [USDT, MG], [P2]: [MG, USDT], [P3]: [MG, A("71de")] };
      return t[address]![functionName === "token0" ? 0 : 1];
    },
  });
  it("derives the USDT side of every pair", async () => {
    expect(await loadPairsFromFactory(reader(3n), A("fac7"), USDT, 3)).toEqual([
      { address: P1, usdtIndex: 0 },
      { address: P2, usdtIndex: 1 },
      { address: P3, usdtIndex: null },
    ]);
  });
  it("expectCount is mandatory", async () => {
    await expect(loadPairsFromFactory(reader(3n), A("fac7"), USDT, undefined as unknown as number)).rejects.toThrow(/expectCount/);
  });
  it("refuses an unexpected pair count", async () => {
    await expect(loadPairsFromFactory(reader(3n), A("fac7"), USDT, 8)).rejects.toThrow(/expected 8/);
  });
});

describe("controlled set store", () => {
  it("upsert/remove write audit_log", async () => {
    const db = await newRiskDb();
    await upsertControlled(db, "0xadmin", { addr: A("c001"), label: "old vault", effectiveFrom: new Date(1000) });
    await upsertControlled(db, "0xadmin", { addr: A("c001"), label: "old vault 2" });
    expect(await listControlled(db)).toEqual([{ addr: A("c001"), label: "old vault 2", effectiveFrom: null }]);
    await removeControlled(db, "0xadmin", A("c001"));
    expect(await listControlled(db)).toEqual([]);
    const r = await db.query<{ action: string; actor: string }>("select actor, action from audit_log order by id");
    expect(r.rows).toEqual([
      { actor: "0xadmin", action: "controlled_set.upsert" },
      { actor: "0xadmin", action: "controlled_set.upsert" },
      { actor: "0xadmin", action: "controlled_set.remove" },
    ]);
  });
});
