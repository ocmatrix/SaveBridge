import { describe, expect, it } from "vitest";
import {
  assertAllowedUrl,
  headSnapshot,
  classifyError,
  crossCheck,
  parseRangeHint,
  probeEndpoint,
  providerFamily,
  recommend,
  type EndpointReport,
  type RpcFn,
  type RpcResult,
} from "../src/probe/probe.js";
import { candidateEndpoints } from "../src/probe/endpoints.js";

const LATEST = 50_000_000;
const hex = (n: number) => `0x${n.toString(16)}`;
const ok = (result: unknown, ms = 50): RpcResult => ({ ok: true, result, ms, httpStatus: 200 });
const err = (message: string, extra: { code?: number; httpStatus?: number } = {}): RpcResult => ({ ok: false, ms: 50, message, ...extra });

interface FakeOpts {
  chainId?: number;
  finalized?: "ok" | "unsupported";
  safe?: "ok" | "unsupported";
  /** Max getLogs range; larger → `logsError(limit)`. */
  logLimit?: number;
  logsError?: (limit: number) => RpcResult;
  burst?: (i: number) => RpcResult;
  latency?: number;
}

function fake(o: FakeOpts = {}): { rpc: RpcFn; calls: { method: string; params: unknown[] }[] } {
  const calls: { method: string; params: unknown[] }[] = [];
  let bn = 0;
  const rpc: RpcFn = async (_url, method, params) => {
    calls.push({ method, params });
    switch (method) {
      case "eth_chainId":
        return ok(hex(o.chainId ?? 97));
      case "eth_blockNumber":
        bn++;
        // calls 1-3: head, head-after-finalized, head-after-safe; the burst starts at call 4
        if (bn > 3 && o.burst) return o.burst(bn - 4);
        return ok(hex(LATEST), o.latency ?? 50);
      case "eth_getBlockByNumber": {
        const tag = params[0];
        const mode = tag === "finalized" ? o.finalized : tag === "safe" ? o.safe : "ok";
        if (mode === "unsupported") return err("invalid block tag", { code: -32602 });
        return ok({ number: hex(tag === "finalized" ? LATEST - 2 : tag === "safe" ? LATEST - 1 : LATEST) });
      }
      case "eth_getLogs": {
        const f = params[0] as { fromBlock: string; toBlock: string };
        const range = Number.parseInt(f.toBlock, 16) - Number.parseInt(f.fromBlock, 16) + 1;
        const limit = o.logLimit ?? 100_000;
        if (range > limit) return o.logsError ? o.logsError(limit) : err(`exceed maximum block range: ${limit}`, { code: -32000 });
        return ok([]);
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { rpc, calls };
}

const quick = { sleep: async () => {} };

describe("error parsing", () => {
  it.each([
    ["exceed maximum block range: 5000", 5000],
    ["block range is too large, max 1000", 1000],
    ["eth_getLogs is limited to a 10,000 range", 10_000],
    ["You can make eth_getLogs requests with up to a 2K block range", 2000],
    ["query returned more than 10000 results", null],
    ["limit exceeded", null],
    ["Log response size exceeded. Maximum allowed number of requested blocks is 1000", 1000],
  ])("hint(%s) = %s", (msg, want) => {
    expect(parseRangeHint(msg)).toBe(want);
  });

  it("classifies range / rate / unsupported shapes", () => {
    expect(classifyError({ message: "exceed maximum block range: 5000" })).toBe("range");
    expect(classifyError({ message: "block range is too large" })).toBe("range");
    expect(classifyError({ message: "limit exceeded", code: -32005 })).toBe("range");
    expect(classifyError({ message: "whatever", code: -32005 })).toBe("range");
    expect(classifyError({ message: "Request Entity Too Large", httpStatus: 413 })).toBe("range");
    expect(classifyError({ message: "query returned more than 10000 results" })).toBe("range");
    expect(classifyError({ message: "Too Many Requests", httpStatus: 429 })).toBe("rate");
    expect(classifyError({ message: "daily request limit reached", code: -32005 })).toBe("rate");
    expect(classifyError({ message: "ranges over 10000 blocks are not supported on free plan", code: 35 })).toBe("range");
    expect(classifyError({ message: "Temporary internal error. Please retry", code: 19 })).toBe("transient");
    expect(classifyError({ message: "Web server is down", httpStatus: 521 })).toBe("transient");
    expect(classifyError({ message: "the method eth_x does not exist/is not available", code: -32601 })).toBe("unsupported");
  });
});

describe("getLogs limit detection", () => {
  it("uses the provider hint to land exactly on the limit", async () => {
    const { rpc } = fake({ logLimit: 5000 });
    const r = await probeEndpoint(rpc, "https://bsc-testnet.example-a.io", quick);
    expect(r.logs.maxAccepted).toBe(5000);
    expect(r.logs.firstRejection).toMatchObject({ range: 10_000, kind: "range", hint: 5000 });
  });

  it("walks the ladder when the error has no number (block range is too large)", async () => {
    const { rpc } = fake({ logLimit: 1500, logsError: () => err("block range is too large", { code: -32600 }) });
    const r = await probeEndpoint(rpc, "https://bsc-testnet.example-b.io", quick);
    expect(r.logs.maxAccepted).toBe(1000);
    expect(r.logs.firstRejection?.kind).toBe("range");
  });

  it("handles -32005 limit exceeded and HTTP 413", async () => {
    const a = await probeEndpoint(fake({ logLimit: 500, logsError: () => err("limit exceeded", { code: -32005 }) }).rpc, "https://bsc-testnet.ex-c.io", quick);
    expect(a.logs.maxAccepted).toBe(500);
    const b = await probeEndpoint(fake({ logLimit: 100, logsError: () => err("Payload Too Large", { httpStatus: 413 }) }).rpc, "https://bsc-testnet.ex-d.io", quick);
    expect(b.logs.maxAccepted).toBe(100);
    expect(b.logs.firstRejection?.kind).toBe("range");
  });

  it("retries a transient rung once, then accepts it", async () => {
    let n = 0;
    const base = fake({ logLimit: 2000 });
    const rpc: RpcFn = async (url, method, params) => {
      if (method === "eth_getLogs" && n++ === 1) return err("Temporary internal error. Please retry", { code: 19 });
      return base.rpc(url, method, params);
    };
    const r = await probeEndpoint(rpc, "https://bsc-testnet.ex-t.io", quick);
    expect(r.logs.maxAccepted).toBe(2000);
  });

  it("records ≥ top rung when everything passes ≥ top when everything passes", async () => {
    const r = await probeEndpoint(fake().rpc, "https://bsc-testnet.ex-e.io", quick);
    expect(r.logs.maxAccepted).toBe(10_000);
    expect(r.logs.atLeast).toBe(true);
    expect(r.classification).toBe("usable");
  });

  it("getLogs rejected everywhere → unusable", async () => {
    const r = await probeEndpoint(fake({ logLimit: 0, logsError: () => err("method disabled", { code: -32601 }) }).rpc, "https://bsc-testnet.ex-f.io", quick);
    expect(r.logs.maxAccepted).toBeNull();
    expect(r.classification).toBe("unusable");
  });
});

describe("classification", () => {
  it("finalized unsupported → degraded with reason", async () => {
    const r = await probeEndpoint(fake({ finalized: "unsupported" }).rpc, "https://bsc-testnet.ex-g.io", quick);
    expect(r.finalized.supported).toBe(false);
    expect(r.classification).toBe("degraded");
    expect(r.reasons.join()).toMatch(/finalized/);
  });

  it("finalized lag is latest - finalized", async () => {
    const r = await probeEndpoint(fake().rpc, "https://bsc-testnet.ex-h.io", quick);
    expect(r.finalized).toMatchObject({ supported: true, block: LATEST - 2, lag: 2 });
    expect(r.safe.lag).toBe(1);
  });

  it("wrong chainId → unusable and stops after eth_chainId", async () => {
    const { rpc, calls } = fake({ chainId: 56 });
    const r = await probeEndpoint(rpc, "https://bsc-testnet.ex-i.io", quick);
    expect(r.classification).toBe("unusable");
    expect(r.reasons.join()).toMatch(/wrong chainId 56/);
    expect(calls.map((c) => c.method)).toEqual(["eth_chainId"]);
  });

  it("429 in the burst → degraded, counted, latency percentiles computed", async () => {
    const r = await probeEndpoint(
      fake({ burst: (i) => (i % 4 === 3 ? err("Too Many Requests", { httpStatus: 429 }) : ok(hex(LATEST), 40 + i)) }).rpc,
      "https://bsc-testnet.ex-j.io",
      quick,
    );
    expect(r.burst.calls).toBe(20);
    expect(r.burst.http429).toBe(5);
    expect(r.burst.ok).toBe(15);
    expect(r.burst.p50Ms).not.toBeNull();
    expect(r.burst.p95Ms! >= r.burst.p50Ms!).toBe(true);
    expect(r.classification).toBe("degraded");
    expect(r.reasons.join()).toMatch(/429×5/);
  });

  it("-32005 JSON-RPC error codes in the burst are counted by code", async () => {
    const r = await probeEndpoint(fake({ burst: (i) => (i < 2 ? err("limit exceeded", { code: -32005 }) : ok(hex(LATEST))) }).rpc, "https://bsc-testnet.ex-k.io", quick);
    expect(r.burst.rpcErrorCodes["-32005"]).toBe(2);
    expect(r.classification).toBe("degraded");
  });

  it("refuses denied hosts / mainnet / non-testnet without calling the transport", async () => {
    for (const url of ["http://101.32.1.1:8545", "http://172.237.84.150:8545", "http://10.0.0.20:8545", "https://bsc-dataseed.bnbchain.org", "https://rpc.wantos.io", "https://eth.llamarpc.com"]) {
      const { rpc, calls } = fake();
      const r = await probeEndpoint(rpc, url, quick);
      expect(r.classification).toBe("unusable");
      expect(calls).toHaveLength(0);
      expect(() => assertAllowedUrl(url)).toThrow();
    }
  });

  it("only ever issues read-only methods", async () => {
    const { rpc, calls } = fake();
    await probeEndpoint(rpc, "https://bsc-testnet.ex-l.io", quick);
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs"]));
    const tags = calls.filter((c) => c.method === "eth_getBlockByNumber").map((c) => c.params[0]);
    expect(new Set(tags)).toEqual(new Set(["finalized", "safe"]));
  });

  it("headSnapshot takes one eth_blockNumber per chain-97 endpoint only", async () => {
    const a = await probeEndpoint(fake().rpc, "https://bsc-testnet.ex-o.io", quick);
    const w = await probeEndpoint(fake({ chainId: 56 }).rpc, "https://bsc-testnet.ex-p.io", quick);
    const { rpc, calls } = fake();
    const heads = await headSnapshot(rpc, [a, w]);
    expect(heads).toEqual({ [a.url]: LATEST });
    expect(calls.map((c) => c.method)).toEqual(["eth_blockNumber"]);
  });

  it("crossCheck flags an endpoint lagging far behind the best head", async () => {
    const a = await probeEndpoint(fake().rpc, "https://bsc-testnet.ex-m.io", quick);
    const b = await probeEndpoint(fake().rpc, "https://bsc-testnet.ex-n.io", quick);
    crossCheck([a, b], { [a.url]: LATEST, [b.url]: LATEST - 500 });
    expect(a.classification).toBe("usable");
    expect(b.headSkew).toBe(500);
    expect(b.classification).toBe("degraded");
  });
});

describe("recommendation", () => {
  async function mk(url: string, logLimit: number, latency = 50): Promise<EndpointReport> {
    return probeEndpoint(fake({ logLimit, latency, burst: () => ok(hex(LATEST), latency) }).rpc, url, quick);
  }

  it("provider family dedupes bnbchain seeds", () => {
    expect(providerFamily("https://data-seed-prebsc-1-s1.bnbchain.org:8545")).toBe(providerFamily("https://data-seed-prebsc-2-s1.bnbchain.org:8545"));
    expect(providerFamily("https://bsc-testnet-rpc.publicnode.com")).toBe("publicnode.com");
  });

  it("picks ≥ 3 distinct providers, min range, env-only relayer + watcher snippets", async () => {
    const reports = [
      await mk("https://data-seed-prebsc-1-s1.bnbchain.org:8545", 5000, 30),
      await mk("https://data-seed-prebsc-2-s1.bnbchain.org:8545", 5000, 20),
      await mk("https://bsc-testnet-rpc.publicnode.com", 2000, 60),
      await mk("https://bsc-testnet.drpc.org", 1000, 80),
      await probeEndpoint(fake({ finalized: "unsupported" }).rpc, "https://bsc-testnet.public.blastapi.io", quick),
    ];
    crossCheck(reports, Object.fromEntries(reports.map((r) => [r.url, LATEST])));
    const rec = recommend(reports);
    expect(rec.ok).toBe(true);
    expect(rec.selected).toHaveLength(3);
    expect(new Set(rec.selected.map((s) => s.family)).size).toBe(3);
    expect(rec.selected[0]?.url).toBe("https://data-seed-prebsc-2-s1.bnbchain.org:8545"); // fastest of the bnbchain pair
    expect(rec.selected.some((s) => s.url.includes("blastapi"))).toBe(false); // degraded excluded
    expect(rec.maxBlockRange).toBe(1000);
    expect(rec.minRpcAgreement).toBe(2);
    expect(rec.relayer.bsc).toEqual({ chainId: 97, rpcUrlEnvs: ["BSC_TESTNET_RPC_1", "BSC_TESTNET_RPC_2", "BSC_TESTNET_RPC_3"] });
    expect(JSON.stringify(rec.relayer)).not.toMatch(/https?:/);
    expect(rec.relayerEnv["BSC_TESTNET_RPC_3"]).toBe("https://bsc-testnet.drpc.org");
    expect(rec.watcher.chains.bsc).toMatchObject({ chainId: 97, head: { kind: "finalized" }, maxBlockRange: 1000 });
    expect(rec.watcher.chains.bsc.rpcUrls).toHaveLength(3);
    expect(rec.watcher.minRpcAgreement).toBe(2);
    const seed = await probeEndpoint(fake({ logLimit: 0, logsError: () => err("limit exceeded", { code: -32005 }) }).rpc, "https://data-seed-prebsc-1-s2.bnbchain.org:8545", quick);
    expect(recommend([...reports, seed]).headOnly).toEqual([seed.url]);
  });

  it("caps maxBlockRange when all endpoints accept the top rung", async () => {
    const reports = [await mk("https://a.bsc-testnet-x.io", 1e9), await mk("https://bsc-testnet.y.org", 1e9), await mk("https://bsc-testnet.z.net", 1e9)];
    expect(recommend(reports).maxBlockRange).toBe(5000);
  });

  it("fewer than 3 independent usable providers → flagged", async () => {
    const reports = [
      await mk("https://data-seed-prebsc-1-s1.bnbchain.org:8545", 5000),
      await mk("https://data-seed-prebsc-2-s1.bnbchain.org:8545", 5000),
      await mk("https://bsc-testnet-rpc.publicnode.com", 2000),
      await probeEndpoint(fake({ chainId: 1 }).rpc, "https://bsc-testnet.drpc.org", quick),
    ];
    const rec = recommend(reports);
    expect(rec.ok).toBe(false);
    expect(rec.selected).toHaveLength(2);
    expect(rec.problems[0]).toMatch(/only 2 usable independent provider/);
    expect(rec.headOnly).toEqual([]);
  });
});

describe("endpoints", () => {
  it("≥ 6 default candidates from ≥ 6 providers, all pass the URL guard", () => {
    const list = candidateEndpoints({});
    expect(list.length).toBeGreaterThanOrEqual(6);
    expect(new Set(list.map(providerFamily)).size).toBeGreaterThanOrEqual(6);
    for (const u of list) expect(() => assertAllowedUrl(u)).not.toThrow();
  });

  it("allows a 97.<host> chain-id host but not other bare hosts", () => {
    expect(() => assertAllowedUrl("https://97.rpc.thirdweb.com")).not.toThrow();
    expect(() => assertAllowedUrl("https://56.rpc.thirdweb.com")).toThrow();
  });

  it("BSC_TESTNET_RPCS overrides (comma list, deduped)", () => {
    expect(candidateEndpoints({ BSC_TESTNET_RPCS: " https://a.bsc-testnet.io , https://b.bsc-testnet.io,https://a.bsc-testnet.io" })).toEqual([
      "https://a.bsc-testnet.io",
      "https://b.bsc-testnet.io",
    ]);
  });
});
