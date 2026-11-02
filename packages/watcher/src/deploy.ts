/**
 * deploy-prep production wiring for the watcher (server B = rpc3). The core `parseConfig` / `Watcher`
 * are unchanged; this module adds what a real deployment needs:
 *   - RPC URLs from the environment (`chains.X.rpc: [{ env, node }]`), never in the config file;
 *   - independence (same host / same node label = ONE source; refuse < minRpcAgreement; never lower it);
 *   - rpc1 / rpc2 read-only: guarded transports (no write method can reach them, small getLogs windows,
 *     request budget, back-off), and the PAUSER write endpoint may not point at them;
 *   - PAUSER key from the local encrypted keystore (`@bridge/ops`), sent ONLY through `PauseOnlySigner`;
 *   - Telegram channel, gated external heartbeat, file-based ack inbox, tick interval >= 5 s.
 */
import { readdirSync, readFileSync, unlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, defineChain, http, type Address, type Hex, type PublicClient, type Transport } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  assertDistinctBscProviders,
  assertWriteEndpoint,
  checkIndependence,
  guardedTransport,
  isReadOnlyHost,
  loadKeystoreAccount,
  readCredential,
  RpcPolicyError,
  type GuardOptions,
  type TelegramNotifier,
} from "@bridge/ops";
import type { AlertManager, AlertSink } from "./alerts.js";
import { parseConfig, type WatcherConfig } from "./config.js";
import type { Heartbeat, HeartbeatStatus } from "./heartbeat.js";
import type { RawTxSender } from "./pauser.js";
import { MultiRpc } from "./rpc.js";
import type { Alert, ChainName, MetaState } from "./types.js";

type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;
const CHAINS: ChainName[] = ["bsc", "wantos"];

export interface KeystoreRef {
  keystorePath: string;
  passphraseCredential: string;
  address: Address;
}

export interface RuntimeConfig {
  /** Main loop period; >= 5 s (low-frequency rule for rpc1/rpc2). */
  tickIntervalSeconds: number;
  /** "local-keystore" (today), "kms" (placeholder: refuses), "none" (only with --dry-run). */
  pauser: { kind: "local-keystore"; bsc: KeystoreRef; wantos: KeystoreRef } | { kind: "kms" } | { kind: "none" };
  /** Env var of the endpoint that broadcasts pause() per chain (rpc3 local for WANTOS). */
  pauseWriteRpcEnv: Record<ChainName, string>;
  telegram?: { botTokenCredential: string; chatIdCredential: string };
  requireTelegram: boolean;
  heartbeat?: { urlCredential: string };
  externalRpc: { maxRequestsPerMinute: number; burst: number; maxLogsBlockRange: number };
  /** Directory polled each tick for `<anything>.ack` files holding one level-1 alert key. */
  ackDir?: string;
}

export interface RpcSourceCfg {
  env: string;
  node?: string;
}

export interface DeployConfig {
  core: WatcherConfig;
  runtime: RuntimeConfig;
  sources: Record<ChainName, Array<{ label: string; url: string; node?: string }>>;
  pauseWrite: Record<ChainName, string>;
  warnings: string[];
}

export const MIN_TICK_SECONDS = 5;
const ENV = /^[A-Z][A-Z0-9_]*$/;
const CRED = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const fail = (m: string): never => {
  throw new Error(`watcher deploy config: ${m}`);
};
const obj = (v: unknown, p: string): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : fail(`${p} must be an object`));
const cred = (v: unknown, p: string): string => (typeof v === "string" && CRED.test(v) ? v : fail(`${p} must be a systemd credential name`));
const envName = (v: unknown, p: string): string => (typeof v === "string" && ENV.test(v) ? v : fail(`${p} must be an environment variable name`));

function keystoreRef(v: unknown, p: string): KeystoreRef {
  const o = obj(v, p);
  const path = o["keystorePath"];
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("..")) fail(`${p}.keystorePath must be an absolute path`);
  if (typeof o["address"] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o["address"])) fail(`${p}.address must be an address`);
  return { keystorePath: path as string, passphraseCredential: cred(o["passphraseCredential"], `${p}.passphraseCredential`), address: o["address"] as Address };
}

function parseRuntime(v: unknown): RuntimeConfig {
  const r = obj(v, "runtime");
  const tick = r["tickIntervalSeconds"] ?? MIN_TICK_SECONDS;
  if (typeof tick !== "number" || !(tick >= MIN_TICK_SECONDS)) fail(`runtime.tickIntervalSeconds must be >= ${MIN_TICK_SECONDS}`);
  const p = obj(r["pauser"], "runtime.pauser");
  let pauser: RuntimeConfig["pauser"];
  if (p["kind"] === "local-keystore") {
    pauser = { kind: "local-keystore", bsc: keystoreRef(p["bsc"], "runtime.pauser.bsc"), wantos: keystoreRef(p["wantos"], "runtime.pauser.wantos") };
    if (pauser.bsc.keystorePath === pauser.wantos.keystorePath) fail("runtime.pauser: the two chains need two keystores");
  } else if (p["kind"] === "kms" || p["kind"] === "none") pauser = { kind: p["kind"] };
  else return fail(`runtime.pauser.kind must be "local-keystore" | "kms" | "none"`);
  const w = obj(r["pauseWriteRpcEnv"], "runtime.pauseWriteRpcEnv");
  const t = r["telegram"] === undefined ? undefined : obj(r["telegram"], "runtime.telegram");
  const hb = r["heartbeat"] === undefined ? undefined : obj(r["heartbeat"], "runtime.heartbeat");
  const ext = obj(r["externalRpc"] ?? {}, "runtime.externalRpc");
  const n = (x: unknown, d: number, lo: number, hi: number, path: string): number => {
    const v = x ?? d;
    return typeof v === "number" && v >= lo && v <= hi ? v : fail(`${path} must be in ${lo}..${hi}`);
  };
  const requireTelegram = r["requireTelegram"] === true;
  if (requireTelegram && !t) fail("runtime.requireTelegram is set but runtime.telegram is missing");
  const ackDir = r["ackDir"];
  if (ackDir !== undefined && (typeof ackDir !== "string" || !ackDir.startsWith("/"))) fail("runtime.ackDir must be an absolute path");
  return {
    tickIntervalSeconds: tick as number,
    pauser,
    pauseWriteRpcEnv: { bsc: envName(w["bsc"], "runtime.pauseWriteRpcEnv.bsc"), wantos: envName(w["wantos"], "runtime.pauseWriteRpcEnv.wantos") },
    ...(t ? { telegram: { botTokenCredential: cred(t["botTokenCredential"], "runtime.telegram.botTokenCredential"), chatIdCredential: cred(t["chatIdCredential"], "runtime.telegram.chatIdCredential") } } : {}),
    requireTelegram,
    ...(hb ? { heartbeat: { urlCredential: cred(hb["urlCredential"], "runtime.heartbeat.urlCredential") } } : {}),
    externalRpc: {
      maxRequestsPerMinute: n(ext["maxRequestsPerMinute"], 120, 1, 600, "runtime.externalRpc.maxRequestsPerMinute"),
      burst: n(ext["burst"], 20, 1, 200, "runtime.externalRpc.burst"),
      maxLogsBlockRange: n(ext["maxLogsBlockRange"], 200, 1, 2000, "runtime.externalRpc.maxLogsBlockRange"),
    },
    ...(ackDir ? { ackDir: ackDir as string } : {}),
  };
}

/**
 * Deploy config = core watcher config where every `chains.X.rpcUrls` is replaced by
 * `chains.X.rpc: [{ env, node? }]`, plus a `runtime` section. URLs inside the file are refused.
 */
export function resolveDeployConfig(raw: unknown, env: Env = process.env): DeployConfig {
  const r = structuredClone(obj(raw, "root"));
  if (/:\/\//.test(JSON.stringify({ ...r, legacyAddresses: undefined, _comment: undefined }))) fail("URLs are not allowed in the config file; RPC URLs come from the environment");
  const runtime = parseRuntime(r["runtime"]);
  delete r["runtime"];
  const chains = obj(r["chains"], "chains");
  const sources = {} as DeployConfig["sources"];
  for (const c of CHAINS) {
    const ch = obj(chains[c], `chains.${c}`);
    if (ch["rpcUrls"] !== undefined) fail(`chains.${c}.rpcUrls is not allowed in a deploy config; use chains.${c}.rpc: [{ env, node }]`);
    const list = Array.isArray(ch["rpc"]) ? (ch["rpc"] as unknown[]) : fail(`chains.${c}.rpc must be an array`);
    sources[c] = list.map((x, i) => {
      const o = obj(x, `chains.${c}.rpc[${i}]`);
      const name = envName(o["env"], `chains.${c}.rpc[${i}].env`);
      const url = env[name] ?? fail(`${name} is not set`);
      const node = o["node"] === undefined ? undefined : typeof o["node"] === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(o["node"]) ? o["node"] : fail(`chains.${c}.rpc[${i}].node must be a label`);
      return { label: name, url, ...(node ? { node } : {}) };
    });
    ch["rpcUrls"] = sources[c].map((s) => s.url);
    delete ch["rpc"];
  }
  const core = parseConfig(r);
  const warnings: string[] = [];
  for (const c of CHAINS) {
    warnings.push(...checkIndependence({ chain: c, sources: sources[c], required: core.minRpcAgreement, recommended: 3 }).warnings);
    if (c === "bsc") for (const s of sources[c]) if (isReadOnlyHost(s.url)) throw new RpcPolicyError(`${s.label}: rpc1/rpc2 are WANTOS nodes and may not serve BSC`);
    if (sources[c].some((s) => isReadOnlyHost(s.url)) && core.chains[c].maxBlockRange > runtime.externalRpc.maxLogsBlockRange)
      fail(`chains.${c}.maxBlockRange (${core.chains[c].maxBlockRange}) must be <= runtime.externalRpc.maxLogsBlockRange (${runtime.externalRpc.maxLogsBlockRange}) when rpc1/rpc2 are configured`);
  }
  const pauseWrite = {} as Record<ChainName, string>;
  const bscWrite = env[runtime.pauseWriteRpcEnv.bsc];
  assertDistinctBscProviders([...sources.bsc.map((s) => s.url), ...(bscWrite ? [bscWrite] : [])], env);
  for (const c of CHAINS) {
    const name = runtime.pauseWriteRpcEnv[c];
    const url = env[name] ?? fail(`${name} is not set`);
    assertWriteEndpoint(url, `${c} pause() write endpoint (${name})`);
    pauseWrite[c] = url;
  }
  return { core, runtime, sources, pauseWrite, warnings };
}

export interface RpcBuildOpts {
  transportFor?: (url: string) => Transport;
  onEvent?: GuardOptions["onEvent"];
  now?: () => number;
}

function guarded(url: string, role: "read" | "write", rt: RuntimeConfig, o: RpcBuildOpts): Transport {
  const inner = o.transportFor ? o.transportFor(url) : http(url, { retryCount: isReadOnlyHost(url) ? 0 : 1, timeout: 15_000 });
  return guardedTransport(inner, {
    url,
    role,
    budget: { maxPerMinute: rt.externalRpc.maxRequestsPerMinute, burst: rt.externalRpc.burst },
    maxLogsBlockRange: rt.externalRpc.maxLogsBlockRange,
    onEvent: o.onEvent,
    now: o.now,
  });
}

/** Same shape as `buildRpc` but every endpoint is a guarded READ client (writes refused). */
export function buildGuardedRpc(d: DeployConfig, o: RpcBuildOpts = {}): Record<ChainName, MultiRpc> {
  const mk = (c: ChainName) =>
    new MultiRpc(
      c,
      d.sources[c].map((s) => ({ label: s.node ? `${c}:${s.node}:${s.label}` : `${c}:${s.label}`, client: createPublicClient({ transport: guarded(s.url, "read", d.runtime, o) }) as PublicClient })),
      d.core.minRpcAgreement,
    );
  return { bsc: mk("bsc"), wantos: mk("wantos") };
}

/**
 * RawTxSender backed by a local-keystore account: explicit EIP-155 legacy tx (chainId pinned), sent ONLY
 * to the configured write endpoint (rpc3 for WANTOS). Wrap it in `PauseOnlySigner` — never anything else.
 */
export function keystoreRawTxSender(o: { account: PrivateKeyAccount; chainId: number; client: PublicClient; gasBufferPercent?: number }): RawTxSender {
  return {
    address: o.account.address,
    send: async (tx: { to: Address; data: Hex }): Promise<Hex> => {
      const [nonce, gasPrice, est] = await Promise.all([
        o.client.getTransactionCount({ address: o.account.address, blockTag: "pending" }),
        o.client.getGasPrice(),
        o.client.estimateGas({ account: o.account.address, to: tx.to, data: tx.data }),
      ]);
      const gas = (est * BigInt(100 + (o.gasBufferPercent ?? 30))) / 100n;
      const raw = await o.account.signTransaction({ type: "legacy", chainId: o.chainId, nonce, gasPrice, gas, to: tx.to, data: tx.data, value: 0n });
      return o.client.sendRawTransaction({ serializedTransaction: raw });
    },
  };
}

/** Loads both PAUSER keystores (address pinned) and builds their write clients. Fail-closed. */
export async function buildPauseSenders(d: DeployConfig, o: RpcBuildOpts & { env?: Env; minN?: number } = {}): Promise<Record<ChainName, RawTxSender>> {
  const p = d.runtime.pauser;
  if (p.kind !== "local-keystore") throw new Error(`PAUSER signer kind "${p.kind}" cannot sign (kms not implemented; none = dry-run only)`);
  const out = {} as Record<ChainName, RawTxSender>;
  for (const c of CHAINS) {
    const ref = p[c];
    const account = await loadKeystoreAccount({ path: ref.keystorePath, passphrase: readCredential(ref.passphraseCredential, o.env ?? process.env), expectedAddress: ref.address, minN: o.minN });
    const chainId = d.core.chains[c].chainId;
    const client = createPublicClient({ chain: defineChain({ id: chainId, name: c, nativeCurrency: { name: "native", symbol: "N", decimals: 18 }, rpcUrls: { default: { http: [] } } }), transport: guarded(d.pauseWrite[c], "write", d.runtime, o) }) as PublicClient;
    const got = await client.getChainId();
    if (got !== chainId) throw new Error(`${c} pause() write endpoint serves chainId ${got}, expected ${chainId}`);
    out[c] = keystoreRawTxSender({ account, chainId, client });
  }
  if (out.bsc.address.toLowerCase() === out.wantos.address.toLowerCase()) throw new Error("PAUSER keys of the two chains must differ");
  return out;
}

/** Watcher alert channel → Telegram. Failures are rethrown so AlertManager queues them per channel. */
export class TelegramChannel implements AlertSink {
  constructor(private readonly n: TelegramNotifier) {}
  async send(a: Alert): Promise<void> {
    await this.n.send({ level: a.level, service: "监控", code: a.code, title: a.title, chain: a.chain, key: a.key, detail: a.detail, at: new Date(a.at * 1000), repeat: a.repeat });
  }
}

/**
 * External heartbeat; withheld while a level-1 alert has been stuck in channel `channel`'s outbox for
 * more than `graceSeconds` (Telegram down) so the dead-man switch phones the owner instead.
 */
export function gatedHeartbeat(ping: () => Promise<unknown>, meta: () => MetaState | undefined, channel: number | undefined, o: { nowSeconds?: () => number; graceSeconds?: number } = {}): Heartbeat {
  return {
    beat: async (_s: HeartbeatStatus) => {
      const m = meta();
      if (m && channel !== undefined) {
        const now = (o.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
        const stuck = m.outbox.filter((e) => e.channel === channel && e.alert.level === 1 && now - e.alert.at > (o.graceSeconds ?? 300));
        if (stuck.length > 0) throw new Error(`${stuck.length} level-1 alert(s) undeliverable on the IM channel: heartbeat withheld`);
      }
      await ping();
    },
  };
}

/**
 * Ack inbox: the owner (or an operator on the owner's instruction) drops `<name>.ack` files containing
 * one level-1 alert key into `dir` (owned by the watcher user, 0700). Each is applied once and removed.
 * Unknown keys are logged with the list of open keys. Symlinks and oversized files are ignored.
 */
export function processAckInbox(dir: string, alerts: AlertManager, openKeys: () => string[], log: (o: Record<string, unknown>) => void): number {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".ack"));
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    const p = join(dir, name);
    try {
      const st = lstatSync(p);
      if (!st.isFile() || st.size > 512) {
        log({ event: "ack_ignored", file: name, reason: "not a small regular file" });
        continue;
      }
      const key = readFileSync(p, "utf8").trim();
      const open = openKeys();
      if (open.includes(key)) {
        alerts.ack(key);
        n++;
        log({ event: "ack_applied", key });
      } else log({ event: "ack_unknown_key", key, open });
      unlinkSync(p);
    } catch (e) {
      log({ event: "ack_error", file: name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return n;
}
