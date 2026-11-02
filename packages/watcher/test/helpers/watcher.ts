import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, getAbiItem, http, type Abi, type AbiEvent, type Address, type EIP1193RequestFn, type Hex, type PublicClient } from "viem";
import { MemoryAlertSink, type AlertSink } from "../../src/alerts.js";
import type { WatcherConfig } from "../../src/config.js";
import { MemoryHeartbeat, type RelayerProbe } from "../../src/heartbeat.js";
import { PauseExecutor, PauseOnlySigner, type RawTxSender } from "../../src/pauser.js";
import { MultiRpc, type RpcEndpoint } from "../../src/rpc.js";
import { MemoryStateStore, type StateStore } from "../../src/state.js";
import type { ChainName } from "../../src/types.js";
import { Watcher } from "../../src/watcher.js";
import { multiRpcPauseReader, viemRawTxSender } from "../../src/wiring.js";
import { ACCOUNTS, E, type ChainH, type Harness } from "./harness.js";

export type Intercept = (method: string, params: unknown[]) => { handled: true; result: unknown } | { handled: false };

/** A localhost endpoint whose answers can be tampered with (simulates a lying / broken RPC). */
export function tamperedClient(h: ChainH, intercept: Intercept): PublicClient {
  const inner = http(h.url, { retryCount: 0 })({ chain: h.chain });
  const request = (async ({ method, params }: { method: string; params?: unknown }) => {
    const r = intercept(method, (params as unknown[]) ?? []);
    if (r.handled) {
      if (r.result instanceof Error) throw r.result;
      return r.result;
    }
    return inner.request({ method, params } as never);
  }) as EIP1193RequestFn;
  return createPublicClient({ chain: h.chain, transport: custom({ request }, { retryCount: 0 }) }) as PublicClient;
}

const hexN = (n: bigint) => `0x${n.toString(16)}`;
async function rawRpc<T>(h: ChainH, method: string, params: unknown[]): Promise<T> {
  const j = (await (await fetch(h.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as { result: T };
  return j.result;
}

/**
 * A lying RPC (aligner round-2 POC): appends one fabricated bridge log at block `atBlock()` to every
 * unfiltered (no topics) bridge `eth_getLogs` covering it — i.e. exactly what range ingestion asks for.
 */
export function injector(h: ChainH, atBlock: () => bigint | null, mk: (blockHash: Hex) => { topics: Hex[]; data: Hex }, opts: { withTopics?: boolean } = {}): PublicClient {
  return tamperedClient(h, (m, p) => {
    if (m !== "eth_getLogs") return { handled: false };
    const f = p[0] as { address?: string | string[]; fromBlock: string; toBlock: string; topics?: unknown[] };
    const addrs = Array.isArray(f.address) ? f.address : [f.address];
    const X = atBlock();
    if (X === null || !addrs.some((a) => a?.toLowerCase() === h.bridge.toLowerCase())) return { handled: false };
    if (!opts.withTopics && f.topics && f.topics.length > 0) return { handled: false };
    if (opts.withTopics && !(f.topics && f.topics.length > 0)) return { handled: false };
    const to = f.toBlock === "latest" ? null : BigInt(f.toBlock);
    if (BigInt(f.fromBlock) > X || (to !== null && to < X)) return { handled: false };
    return {
      handled: true,
      result: (async () => {
        const real = await rawRpc<unknown[]>(h, m, p);
        const blk = await rawRpc<{ hash: Hex }>(h, "eth_getBlockByNumber", [hexN(X), false]);
        const { topics, data } = mk(blk.hash);
        return [...real, { address: h.bridge, topics, data, blockNumber: hexN(X), blockHash: blk.hash, transactionHash: `0x${"ab".repeat(32)}`, transactionIndex: "0x0", logIndex: "0x63", removed: false }];
      })(),
    };
  });
}

export const honest = (h: ChainH): PublicClient => tamperedClient(h, () => ({ handled: false }));

export function fakeLog(abi: Abi, name: string, vals: (i: { name?: string; type: string }) => unknown): { topics: Hex[]; data: Hex } {
  const ev = getAbiItem({ abi, name }) as AbiEvent;
  const all = Object.fromEntries(ev.inputs.map((i) => [i.name!, vals(i)]));
  const nonIdx = ev.inputs.filter((i) => !i.indexed);
  return {
    topics: encodeEventTopics({ abi: [ev], eventName: name, args: Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name!, all[i.name!]])) as never }) as Hex[],
    data: encodeAbiParameters(nonIdx as never, nonIdx.map((i) => all[i.name!]) as never),
  };
}

/** (aligner r3) Appends one fabricated log (fresh txHash each call, `times` copies) at the range end of every unfiltered getLogs covering `address`. */
export function injectorAt(h: ChainH, address: () => Address, mk: () => { topics: Hex[]; data: Hex }, on: () => boolean, opts: { times?: number; fixedTx?: Hex; withTopics?: boolean } = {}): PublicClient {
  let n = 0;
  return tamperedClient(h, (m, p) => {
    if (m !== "eth_getLogs" || !on()) return { handled: false };
    const f = p[0] as { address?: string | string[]; fromBlock: string; toBlock: string; topics?: unknown[] };
    const addrs = Array.isArray(f.address) ? f.address : [f.address];
    const hasTopics = !!(f.topics && f.topics.length > 0);
    if (!addrs.some((a) => a?.toLowerCase() === address().toLowerCase()) || hasTopics !== !!opts.withTopics) return { handled: false };
    return {
      handled: true,
      result: (async () => {
        const real = await rawRpc<unknown[]>(h, m, p);
        const X = BigInt(f.toBlock);
        const blk = await rawRpc<{ hash: Hex }>(h, "eth_getBlockByNumber", [hexN(X), false]);
        const { topics, data } = mk();
        n++;
        const fake = { address: address(), topics, data, blockNumber: hexN(X), blockHash: blk.hash, transactionHash: opts.fixedTx ?? `0x${n.toString(16).padStart(64, "f")}`, transactionIndex: "0x0", logIndex: "0x63", removed: false };
        return [...real, ...Array.from({ length: opts.times ?? 1 }, () => ({ ...fake }))];
      })(),
    };
  });
}

/** (aligner r3) A node that stopped syncing at block `frozen()`. */
export function stalledNode(h: ChainH, frozen: () => bigint | null, opts: { receiptsOnly?: boolean } = {}): PublicClient {
  return tamperedClient(h, (m, p) => {
    const F = frozen();
    if (F === null) return { handled: false };
    if (m === "eth_getTransactionReceipt") {
      return {
        handled: true,
        result: (async () => {
          const r = await rawRpc<{ blockNumber: string } | null>(h, m, p);
          return r && BigInt(r.blockNumber) > F ? null : r;
        })(),
      };
    }
    if (opts.receiptsOnly) return { handled: false };
    if (m === "eth_blockNumber") return { handled: true, result: hexN(F) };
    if (m === "eth_getBlockByNumber") {
      const tag = p[0] as string;
      if (tag === "finalized" || tag === "latest" || tag === "safe") return { handled: true, result: rawRpc(h, m, [hexN(F), p[1]]) };
      if (/^0x[0-9a-f]+$/.test(tag) && BigInt(tag) > F) return { handled: true, result: null };
      return { handled: false };
    }
    if (m === "eth_getLogs") {
      const f = { ...(p[0] as { fromBlock: string; toBlock: string }) };
      if (BigInt(f.fromBlock) > F) return { handled: true, result: [] };
      if (f.toBlock !== "latest" && BigInt(f.toBlock) > F) f.toBlock = hexN(F);
      return { handled: true, result: rawRpc(h, m, [f]) };
    }
    return { handled: false };
  });
}

/** Rewrites real getLogs answers (e.g. other blockHash / data) for logs at block X. */
export function logRewriter(h: ChainH, at: () => bigint | null, edit: (l: Record<string, unknown>) => Record<string, unknown>): PublicClient {
  return tamperedClient(h, (m, p) => {
    if (m !== "eth_getLogs" || at() === null) return { handled: false };
    return {
      handled: true,
      result: (async () => {
        const real = await rawRpc<Array<Record<string, unknown>>>(h, m, p);
        return real.map((l) => (BigInt(l["blockNumber"] as string) === at() ? edit(l) : l));
      })(),
    };
  });
}

export interface WOpts {
  startBlock?: { bsc: bigint; wantos: bigint };
  endpoints?: Partial<Record<ChainName, RpcEndpoint[]>>;
  store?: StateStore;
  config?: (c: WatcherConfig) => void;
  relayerProbe?: RelayerProbe;
  /** Wrap the PAUSER transport (e.g. simulate a lying RPC on the send path). */
  wrapSender?: (inner: RawTxSender) => RawTxSender;
  /** Additional alert channels after the in-memory one (e.g. a flaky "phone" channel). */
  extraChannels?: AlertSink[];
}

export interface TW {
  w: Watcher;
  sink: MemoryAlertSink;
  hb: MemoryHeartbeat;
  clock: { now: number };
  cfg: WatcherConfig;
  codes(): string[];
}

export async function currentStart(H: Harness): Promise<{ bsc: bigint; wantos: bigint }> {
  return { bsc: (await H.bsc.latest()).number + 1n, wantos: (await H.wantos.latest()).number + 1n };
}

export async function makeWatcher(H: Harness, o: WOpts = {}): Promise<TW> {
  const start = o.startBlock ?? (await currentStart(H));
  const chainCfg = (h: ChainH, head: WatcherConfig["chains"]["bsc"]["head"], startBlock: bigint) => ({
    name: h.name,
    chainId: h.chainId,
    rpcUrls: [h.url, h.url],
    bridge: h.bridge,
    timelock: h.timelock,
    token: h.token,
    startBlock,
    head,
    maxBlockRange: 500,
    maxLagBlocks: 200,
  });
  const cfg: WatcherConfig = {
    dataDir: "unused",
    minRpcAgreement: 2,
    chains: { bsc: chainCfg(H.bsc, { kind: "finalized" }, start.bsc), wantos: chainCfg(H.wantos, { kind: "confirmations", confirmations: 6 }, start.wantos) },
    grace: { w2bSeconds: 300, b2wBeforeEtaSeconds: 180, refundBeforeExecSeconds: 7200, depositRefundBeforeExecSeconds: 7200 },
    mintAlertThreshold: E(10_000),
    reconcile: { intervalSeconds: 3600, toleranceWei: { bsc: E(1), wantos: E(1) }, wantosLowBalanceWei: null },
    heartbeatIntervalSeconds: 300,
    maxRangesPerTick: 20,
    gasCheckIntervalSeconds: 300,
    wantosStallSeconds: 60,
    maxClockSkewSeconds: 60,
    cursorStallSeconds: 600,
    rpcDissentThreshold: 5,
    pauseRetry: { attempts: 2, backoffMs: 0 },
    timelockRemindersSeconds: [86_400, 21_600],
    dailyCapReportRatioBps: 7000,
    gasWatch: [],
    legacyAddresses: [],
  };
  o.config?.(cfg);
  const mkRpc = (h: ChainH): MultiRpc =>
    new MultiRpc(
      h.name,
      o.endpoints?.[h.name] ?? [
        { label: `${h.name}-a`, client: h.pub },
        { label: `${h.name}-b`, client: createPublicClient({ chain: h.chain, transport: http(h.url, { retryCount: 0 }) }) as PublicClient },
      ],
      2,
    );
  const rpc = { bsc: mkRpc(H.bsc), wantos: mkRpc(H.wantos) };
  const sink = new MemoryAlertSink();
  const hb = new MemoryHeartbeat();
  const clock = { now: Math.max((await H.bsc.latest()).timestamp, (await H.wantos.latest()).timestamp) };
  const signer = (h: ChainH) => {
    const raw = viemRawTxSender(h.wallet(ACCOUNTS.pauser), ACCOUNTS.pauser);
    return new PauseOnlySigner(o.wrapSender ? o.wrapSender(raw) : raw, [h.bridge]);
  };
  const pauser = new PauseExecutor(
    { bsc: signer(H.bsc), wantos: signer(H.wantos) },
    { bsc: multiRpcPauseReader(rpc.bsc, H.bsc.bridge), wantos: multiRpcPauseReader(rpc.wantos, H.wantos.bridge) },
    { bsc: H.bsc.bridge, wantos: H.wantos.bridge },
    cfg.pauseRetry,
  );
  const w = new Watcher({
    config: cfg,
    rpc,
    store: o.store ?? new MemoryStateStore(),
    sink: [sink, ...(o.extraChannels ?? [])],
    pauser,
    heartbeat: hb,
    clock: () => clock.now,
    ...(o.relayerProbe ? { relayerProbe: o.relayerProbe } : {}),
  });
  await w.init();
  return { w, sink, hb, clock, cfg, codes: () => sink.codes() };
}
