/**
 * RPC endpoint policy (deploy-prep).
 *
 * 1. Independence: URLs pointing at the same node (same host, or the same declared `node` label — e.g.
 *    rpc3's 127.0.0.1 and its public name) count as ONE source. A chain with fewer distinct sources
 *    than required refuses to start; minAgree is never lowered to fit.
 * 2. Read / write split: the user authorised rpc.wantos.io (rpc1) and rpc2.wantos.io as READ-ONLY
 *    WANTOS cross-check sources. They may never be a write endpoint (startup check), and the transport
 *    guard refuses every non-read JSON-RPC method towards them before any network I/O.
 * 3. Politeness towards those external read-only nodes: per-host request budget (token bucket), small
 *    getLogs windows, exponential back-off after failures (fail fast while cooling: "one vote less",
 *    never a retry storm), no transport-level retries.
 */
import { http, type Transport } from "viem";

/** Hosts that may only ever be READ from (user authorisation 2026-11-02: read-only cross-check). */
export const READ_ONLY_RPC_HOSTS: readonly string[] = Object.freeze(["rpc.wantos.io", "rpc2.wantos.io"]);

/** JSON-RPC methods allowed towards read-only hosts (deny by default). */
export const READ_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getLogs",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_gasPrice",
  "eth_feeHistory",
  "eth_maxPriorityFeePerGas",
  "eth_estimateGas",
]);

/** Methods that move state / touch keys. Refused on every "read" endpoint. */
export const WRITE_METHODS: ReadonlySet<string> = new Set([
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "eth_sign",
  "eth_signTransaction",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "personal_sign",
  "personal_sendTransaction",
  "eth_sendRawTransactionConditional",
  "eth_sendBundle",
]);

export class RpcPolicyError extends Error {
  constructor(message: string) {
    super(`rpc policy: ${message}`);
    this.name = "RpcPolicyError";
  }
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|0:0:0:0:0:0:0:1)$/;

/** Lower-cased host without port / brackets / trailing dot; every loopback form maps to "loopback". */
export function normalizeHost(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new RpcPolicyError("an RPC URL is not a valid URL (value not shown)");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new RpcPolicyError(`unsupported RPC scheme ${u.protocol}`);
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return LOOPBACK.test(h) ? "loopback" : h;
}

export function isReadOnlyHost(url: string, extra: readonly string[] = []): boolean {
  const h = normalizeHost(url);
  return [...READ_ONLY_RPC_HOSTS, ...extra].some((r) => h === r.toLowerCase() || h.endsWith(`.${r.toLowerCase()}`));
}

/** Startup check for every endpoint that will broadcast transactions. */
export function assertWriteEndpoint(url: string, what: string, extraReadOnly: readonly string[] = []): void {
  if (isReadOnlyHost(url, extraReadOnly)) throw new RpcPolicyError(`${what} points at a read-only host (${normalizeHost(url)}); writes must go to rpc3 / the chain's own write endpoint`);
}

export interface RpcSource {
  /** Diagnostic label (env var name or "bsc#0"); never the URL. */
  label: string;
  url: string;
  /** Explicit node identity; URLs with the same label are one source. Required for loopback URLs. */
  node?: string;
}

/** Union of "same host" and "same node label" → groups of labels that are ONE independent source. */
export function independentGroups(sources: readonly RpcSource[]): string[][] {
  const parent = sources.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const keys = sources.map((s) => {
    const h = normalizeHost(s.url);
    if (h === "loopback" && !s.node) throw new RpcPolicyError(`${s.label}: a loopback URL needs an explicit node label (e.g. "rpc3")`);
    return { h, n: s.node?.toLowerCase() };
  });
  for (let i = 0; i < sources.length; i++)
    for (let j = 0; j < i; j++) {
      const a = keys[i]!, b = keys[j]!;
      const sameHost = a.h !== "loopback" && a.h === b.h;
      const sameNode = a.n !== undefined && a.n === b.n;
      if (sameHost || sameNode) parent[find(i)] = find(j);
    }
  const groups = new Map<number, string[]>();
  sources.forEach((s, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), s.label]));
  return [...groups.values()];
}

/**
 * Throws when a chain has fewer than `required` distinct sources (never lowers it). Returns warnings for
 * duplicates and for fewer than `recommended` distinct sources (design: ≥ 3 per chain).
 */
export function checkIndependence(o: { chain: string; sources: readonly RpcSource[]; required: number; recommended?: number }): { distinct: number; warnings: string[] } {
  const groups = independentGroups(o.sources);
  const warnings: string[] = [];
  for (const g of groups) if (g.length > 1) warnings.push(`${o.chain}: ${g.join(" + ")} are the same node and count as ONE source`);
  if (groups.length < o.required)
    throw new RpcPolicyError(`${o.chain}: only ${groups.length} independent RPC source(s) (need ${o.required}); same-host / same-node URLs are not independent`);
  if (o.recommended !== undefined && groups.length < o.recommended)
    warnings.push(`${o.chain}: ${groups.length} independent RPC sources, design requires ${o.recommended}`);
  return { distinct: groups.length, warnings };
}

export type EndpointRole = "read" | "write";

export interface GuardOptions {
  url: string;
  role: EndpointRole;
  extraReadOnlyHosts?: readonly string[];
  /** External read-only hosts: requests per minute per process (default 120) and burst (default 20). */
  budget?: { maxPerMinute: number; burst: number };
  /** Back-off after a transport failure: base, doubling, capped (defaults 2 s → 5 min). */
  backoff?: { baseMs: number; maxMs: number };
  /** eth_getLogs block window allowed towards read-only hosts (default 500). */
  maxLogsBlockRange?: number;
  now?: () => number;
  onEvent?: (e: { host: string; event: "refused" | "budget" | "cooling" | "failure"; method: string; detail?: string }) => void;
}

const hexNum = (v: unknown): bigint | null => (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null);

/** True for a JSON-RPC execution error (revert): the node answered, so no back-off. */
const isExecutionError = (e: unknown): boolean => {
  const err = e as { code?: number; cause?: { code?: number }; message?: string };
  const code = err?.code ?? err?.cause?.code;
  return code === 3 || code === -32015 || /revert/i.test(err?.message ?? "");
};

/**
 * Wraps a viem transport. Write methods on a "read" endpoint, non-read methods on a read-only host,
 * oversized getLogs and calls over budget / while cooling are refused locally (no network I/O).
 */
export function guardedTransport(inner: Transport, o: GuardOptions): Transport {
  const host = normalizeHost(o.url);
  const readOnly = isReadOnlyHost(o.url, o.extraReadOnlyHosts);
  if (readOnly && o.role === "write") throw new RpcPolicyError(`write endpoint on read-only host ${host}`);
  const now = o.now ?? Date.now;
  const budget = o.budget ?? { maxPerMinute: 120, burst: 20 };
  const backoff = o.backoff ?? { baseMs: 2_000, maxMs: 300_000 };
  const maxRange = BigInt(o.maxLogsBlockRange ?? 500);
  let tokens = budget.burst;
  let refilledAt = now();
  let fails = 0;
  let coolUntil = 0;
  const ev = (event: "refused" | "budget" | "cooling" | "failure", method: string, detail?: string) => o.onEvent?.({ host, event, method, detail });

  const admit = (method: string, params: unknown): void => {
    if (o.role === "read" && WRITE_METHODS.has(method)) {
      ev("refused", method);
      throw new RpcPolicyError(`${method} refused on read endpoint ${host}`);
    }
    if (!readOnly) return;
    if (!READ_METHODS.has(method)) {
      ev("refused", method);
      throw new RpcPolicyError(`${method} refused on read-only host ${host}`);
    }
    if (method === "eth_getLogs") {
      const f = (Array.isArray(params) ? params[0] : undefined) as { fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown } | undefined;
      if (!f?.blockHash) {
        const from = hexNum(f?.fromBlock), to = hexNum(f?.toBlock);
        if (from === null || to === null || to < from || to - from + 1n > maxRange) {
          ev("refused", method, "range");
          throw new RpcPolicyError(`eth_getLogs on read-only host ${host} needs numeric from/to within ${maxRange} blocks`);
        }
      }
    }
    const t = now();
    if (t < coolUntil) {
      ev("cooling", method);
      throw new RpcPolicyError(`${host} cooling down after failures (${Math.ceil((coolUntil - t) / 1000)}s left)`);
    }
    tokens = Math.min(budget.burst, tokens + ((t - refilledAt) * budget.maxPerMinute) / 60_000);
    refilledAt = t;
    if (tokens < 1) {
      ev("budget", method);
      throw new RpcPolicyError(`${host} request budget exhausted (${budget.maxPerMinute}/min)`);
    }
    tokens -= 1;
  };

  return ((params: Parameters<Transport>[0]) => {
    const t = inner(params);
    const request = (async (args: { method: string; params?: unknown }, opts?: unknown) => {
      admit(args.method, args.params);
      try {
        const r = await (t.request as (a: unknown, b?: unknown) => Promise<unknown>)(args, opts);
        fails = 0;
        return r;
      } catch (e) {
        if (readOnly && !isExecutionError(e)) {
          fails++;
          coolUntil = now() + Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.min(fails - 1, 20));
          ev("failure", args.method, `fails=${fails}`);
        }
        throw e;
      }
    }) as typeof t.request;
    return { ...t, request };
  }) as Transport;
}

/** viem HTTP transport + guard. Read-only hosts get no transport-level retries (no retry storms). */
export function rpcTransport(url: string, o: Omit<GuardOptions, "url"> & { timeoutMs?: number }): Transport {
  const ro = isReadOnlyHost(url, o.extraReadOnlyHosts);
  return guardedTransport(http(url, { retryCount: ro ? 0 : 1, timeout: o.timeoutMs ?? 15_000 }), { ...o, url });
}
