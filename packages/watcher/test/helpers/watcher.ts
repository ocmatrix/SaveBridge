import { createPublicClient, custom, http, type EIP1193RequestFn, type PublicClient } from "viem";
import { MemoryAlertSink } from "../../src/alerts.js";
import type { WatcherConfig, ControlledEntry } from "../../src/config.js";
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

export interface WOpts {
  startBlock?: { bsc: bigint; wantos: bigint };
  endpoints?: Partial<Record<ChainName, RpcEndpoint[]>>;
  store?: StateStore;
  config?: (c: WatcherConfig) => void;
  controlled?: ControlledEntry[];
  relayerProbe?: RelayerProbe;
  /** Wrap the PAUSER transport (e.g. simulate a lying RPC on the send path). */
  wrapSender?: (inner: RawTxSender) => RawTxSender;
}

export interface TW {
  w: Watcher;
  sink: MemoryAlertSink;
  hb: MemoryHeartbeat;
  clock: { now: number };
  cfg: WatcherConfig;
  controlled: { list: ControlledEntry[] };
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
    pauseRetry: { attempts: 2, backoffMs: 0 },
    timelockRemindersSeconds: [86_400, 21_600],
    dailyCapReportRatioBps: 7000,
    gasWatch: [],
    legacyAddresses: [],
    controlledSetFile: null,
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
  const controlled = { list: o.controlled ?? [] };
  const w = new Watcher({
    config: cfg,
    rpc,
    store: o.store ?? new MemoryStateStore(),
    sink,
    pauser,
    heartbeat: hb,
    clock: () => clock.now,
    controlledSet: { load: async () => controlled.list },
    ...(o.relayerProbe ? { relayerProbe: o.relayerProbe } : {}),
  });
  await w.init();
  return { w, sink, hb, clock, cfg, controlled, codes: () => sink.codes() };
}
