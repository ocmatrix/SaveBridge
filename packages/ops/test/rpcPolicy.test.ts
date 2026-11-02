import { describe, expect, it } from "vitest";
import { createPublicClient, custom, type Transport } from "viem";
import {
  assertWriteEndpoint,
  checkIndependence,
  guardedTransport,
  independentGroups,
  isReadOnlyHost,
  normalizeHost,
  rpcTransport,
  READ_ONLY_RPC_HOSTS,
  RpcPolicyError,
} from "../src/rpcPolicy";

/** Records every request that would reach the network: method + target host. */
function recorder(url: string, log: Array<{ host: string; method: string }>, fail?: () => Error | undefined): Transport {
  return custom({
    async request({ method }: { method: string }) {
      log.push({ host: new URL(url).hostname, method });
      const e = fail?.();
      if (e) throw e;
      if (method === "eth_chainId") return "0x34f3";
      if (method === "eth_blockNumber") return "0x10";
      if (method === "eth_sendRawTransaction") return "0x" + "ab".repeat(32);
      return null;
    },
  }, { retryCount: 0 });
}

describe("host normalisation and read-only hosts", () => {
  it("normalises case, ports, trailing dots and loopback forms", () => {
    expect(normalizeHost("https://RPC.wantos.io.:443/x")).toBe("rpc.wantos.io");
    expect(normalizeHost("http://127.0.0.1:8545")).toBe("loopback");
    expect(normalizeHost("http://localhost:8545")).toBe("loopback");
    expect(normalizeHost("http://[::1]:8545")).toBe("loopback");
    expect(() => normalizeHost("ws://x")).toThrow(/scheme/);
    expect(() => normalizeHost("not a url")).toThrow(/not a valid URL/);
  });

  it("rpc1 / rpc2 are read-only (exact or sub-domain), rpc3 is not", () => {
    expect(READ_ONLY_RPC_HOSTS).toEqual(["rpc.wantos.io", "rpc2.wantos.io"]);
    expect(isReadOnlyHost("https://rpc.wantos.io")).toBe(true);
    expect(isReadOnlyHost("https://RPC2.WANTOS.IO/abc")).toBe(true);
    expect(isReadOnlyHost("https://x.rpc2.wantos.io")).toBe(true);
    expect(isReadOnlyHost("https://rpc3.wantos.io")).toBe(false);
    expect(isReadOnlyHost("http://127.0.0.1:8545")).toBe(false);
    expect(isReadOnlyHost("http://10.0.0.9:8545", ["10.0.0.9"])).toBe(true);
  });

  it("write endpoints pointing at rpc1/rpc2 refuse to start", () => {
    expect(() => assertWriteEndpoint("https://rpc.wantos.io", "wantos write")).toThrow(/read-only host/);
    expect(() => assertWriteEndpoint("https://rpc2.wantos.io:8545", "wantos write")).toThrow(/read-only host/);
    expect(() => assertWriteEndpoint("https://rpc3.wantos.io", "wantos write")).not.toThrow();
  });
});

describe("independence (same node never counts twice, minAgree never lowered)", () => {
  const rpc3Local = { label: "WANTOS_RPC_LOCAL", url: "http://127.0.0.1:8545", node: "rpc3" };
  const rpc3Public = { label: "WANTOS_RPC3_PUBLIC", url: "https://rpc3.wantos.io", node: "rpc3" };
  const rpc1 = { label: "WANTOS_RPC1", url: "https://rpc.wantos.io" };
  const rpc2 = { label: "WANTOS_RPC2", url: "https://rpc2.wantos.io" };

  it("rpc3 local + rpc3 public are ONE source; with rpc1 + rpc2 there are 3", () => {
    expect(independentGroups([rpc3Local, rpc3Public])).toEqual([["WANTOS_RPC_LOCAL", "WANTOS_RPC3_PUBLIC"]]);
    const r = checkIndependence({ chain: "wantos", sources: [rpc3Local, rpc3Public, rpc1, rpc2], required: 2, recommended: 3 });
    expect(r.distinct).toBe(3);
    expect(r.warnings.join()).toMatch(/same node/);
  });

  it("refuses when distinct sources < required (no silent downgrade)", () => {
    expect(() => checkIndependence({ chain: "wantos", sources: [rpc3Local, rpc3Public], required: 2 })).toThrow(/only 1 independent/);
    expect(() =>
      checkIndependence({ chain: "bsc", sources: [{ label: "A", url: "https://bsc.example.com/k1" }, { label: "B", url: "https://BSC.example.com/k2" }], required: 2 }),
    ).toThrow(/only 1 independent/);
  });

  it("same host on different ports is the same node; unlabeled loopback is refused", () => {
    expect(independentGroups([{ label: "a", url: "http://1.2.3.4:8545" }, { label: "b", url: "http://1.2.3.4:8546" }])).toHaveLength(1);
    expect(() => independentGroups([{ label: "a", url: "http://127.0.0.1:8545" }])).toThrow(/explicit node label/);
    expect(independentGroups([{ label: "a", url: "http://127.0.0.1:1", node: "x" }, { label: "b", url: "http://127.0.0.1:2", node: "y" }])).toHaveLength(2);
  });

  it("warns below the design's 3 sources while still meeting minAgree", () => {
    const r = checkIndependence({ chain: "wantos", sources: [rpc3Local, rpc1], required: 2, recommended: 3 });
    expect(r.distinct).toBe(2);
    expect(r.warnings.join()).toMatch(/design requires 3/);
  });
});

describe("guarded transport", () => {
  it("never lets a write method reach rpc1/rpc2; write role on them is refused at construction", async () => {
    const log: Array<{ host: string; method: string }> = [];
    for (const url of ["https://rpc.wantos.io", "https://rpc2.wantos.io"]) {
      const c = createPublicClient({ transport: guardedTransport(recorder(url, log), { url, role: "read" }) });
      await expect(c.request({ method: "eth_sendRawTransaction", params: ["0x01"] } as never)).rejects.toThrow(RpcPolicyError);
      await expect(c.request({ method: "eth_sendTransaction", params: [{}] } as never)).rejects.toThrow(/refused/);
      await expect(c.request({ method: "debug_traceTransaction", params: ["0x"] } as never)).rejects.toThrow(/refused on read-only host/);
      expect(await c.getChainId()).toBe(0x34f3);
      expect(() => guardedTransport(recorder(url, log), { url, role: "write" })).toThrow(/read-only host/);
    }
    const writes = log.filter((l) => l.method.startsWith("eth_send"));
    expect(writes).toEqual([]);
    expect(log.map((l) => l.method)).toEqual(["eth_chainId", "eth_chainId"]);
  });

  it("a write endpoint on rpc3 forwards eth_sendRawTransaction; a read endpoint on rpc3 refuses it", async () => {
    const log: Array<{ host: string; method: string }> = [];
    const url = "https://rpc3.wantos.io";
    const w = createPublicClient({ transport: guardedTransport(recorder(url, log), { url, role: "write" }) });
    await w.request({ method: "eth_sendRawTransaction", params: ["0x01"] } as never);
    const r = createPublicClient({ transport: guardedTransport(recorder(url, log), { url, role: "read" }) });
    await expect(r.request({ method: "eth_sendRawTransaction", params: ["0x01"] } as never)).rejects.toThrow(/refused on read endpoint/);
    await r.request({ method: "debug_traceTransaction", params: [] } as never); // non-external read endpoint: only writes are blocked
    expect(log).toEqual([
      { host: "rpc3.wantos.io", method: "eth_sendRawTransaction" },
      { host: "rpc3.wantos.io", method: "debug_traceTransaction" },
    ]);
  });

  it("limits eth_getLogs windows towards read-only hosts", async () => {
    const log: Array<{ host: string; method: string }> = [];
    const url = "https://rpc.wantos.io";
    const c = createPublicClient({ transport: guardedTransport(recorder(url, log), { url, role: "read", maxLogsBlockRange: 100 }) });
    await c.request({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x64" }] } as never);
    await expect(c.request({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x65" }] } as never)).rejects.toThrow(/within 100 blocks/);
    await expect(c.request({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "latest" }] } as never)).rejects.toThrow(/numeric/);
    await expect(c.request({ method: "eth_getLogs", params: [{ fromBlock: "0x9", toBlock: "0x1" }] } as never)).rejects.toThrow(/numeric/);
    await c.request({ method: "eth_getLogs", params: [{ blockHash: "0x" + "00".repeat(32) }] } as never);
    expect(log.filter((l) => l.method === "eth_getLogs")).toHaveLength(2);
  });

  it("enforces a per-host request budget (token bucket) without touching the network", async () => {
    let now = 0;
    const log: Array<{ host: string; method: string }> = [];
    const events: string[] = [];
    const url = "https://rpc2.wantos.io";
    const c = createPublicClient({ transport: guardedTransport(recorder(url, log), { url, role: "read", budget: { maxPerMinute: 60, burst: 2 }, now: () => now, onEvent: (e) => events.push(e.event) }) });
    await c.request({ method: "eth_blockNumber" } as never);
    await c.request({ method: "eth_blockNumber" } as never);
    await expect(c.request({ method: "eth_blockNumber" } as never)).rejects.toThrow(/budget exhausted/);
    expect(log).toHaveLength(2);
    now = 1000; // 60/min → one token per second
    await c.request({ method: "eth_blockNumber" } as never);
    expect(log).toHaveLength(3);
    expect(events).toContain("budget");
  });

  it("backs off exponentially after transport failures (fail fast while cooling), resets on success; reverts do not back off", async () => {
    let now = 0;
    let failing = true;
    const log: Array<{ host: string; method: string }> = [];
    const url = "https://rpc.wantos.io";
    const c = createPublicClient({
      transport: guardedTransport(recorder(url, log, () => (failing ? new Error("HTTP 429") : undefined)), { url, role: "read", backoff: { baseMs: 1000, maxMs: 4000 }, budget: { maxPerMinute: 6000, burst: 100 }, now: () => now }),
    });
    await expect(c.request({ method: "eth_blockNumber" } as never)).rejects.toThrow(/429/);
    await expect(c.request({ method: "eth_blockNumber" } as never)).rejects.toThrow(/cooling down/);
    expect(log).toHaveLength(1);
    now = 1000;
    await expect(c.request({ method: "eth_blockNumber" } as never)).rejects.toThrow(/429/); // 2nd failure → 2 s
    now = 2999;
    await expect(c.request({ method: "eth_blockNumber" } as never)).rejects.toThrow(/cooling/);
    now = 3000;
    await expect(c.request({ method: "eth_blockNumber" } as never)).rejects.toThrow(/429/); // 3rd → 4 s
    now = 6999;
    await expect(c.request({ method: "eth_blockNumber" } as never)).rejects.toThrow(/cooling/);
    now = 7000;
    await expect(c.request({ method: "eth_blockNumber" } as never)).rejects.toThrow(/429/); // 4th → capped 4 s
    now = 11_000;
    failing = false;
    await c.request({ method: "eth_blockNumber" } as never);
    failing = true;
    await expect(c.request({ method: "eth_blockNumber" } as never)).rejects.toThrow(/429/); // reset → 1 s
    now = 12_000;
    failing = false;
    await c.request({ method: "eth_blockNumber" } as never);
    expect(log).toHaveLength(7);

    const revertLog: Array<{ host: string; method: string }> = [];
    const r = createPublicClient({ transport: guardedTransport(recorder(url, revertLog, () => Object.assign(new Error("execution reverted"), { code: 3 })), { url, role: "read", now: () => now }) });
    await expect(r.request({ method: "eth_call", params: [{}, "latest"] } as never)).rejects.toThrow(/revert/);
    await expect(r.request({ method: "eth_call", params: [{}, "latest"] } as never)).rejects.toThrow(/revert/);
    expect(revertLog).toHaveLength(2);
  });

  it("rpcTransport builds a guarded http transport", () => {
    expect(() => rpcTransport("https://rpc.wantos.io", { role: "write" })).toThrow(/read-only/);
    expect(typeof rpcTransport("https://rpc3.wantos.io", { role: "write" })).toBe("function");
  });
});
