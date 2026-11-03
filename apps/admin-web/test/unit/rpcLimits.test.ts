/**
 * rpc3's limits: eth_getLogs ranges of at most 100 blocks, and single parallel requests answered with 429
 * (JSON-RPC batches are fine). The page and the submit function must respect both.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeAbiParameters, getAddress, pad, toFunctionSelector, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseConfig } from "../../src/lib/config";
import { LOG_PARALLEL, LOG_RETRIES, scanLogs } from "../../src/lib/whitelist";
import { batchTypedData } from "../../src/lib/normalize";
import { CHAIN_FAILED, errorLine, READ_BATCH, submitWhitelist, type SubmitEnv } from "../../functions/_lib/submit";

const BRIDGE = "0x41e9900BF09553C46b6b3F267626FDa2b4711E44";
const baseEnv = {
  VITE_BSC_CHAIN_ID: "56",
  VITE_BSC_RPC_URL: "https://bsc.example.com",
  VITE_BSC_BRIDGE: BRIDGE,
  VITE_WANTOS_CHAIN_ID: "13555",
  VITE_WANTOS_RPC_URL: "https://rpc3.example.com",
  VITE_WANTOS_BRIDGE: BRIDGE,
};

describe("config: eth_getLogs step per chain", () => {
  it("WANTOS defaults to the node's 100-block cap, BSC to a wide step; an override applies", () => {
    const c = parseConfig(baseEnv);
    expect(c.wantos.logStep).toBe(100n);
    expect(c.bsc.logStep).toBe(50_000n);
    expect(parseConfig({ ...baseEnv, VITE_WANTOS_LOG_STEP: "50" }).wantos.logStep).toBe(50n);
  });
  it("an invalid step is rejected", () => {
    expect(() => parseConfig({ ...baseEnv, VITE_WANTOS_LOG_STEP: "0" })).toThrow();
    expect(() => parseConfig({ ...baseEnv, VITE_WANTOS_LOG_STEP: "abc" })).toThrow();
  });
});

describe("scanLogs", () => {
  const fake = (latest: bigint, ranges: Array<[bigint, bigint]>) => ({
    getBlockNumber: async () => latest,
    getLogs: async (a: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([a.fromBlock, a.toBlock]);
      return [];
    },
  });
  const ctx = (client: unknown, cfg: Record<string, unknown>) => ({ client, cfg: { bridge: BRIDGE, ...cfg } }) as unknown as Parameters<typeof scanLogs>[0];

  it("never asks for more than the chain's step and covers every block exactly once", async () => {
    const ranges: Array<[bigint, bigint]> = [];
    await scanLogs(ctx(fake(1000n, ranges), { fromBlock: 0n, logStep: 100n }), { type: "event", name: "X", inputs: [] });
    expect(ranges.length).toBe(11);
    for (const [from, to] of ranges) expect(to - from + 1n).toBeLessThanOrEqual(100n);
    expect(ranges[0]![0]).toBe(0n);
    expect(ranges[ranges.length - 1]![1]).toBe(1000n);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]![0]).toBe(ranges[i - 1]![1] + 1n);
  });

  it("without a configured step it keeps the generic wide step", async () => {
    const ranges: Array<[bigint, bigint]> = [];
    await scanLogs(ctx(fake(60_000n, ranges), { fromBlock: 0n }), { type: "event", name: "X", inputs: [] });
    expect(ranges.length).toBe(2);
  });

  it("several scans started together share one concurrency limit per RPC endpoint (rpc3: 8 heavy reads per client)", async () => {
    let active = 0;
    let peak = 0;
    const client = {
      getBlockNumber: async () => 5_000n,
      getLogs: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return [];
      },
    };
    const c = ctx(client, { fromBlock: 0n, logStep: 100n, rpcUrl: "https://rpc3.example.com" }); // 50 ranges per scan
    const ev = { type: "event", name: "X", inputs: [] } as const;
    await Promise.all([scanLogs(c, ev), scanLogs(c, ev), scanLogs(c, ev), scanLogs(c, ev)]); // 200 requests in total
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(LOG_PARALLEL);
  });

  it("the results of every range come back, in order, even when scans share the limit", async () => {
    const client = { getBlockNumber: async () => 999n, getLogs: async (a: { fromBlock: bigint }) => [{ block: a.fromBlock }] };
    const c = ctx(client, { fromBlock: 0n, logStep: 100n, rpcUrl: "https://rpc3.example.com" });
    const [a, b] = await Promise.all([scanLogs(c, { type: "event", name: "X", inputs: [] }), scanLogs(c, { type: "event", name: "X", inputs: [] })]);
    const expected = Array.from({ length: 10 }, (_, i) => ({ block: BigInt(i) * 100n }));
    expect(a).toEqual(expected);
    expect(b).toEqual(expected);
  });

  const lag = 'Missing or invalid parameters. Details: failed to fetch header by number (latest): failed to get rpc block from comet block: failed to get receipts from comet block: tx not found: hash=0xabc';
  const oneRange = (getLogs: () => Promise<unknown[]>) => ctx({ getBlockNumber: async () => 50n, getLogs }, { fromBlock: 0n, logStep: 100n, rpcUrl: "https://rpc3.example.com" });

  it("retries the node's transient 'tx not found' (indexer one block behind) and returns the logs", async () => {
    let calls = 0;
    const c = oneRange(async () => {
      if (++calls < 3) throw new Error(lag);
      return [{ ok: true }];
    });
    expect(await scanLogs(c, { type: "event", name: "X", inputs: [] })).toEqual([{ ok: true }]);
    expect(calls).toBe(3);
  }, 15_000);

  it("does not retry other errors, and gives up after the retry limit", async () => {
    let other = 0;
    await expect(scanLogs(oneRange(async () => { other++; throw new Error("execution reverted"); }), { type: "event", name: "X", inputs: [] })).rejects.toThrow("execution reverted");
    expect(other).toBe(1);
    let always = 0;
    await expect(scanLogs(oneRange(async () => { always++; throw new Error(lag); }), { type: "event", name: "X", inputs: [] })).rejects.toThrow("tx not found");
    expect(always).toBe(LOG_RETRIES + 1);
  }, 30_000);
});

describe("submit: per-address reads go out as JSON-RPC batches", () => {
  const manager = privateKeyToAccount(generatePrivateKey());
  let server: Server;
  let url = "";
  const stats = { batches: 0, singles: 0, calls: 0 };
  const word = (b: boolean): Hex => pad(b ? "0x01" : "0x00", { size: 32 });
  const answer = (c: { method: string; params?: Array<{ data?: string }> }): Hex => {
    const data = c.params?.[0]?.data ?? "0x";
    if (data.startsWith(toFunctionSelector("function whitelistManager()"))) return encodeAbiParameters([{ type: "address" }], [manager.address]);
    if (data.startsWith(toFunctionSelector("function whitelisted(address)"))) return word(true); // already whitelisted → nothing to send
    throw new Error(`unexpected call ${c.method} ${data.slice(0, 10)}`);
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw) as unknown;
        res.setHeader("content-type", "application/json");
        if (!Array.isArray(body)) {
          stats.singles++; // rpc3 rate-limits single requests
          res.statusCode = 429;
          res.end('{"error":"too many requests"}');
          return;
        }
        stats.batches++;
        stats.calls += body.length;
        res.end(JSON.stringify(body.map((c: { id: number; method: string; params?: Array<{ data?: string }> }) => ({ jsonrpc: "2.0", id: c.id, result: answer(c) }))));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  it("a 45-address batch is checked with a handful of batch requests and no single request", async () => {
    const list: Address[] = Array.from({ length: 45 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`));
    const nowS = 1_800_000_000n;
    const deadline = nowS + 3600n;
    const signature = await manager.signTypedData(batchTypedData({ side: "bsc", chainId: 56, bridge: BRIDGE, addresses: list, allowed: true, nonce: 2n, deadline }) as Parameters<typeof manager.signTypedData>[0]);
    const env: SubmitEnv = { BRIDGE, BSC_CHAIN_ID: "56", BSC_RPC_URL: url, WANTOS_CHAIN_ID: "13555", WANTOS_RPC_URL: url, SUBMITTER_KEY: generatePrivateKey() };
    const r = await submitWhitelist(env, { addresses: list, allowed: true, nonce: "2", deadline: String(deadline), signature }, () => Number(nowS) * 1000);
    expect(r.json.error).toBeUndefined();
    expect(r.status).toBe(200);
    expect(r.json.runs!.bsc.status).toBe("skipped");
    expect(r.json.runs!.wantos.status).toBe("skipped");
    expect(stats.singles).toBe(0);
    // per chain: 1 whitelistManager + 45 reads, in batches of at most READ_BATCH
    expect(stats.calls).toBe(2 * (1 + 45));
    expect(stats.batches).toBeLessThanOrEqual(2 * (Math.ceil(46 / READ_BATCH) + 1));
  });
});

describe("errorLine", () => {
  it("keeps the headline, Status and Details, and drops the URL and the request body", () => {
    const e = new Error('HTTP request failed.\n\nStatus: 429\nURL: https://rpc3.example.com/secret\nRequest body: {"method":"eth_call"}\n\nDetails: too many requests\nVersion: viem@2');
    const t = errorLine(e);
    expect(t).toContain("HTTP request failed.");
    expect(t).toContain("Status: 429");
    expect(t).toContain("Details: too many requests");
    expect(t).not.toContain("secret");
    expect(t).not.toContain("Request body");
  });
});

describe("submit: a chain failure is answered with a status Cloudflare does not replace", () => {
  const manager = privateKeyToAccount(generatePrivateKey());
  let server: Server;
  let url = "";
  let mode: "revert" | "down" = "revert";
  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (mode === "down") {
          res.statusCode = 500;
          res.end("down");
          return;
        }
        const calls = JSON.parse(raw) as Array<{ id: number; method: string; params?: Array<{ data?: string }> }> | { id: number; method: string; params?: Array<{ data?: string }> };
        const one = (c: { id: number; method: string; params?: Array<{ data?: string }> }) => {
          const data = c.params?.[0]?.data ?? "0x";
          if (data.startsWith(toFunctionSelector("function whitelistManager()"))) return { jsonrpc: "2.0", id: c.id, result: encodeAbiParameters([{ type: "address" }], [manager.address]) };
          if (data.startsWith(toFunctionSelector("function whitelisted(address)"))) return { jsonrpc: "2.0", id: c.id, result: pad("0x00", { size: 32 }) };
          if (data.startsWith(toFunctionSelector("function whitelistNonce()"))) return { jsonrpc: "2.0", id: c.id, result: pad("0x02", { size: 32 }) };
          return { jsonrpc: "2.0", id: c.id, error: { code: 3, message: "execution reverted: BadNonce", data: "0x" } }; // the simulation of applyWhitelistBatch
        };
        res.end(JSON.stringify(Array.isArray(calls) ? calls.map(one) : one(calls)));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  const attempt = async () => {
    const list: Address[] = [getAddress("0x0000000000000000000000000000000000000abc")];
    const nowS = 1_800_000_000n;
    const deadline = nowS + 3600n;
    const signature = await manager.signTypedData(batchTypedData({ side: "bsc", chainId: 56, bridge: BRIDGE, addresses: list, allowed: true, nonce: 2n, deadline }) as Parameters<typeof manager.signTypedData>[0]);
    const env: SubmitEnv = { BRIDGE, BSC_CHAIN_ID: "56", BSC_RPC_URL: url, WANTOS_CHAIN_ID: "13555", WANTOS_RPC_URL: url, SUBMITTER_KEY: generatePrivateKey() };
    return submitWhitelist(env, { addresses: list, allowed: true, nonce: "2", deadline: String(deadline), signature }, () => Number(nowS) * 1000);
  };

  it("a failing simulation returns 424 with the reason and the per-chain runs, never 502", async () => {
    mode = "revert";
    const r = await attempt();
    expect(r.status).toBe(CHAIN_FAILED);
    expect([502, 503, 504]).not.toContain(r.status);
    expect(r.json.error).toContain("BSC");
    expect(r.json.error).toContain("BadNonce");
    expect(r.json.runs!.bsc.status).toBe("failed");
  });

  it("an unreachable RPC also returns 424, never 503", async () => {
    mode = "down";
    const r = await attempt();
    expect(r.status).toBe(CHAIN_FAILED);
    expect(r.json.ok).toBe(false);
  });
});
