import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createPublicClient, custom, http, type Account, type EIP1193RequestFn, type PublicClient } from "viem";
// PR-3 relayer (in-process, real code; LocalTestSigner = testnet stand-in for the KMS signer, PR3 Q2)
import { MemoryAlertSink as RelayerAlerts, type AlertInput } from "@bridge/relayer/src/alerts";
import { PgliteDb } from "@bridge/relayer/src/db/pglite";
import { migrate } from "@bridge/relayer/src/db/migrations";
import { SafetyState } from "@bridge/relayer/src/safety";
import { LocalTestSigner } from "@bridge/relayer/src/signer";
import { ViemChainReader } from "@bridge/relayer/src/chain/reader";
import { Relayer, type RelayerDeps } from "@bridge/relayer/src/relayer";
import type { Db } from "@bridge/relayer/src/db/types";
// PR-7 watcher (server B, in-process)
import { MemoryAlertSink as WatcherAlerts } from "@bridge/watcher/src/alerts";
import type { WatcherConfig } from "@bridge/watcher/src/config";
import { MemoryHeartbeat } from "@bridge/watcher/src/heartbeat";
import { PauseExecutor, PauseOnlySigner } from "@bridge/watcher/src/pauser";
import { MultiRpc, type RpcEndpoint } from "@bridge/watcher/src/rpc";
import { FileStateStore } from "@bridge/watcher/src/state";
import { Watcher } from "@bridge/watcher/src/watcher";
import { multiRpcPauseReader, viemRawTxSender } from "@bridge/watcher/src/wiring";
import type { Chain, Intercept } from "./chain";
import type { Ctx } from "./ctx";
import type { Side } from "./guard";

/** A client for the same chain whose answers can be tampered with (fault injection: lying / dead RPC). */
export function tamperable(c: Chain, intercept: () => Intercept | null): PublicClient {
  const inner = http(c.url, { retryCount: 0 })({ chain: c.viemChain });
  const request = (async ({ method, params }: { method: string; params?: unknown }) => {
    const i = intercept();
    if (i) {
      const r = i(method, (params as unknown[]) ?? []);
      if (r.handled) {
        if (r.result instanceof Error) throw r.result;
        return r.result;
      }
    }
    return inner.request({ method, params } as never);
  }) as EIP1193RequestFn;
  return createPublicClient({ chain: c.viemChain, transport: custom({ request }, { retryCount: 0 }), pollingInterval: 50 }) as PublicClient;
}

/** Per-side fault switches (F1/F4/F5): a function returning the interceptor in force, or null. */
export const faults: Record<Side, { relayer: Intercept | null; watcherB: Intercept | null; all: Intercept | null }> = {
  wantos: { relayer: null, watcherB: null, all: null },
  bsc: { relayer: null, watcherB: null, all: null },
};

export interface RelayerSys {
  relayer: Relayer;
  db: Db;
  alerts: RelayerAlerts;
  safety: SafetyState;
}

export async function startRelayer(ctx: Ctx, o: { db?: Db; hooks?: RelayerDeps["senderHooks"]; dbDir?: string } = {}): Promise<RelayerSys> {
  const { chains, cfg } = ctx;
  const dir = o.dbDir ?? join(ctx.runDir, "relayer-pg");
  mkdirSync(dir, { recursive: true });
  const db = o.db ?? new PgliteDb(new PGlite(dir));
  await migrate(db);
  const alerts = new RelayerAlerts();
  const origEmit = alerts.emit.bind(alerts);
  alerts.emit = async (a: AlertInput) => {
    appendFileSync(join(ctx.runDir, "relayer-alerts.jsonl"), `${JSON.stringify({ at: ctx.clockSec, ...a }, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);
    return origEmit(a);
  };
  const safety = new SafetyState(alerts);
  const cl = (s: Side, which: "relayer" | "watcherB") => tamperable(chains[s], () => faults[s].all ?? faults[s][which]);
  const wc = cl("wantos", "relayer");
  const bc = cl("bsc", "relayer");
  const extra = (s: Side): PublicClient[] => chains[s].pubs.slice(1);
  const deps: RelayerDeps = {
    db,
    alerts,
    safety,
    now: () => new Date(ctx.clockSec * 1000),
    wantos: {
      chainId: chains.wantos.chainId,
      bridge: ctx.d.proxy,
      client: wc,
      primary: new ViemChainReader("wantos-primary", wc),
      crossChecks: [new ViemChainReader("wantos-cross", cl("wantos", "watcherB")), ...extra("wantos").map((p, i) => new ViemChainReader(`wantos-cross-${i + 2}`, p))],
      signer: new LocalTestSigner(ctx.keys.file.roles[ctx.state.current.wantosRelayer]),
      confirmations: cfg.chains.wantos.confirmations,
      startBlock: BigInt(ctx.d.deployBlock.wantos),
      minBalanceWei: 1n,
    },
    bsc: {
      chainId: chains.bsc.chainId,
      vault: ctx.d.proxy,
      client: bc,
      readers: [new ViemChainReader("bsc-a", bc), new ViemChainReader("bsc-b", cl("bsc", "watcherB")), ...extra("bsc").map((p, i) => new ViemChainReader(`bsc-${i + 3}`, p))],
      signer: new LocalTestSigner(ctx.keys.file.roles[ctx.state.current.bscRelayer]),
      startBlock: BigInt(ctx.d.deployBlock.bsc),
      minBalanceWei: 1n,
    },
    sender: { replaceByFee: true, stuckAfterMs: 120_000, feeBumpPercent: 15, maxFeeBumps: 3 },
    poll: { rescanBlocks: 100, maxBlockRange: 1000 },
    submitterAddress: ctx.keys.role("submitter").address,
    ...(o.hooks ? { senderHooks: o.hooks } : {}),
  };
  const relayer = new Relayer(deps);
  await relayer.start();
  return { relayer, db, alerts, safety };
}

export interface WatcherSys {
  w: Watcher;
  sink: WatcherAlerts;
  hb: MemoryHeartbeat;
  cfg: WatcherConfig;
  rpc: Record<Side, MultiRpc>;
  codes(): string[];
}

export async function startWatcher(ctx: Ctx, o: { statePath?: string; config?: (c: WatcherConfig) => void; extraEndpoints?: Partial<Record<Side, RpcEndpoint[]>> } = {}): Promise<WatcherSys> {
  const { chains, cfg: rc } = ctx;
  const d = ctx.d;
  const chainCfg = (s: Side) => ({
    name: s,
    chainId: chains[s].chainId,
    rpcUrls: chains[s].urls,
    bridge: d.proxy,
    timelock: d.timelock,
    token: d.token[s],
    startBlock: BigInt(d.deployBlock[s]),
    head: s === "bsc" ? ({ kind: "finalized" } as const) : ({ kind: "confirmations", confirmations: rc.chains.wantos.confirmations } as const),
    maxBlockRange: 1000,
    maxLagBlocks: 200,
  });
  const cfg: WatcherConfig = {
    dataDir: join(ctx.runDir, "watcher"),
    minRpcAgreement: 2,
    chains: { bsc: chainCfg("bsc"), wantos: chainCfg("wantos") },
    grace: rc.watcherGrace,
    mintAlertThreshold: 10_000n * 10n ** 18n,
    reconcile: { intervalSeconds: 60, toleranceWei: { bsc: 10n ** 18n, wantos: 10n ** 18n }, wantosLowBalanceWei: null },
    heartbeatIntervalSeconds: 60,
    maxRangesPerTick: 50,
    gasCheckIntervalSeconds: 300,
    wantosStallSeconds: 600,
    maxClockSkewSeconds: rc.waitMode === "warp" ? 10 ** 9 : 60,
    cursorStallSeconds: 3600,
    rpcDissentThreshold: 5,
    pauseRetry: { attempts: 3, backoffMs: rc.waitMode === "warp" ? 0 : 3000 },
    timelockRemindersSeconds: [60, 30],
    dailyCapReportRatioBps: 7000,
    gasWatch: [],
    legacyAddresses: [],
  };
  o.config?.(cfg);
  mkdirSync(cfg.dataDir, { recursive: true });
  const mk = (s: Side): MultiRpc =>
    new MultiRpc(
      s,
      [
        { label: `${s}-a`, client: tamperable(chains[s], () => faults[s].all) },
        { label: `${s}-b`, client: tamperable(chains[s], () => faults[s].all ?? faults[s].watcherB) },
        ...chains[s].pubs.slice(1).map((p, i) => ({ label: `${s}-${i + 3}`, client: p })),
        ...(o.extraEndpoints?.[s] ?? []),
      ],
      2,
    );
  const rpc = { bsc: mk("bsc"), wantos: mk("wantos") };
  const sink = new WatcherAlerts();
  const origSend = sink.send.bind(sink);
  sink.send = async (a) => {
    appendFileSync(join(ctx.runDir, "watcher-alerts.jsonl"), `${JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);
    return origSend(a);
  };
  const hb = new MemoryHeartbeat();
  const pauser = ctx.acct("pauser") as Account;
  const signer = (s: Side) => new PauseOnlySigner(viemRawTxSender(chains[s].wallet(pauser), pauser), [d.proxy]);
  const exec = new PauseExecutor({ bsc: signer("bsc"), wantos: signer("wantos") }, { bsc: multiRpcPauseReader(rpc.bsc, d.proxy), wantos: multiRpcPauseReader(rpc.wantos, d.proxy) }, { bsc: d.proxy, wantos: d.proxy }, cfg.pauseRetry);
  const w = new Watcher({ config: cfg, rpc, store: new FileStateStore(o.statePath ?? join(cfg.dataDir, "state.json")), sink, pauser: exec, heartbeat: hb, clock: () => ctx.clockSec });
  await w.init();
  return { w, sink, hb, cfg, rpc, codes: () => sink.codes() };
}

/**
 * One "beat" of the system: mine (local) so WANTON has 6+ confirmations and BSC a new finalized
 * head, then relayer.tick() and watcher.tick(). Real mode just waits `tickSeconds`.
 */
export async function pump(ctx: Ctx, sys: { r?: RelayerSys | null; w?: WatcherSys | null }, rounds = 1): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (ctx.cfg.waitMode === "warp") {
      await ctx.alignChains();
      await Promise.all([ctx.chains.wantos.mine(ctx.cfg.chains.wantos.confirmations + 1), ctx.chains.bsc.mine(3)]);
    } else await new Promise((r) => setTimeout(r, ctx.cfg.tickSeconds * 1000));
    await ctx.syncClock();
    if (sys.r) await sys.r.relayer.tick();
    if (sys.w) await sys.w.w.tick();
  }
}
