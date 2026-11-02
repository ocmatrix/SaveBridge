/**
 * Production wiring (deploy-prep) extracted from main.ts so it is testable:
 *   endpoints (read/write split, independence, rpc1/rpc2 read-only) → guarded viem clients →
 *   signers (factory: local-keystore | kms) → alert sinks (log + file + Telegram) → RelayerDeps.
 * main.ts only reads files/env and calls these.
 */
import { appendFileSync } from "node:fs";
import { createPublicClient, http, type PublicClient, type Transport } from "viem";
import {
  assertWriteEndpoint,
  checkIndependence,
  guardedTransport,
  isReadOnlyHost,
  readCredential,
  readCredentialText,
  RpcPolicyError,
  TelegramNotifier,
  type GuardOptions,
} from "@bridge/ops";
import { DedupAlertSink, FanoutAlertSink, LogAlertSink, type AlertSink } from "./alerts";
import { keyRefs, MIN_POLL_MS_WITH_EXTERNAL_RPC, type KeyRefResolved, type RelayerConfig } from "./config";
import { LocalKeystoreSigner } from "./keystoreSigner";
import { KmsSigner, type TxSigner } from "./signer";
import { TelegramAlertSink } from "./telegramSink";
import { ViemChainReader } from "./chain/reader";
import type { RelayerDeps } from "./relayer";
import type { HeartbeatSink } from "./heartbeat";
import type { Db } from "./db/types";
import type { SafetyState } from "./safety";

type Env = Record<string, string | undefined>;
export interface Src {
  label: string;
  url: string;
  node?: string;
}
export interface Endpoints {
  wantos: { write: Src; primary: Src; cross: Src[] };
  bsc: { write: Src; readers: Src[] };
  /** Non-fatal findings (same-node duplicates, fewer than the design's 3 sources). */
  warnings: string[];
  /** rpc1/rpc2 (read-only external) are configured → low-frequency rules apply. */
  usesExternalReadOnly: boolean;
}

function src(env: Env, name: string, nodes: Record<string, string>): Src {
  const url = env[name];
  if (!url) throw new Error(`config: ${name} is not set`);
  return { label: name, url, node: nodes[name] };
}

/**
 * RPC URLs come from the environment only. Refuses: write endpoints on rpc1/rpc2, rpc1/rpc2 as the WANTOS
 * primary or on BSC, fewer than 2 independent WANTOS / BSC sources (same host or same node label = one),
 * and a poll interval under 5 s when rpc1/rpc2 are used. Never lowers any threshold.
 */
export function resolveEndpoints(cfg: RelayerConfig, env: Env = process.env): Endpoints {
  const nodes = cfg.rpcNodes ?? {};
  const primary = src(env, cfg.wantos.primaryRpcUrlEnv, nodes);
  const cross = cfg.wantos.crossCheckRpcUrlEnvs.map((n) => src(env, n, nodes));
  const wWrite = src(env, cfg.wantos.writeRpcUrlEnv ?? cfg.wantos.primaryRpcUrlEnv, nodes);
  const readers = cfg.bsc.rpcUrlEnvs.map((n) => src(env, n, nodes));
  const bWrite = src(env, cfg.bsc.writeRpcUrlEnv ?? cfg.bsc.rpcUrlEnvs[0]!, nodes);

  assertWriteEndpoint(wWrite.url, `WANTOS write endpoint (${wWrite.label})`);
  assertWriteEndpoint(bWrite.url, `BSC write endpoint (${bWrite.label})`);
  if (isReadOnlyHost(primary.url)) throw new RpcPolicyError(`WANTOS primary (${primary.label}) must be the own node (rpc3); rpc1/rpc2 may only be cross-checks`);
  for (const r of readers) if (isReadOnlyHost(r.url)) throw new RpcPolicyError(`${r.label}: rpc1/rpc2 are WANTOS nodes and may not serve BSC`);

  const warnings: string[] = [];
  warnings.push(...checkIndependence({ chain: "wantos", sources: [primary, ...cross], required: 2, recommended: 3 }).warnings);
  warnings.push(...checkIndependence({ chain: "bsc", sources: readers, required: 2, recommended: 3 }).warnings);
  const usesExternalReadOnly = cross.some((c) => isReadOnlyHost(c.url));
  if (usesExternalReadOnly && cfg.poll.intervalMs < MIN_POLL_MS_WITH_EXTERNAL_RPC)
    throw new RpcPolicyError(`poll.intervalMs must be >= ${MIN_POLL_MS_WITH_EXTERNAL_RPC} when rpc1/rpc2 are configured (low-frequency read-only authorisation)`);
  return { wantos: { write: wWrite, primary, cross }, bsc: { write: bWrite, readers }, warnings, usesExternalReadOnly };
}

export interface ClientOpts {
  /** Inner transport per URL (tests inject a recording transport); default viem http without retries for rpc1/rpc2. */
  transportFor?: (url: string) => Transport;
  onEvent?: GuardOptions["onEvent"];
  now?: () => number;
}

export interface Clients {
  wantos: { write: PublicClient; primary: PublicClient; cross: PublicClient[] };
  bsc: { write: PublicClient; readers: PublicClient[] };
}

export function buildClients(cfg: RelayerConfig, ep: Endpoints, o: ClientOpts = {}): Clients {
  const ext = cfg.externalRpc ?? { maxRequestsPerMinute: 60, burst: 10, maxLogsBlockRange: 200 };
  const mk = (s: Src, role: "read" | "write"): PublicClient => {
    const inner = o.transportFor ? o.transportFor(s.url) : http(s.url, { retryCount: isReadOnlyHost(s.url) ? 0 : 2, timeout: 15_000 });
    const transport = guardedTransport(inner, {
      url: s.url,
      role,
      budget: { maxPerMinute: ext.maxRequestsPerMinute, burst: ext.burst },
      maxLogsBlockRange: ext.maxLogsBlockRange,
      onEvent: o.onEvent,
      now: o.now,
    });
    return createPublicClient({ transport }) as PublicClient;
  };
  return {
    wantos: { write: mk(ep.wantos.write, "write"), primary: mk(ep.wantos.primary, "read"), cross: ep.wantos.cross.map((s) => mk(s, "read")) },
    bsc: { write: mk(ep.bsc.write, "write"), readers: ep.bsc.readers.map((s) => mk(s, "read")) },
  };
}

/** Every endpoint must serve the configured chain id; a wrong one refuses startup. */
export async function assertChainIds(cfg: RelayerConfig, c: Clients, ep: Endpoints): Promise<void> {
  const checks: Array<[string, PublicClient, number]> = [
    [ep.wantos.write.label, c.wantos.write, cfg.wantos.chainId],
    [ep.wantos.primary.label, c.wantos.primary, cfg.wantos.chainId],
    ...c.wantos.cross.map((cl, i) => [ep.wantos.cross[i]!.label, cl, cfg.wantos.chainId] as [string, PublicClient, number]),
    [ep.bsc.write.label, c.bsc.write, cfg.bsc.chainId],
    ...c.bsc.readers.map((cl, i) => [ep.bsc.readers[i]!.label, cl, cfg.bsc.chainId] as [string, PublicClient, number]),
  ];
  for (const [label, cl, want] of checks) {
    const got = await cl.getChainId();
    if (got !== want) throw new Error(`startup: ${label} serves chainId ${got}, expected ${want}`);
  }
}

export interface SignerOpts {
  env?: Env;
  /** Tests only: accept a faster scrypt than production. */
  minN?: number;
}

/** Signer factory: `local-keystore` (today) or `kms` (placeholder until the AWS KMS signer lands). */
export async function createSigner(ref: KeyRefResolved, allowedChainIds: readonly number[], o: SignerOpts = {}): Promise<TxSigner> {
  if (ref.kind === "kms") return new KmsSigner({ keyId: ref.keyId, address: ref.address });
  const passphrase = readCredential(ref.passphraseCredential, o.env ?? process.env);
  return LocalKeystoreSigner.load({ keystorePath: ref.keystorePath, passphrase, expectedAddress: ref.address, allowedChainIds, minN: o.minN });
}

export async function buildSigners(cfg: RelayerConfig, o: SignerOpts = {}): Promise<{ wantos: TxSigner; bsc: TxSigner; submitter: TxSigner }> {
  const r = keyRefs(cfg);
  const wantos = await createSigner(r.wantos, [cfg.wantos.chainId], o);
  const bsc = await createSigner(r.bsc, [cfg.bsc.chainId], o);
  const submitter = await createSigner(r.submitter, [cfg.wantos.chainId, cfg.bsc.chainId], o);
  if (new Set([wantos.address, bsc.address, submitter.address].map((a) => a.toLowerCase())).size !== 3) throw new Error("startup: the three sending keys must differ");
  return { wantos, bsc, submitter };
}

export interface AlertWiring {
  sink: AlertSink;
  telegram?: TelegramAlertSink;
  /** Secrets to scrub from any local log line. */
  secrets: readonly string[];
}

/** stderr (journald) + optional append-only file + Telegram; 15-min dedup in front (existing behaviour). */
export function buildAlerts(cfg: RelayerConfig, o: { env?: Env; fetch?: typeof fetch; stderr?: (l: string) => void; append?: (path: string, line: string) => void } = {}): AlertWiring {
  const stderr = o.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
  const sinks: AlertSink[] = [new LogAlertSink(stderr)];
  if (cfg.alerts?.logFile) {
    const path = cfg.alerts.logFile;
    const append = o.append ?? ((p: string, l: string) => appendFileSync(p, `${l}\n`, { mode: 0o640 }));
    sinks.push(new LogAlertSink((l) => append(path, l)));
  }
  let telegram: TelegramAlertSink | undefined;
  let secrets: readonly string[] = [];
  const t = cfg.alerts?.telegram;
  if (t) {
    const env = o.env ?? process.env;
    const n = new TelegramNotifier({ botToken: readCredentialText(t.botTokenCredential, env), chatId: readCredentialText(t.chatIdCredential, env), fetch: o.fetch, log: stderr });
    telegram = new TelegramAlertSink(n, { log: stderr });
    secrets = n.secrets;
    sinks.push(telegram);
  } else if (cfg.alerts?.requireTelegram) throw new Error("startup: Telegram is required but not configured");
  return { sink: new DedupAlertSink(new FanoutAlertSink(sinks), 15 * 60_000), telegram, secrets };
}

/**
 * External heartbeat that goes silent while a level-1 alert has been stuck for > `l1GraceMs` (Telegram
 * down): the dead-man-switch service then phones / texts the owner — the degradation path.
 */
export function gatedHeartbeat(ping: () => Promise<unknown>, telegram: TelegramAlertSink | undefined, o: { now?: () => number; l1GraceMs?: number } = {}): HeartbeatSink {
  return {
    ping: async () => {
      const since = telegram?.undeliveredLevel1Since() ?? null;
      if (since !== null && (o.now ?? Date.now)() - since > (o.l1GraceMs ?? 10 * 60_000)) throw new Error("level-1 alert undeliverable: heartbeat withheld");
      await ping();
    },
  };
}

export function buildRelayerDeps(o: {
  cfg: RelayerConfig;
  clients: Clients;
  signers: { wantos: TxSigner; bsc: TxSigner; submitter: TxSigner };
  db: Db;
  alerts: AlertSink;
  safety: SafetyState;
  heartbeat?: HeartbeatSink;
  now?: () => Date;
}): RelayerDeps {
  const { cfg, clients: c } = o;
  return {
    db: o.db,
    alerts: o.alerts,
    safety: o.safety,
    ...(o.now ? { now: o.now } : {}),
    wantos: {
      chainId: cfg.wantos.chainId,
      bridge: cfg.wantos.bridgeAddress,
      client: c.wantos.write, // sending + sender reads: rpc3 only
      primary: new ViemChainReader("wantos-primary", c.wantos.primary),
      crossChecks: c.wantos.cross.map((cl, i) => new ViemChainReader(`wantos-cross-${i}`, cl)),
      signer: o.signers.wantos,
      confirmations: cfg.wantos.confirmations,
      startBlock: BigInt(cfg.wantos.startBlock),
      minBalanceWei: BigInt(cfg.gas.wantosMinBalanceWei),
    },
    bsc: {
      chainId: cfg.bsc.chainId,
      vault: cfg.bsc.bridgeAddress,
      client: c.bsc.write,
      readers: c.bsc.readers.map((cl, i) => new ViemChainReader(`bsc-${i}`, cl)),
      signer: o.signers.bsc,
      startBlock: BigInt(cfg.bsc.startBlock),
      minBalanceWei: BigInt(cfg.gas.bscMinBalanceWei),
    },
    sender: cfg.tx,
    poll: { rescanBlocks: cfg.poll.rescanBlocks, maxBlockRange: cfg.poll.maxBlockRange },
    heartbeat: { sink: o.heartbeat, staleAfterMs: cfg.heartbeat.staleAfterMs },
    submitterAddress: o.signers.submitter.address,
  };
}
