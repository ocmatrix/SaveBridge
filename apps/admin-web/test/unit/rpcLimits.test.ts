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
import { scanLogs } from "../../src/lib/whitelist";
import { batchTypedData } from "../../src/lib/normalize";
import { errorLine, READ_BATCH, submitWhitelist, type SubmitEnv } from "../../functions/_lib/submit";

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
