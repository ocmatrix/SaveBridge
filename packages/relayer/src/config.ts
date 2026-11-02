import { isAddress } from "viem";
import type { Address } from "./types";

/**
 * Relayer configuration (DESIGN §6.1/§6.2). No key material is ever accepted here: signers are
 * referenced by KMS key id only (§6.1 "任何钥匙不进代码和配置").
 */
export interface RelayerConfig {
  wantos: {
    chainId: number;
    /** Block the bridge was deployed at (first scan). */
    startBlock: number;
    /** Env var holding the self-hosted non-validator full node URL (primary). URLs never live in the config file. */
    primaryRpcUrlEnv: string;
    /** Env vars holding at least one of rpc/rpc2/rpc3 for receipt cross-check (§6.2). */
    crossCheckRpcUrlEnvs: string[];
    bridgeAddress: Address;
    /** §6.2: WANTOS events wait 6 more blocks. */
    confirmations: number;
    /**
     * deploy-prep: env var of the ONLY endpoint that broadcasts WANTOS transactions (rpc3). Defaults to
     * the primary. Never rpc1/rpc2 (read-only authorisation) — checked at startup.
     */
    writeRpcUrlEnv?: string;
  };
  bsc: {
    chainId: number;
    /** Env vars of >= 2 independent RPCs; only `finalized` blocks are processed (§6.2). */
    rpcUrlEnvs: string[];
    bridgeAddress: Address;
    startBlock: number;
    /** deploy-prep: env var of the BSC broadcast endpoint; defaults to rpcUrlEnvs[0]. */
    writeRpcUrlEnv?: string;
  };
  /** KMS key ids plus the (public) addresses they control; checked at startup. */
  signer:
    | { kind: "kms"; wantosKeyId: string; wantosAddress: Address; bscKeyId: string; bscAddress: Address }
    | { kind: "local-keystore"; wantos: KeystoreRef; bsc: KeystoreRef };
  /** Submission-service hot key (no contract role): timelock execution. */
  submitter: { kind: "kms"; keyId: string; address: Address } | ({ kind: "local-keystore" } & KeystoreRef);
  /**
   * deploy-prep: node identity per RPC env var name (e.g. both rpc3 URLs → "rpc3"). URLs of the same
   * node (same host or same label) count as ONE source; startup refuses too few distinct sources.
   */
  rpcNodes?: Record<string, string>;
  /** deploy-prep: politeness limits towards the read-only external nodes (rpc1 / rpc2). */
  externalRpc?: { maxRequestsPerMinute: number; burst: number; maxLogsBlockRange: number };
  /** deploy-prep: Telegram credentials are systemd credential NAMES, never values. */
  alerts?: { telegram?: { botTokenCredential: string; chatIdCredential: string }; requireTelegram?: boolean; logFile?: string };
  db: { urlEnv: string };
  /** corsOrigins: exact origins allowed to call /v1/* from a browser; absent = none. */
  api: { host: string; port: number; corsOrigins?: string[] };
  poll: { intervalMs: number; rescanBlocks: number; maxBlockRange: number };
  tx: {
    /** PR-0 ⑥ unverified on WANTOS: configurable, default on (PR3-NOTES 待决). */
    replaceByFee: boolean;
    stuckAfterMs: number;
    feeBumpPercent: number;
    maxFeeBumps: number;
  };
  gas: { wantosMinBalanceWei: string; bscMinBalanceWei: string };
  /** urlCredential: systemd credential NAME holding the external dead-man-switch ping URL. */
  heartbeat: { intervalMs: number; staleAfterMs: number; urlCredential?: string };
}

/** Local encrypted keystore reference (deploy-prep). The passphrase is a systemd credential NAME. */
export interface KeystoreRef {
  keystorePath: string;
  passphraseCredential: string;
  address: Address;
}

/** Minimum poll interval when rpc1/rpc2 (read-only external nodes) are configured (user authorisation). */
export const MIN_POLL_MS_WITH_EXTERNAL_RPC = 5000;

export const EXAMPLE_CONFIG: RelayerConfig = {
  wantos: {
    chainId: 13555,
    startBlock: 0,
    primaryRpcUrlEnv: "WANTOS_RPC_PRIMARY",
    crossCheckRpcUrlEnvs: ["WANTOS_RPC_CROSSCHECK_1"],
    bridgeAddress: "0x000000000000000000000000000000000000dEaD",
    confirmations: 6,
  },
  bsc: {
    chainId: 56,
    rpcUrlEnvs: ["BSC_RPC_1", "BSC_RPC_2"],
    bridgeAddress: "0x000000000000000000000000000000000000dEaD",
    startBlock: 0,
  },
  signer: {
    kind: "kms",
    wantosKeyId: "kms-key-id-placeholder-wantos",
    wantosAddress: "0x0000000000000000000000000000000000000A01",
    bscKeyId: "kms-key-id-placeholder-bsc",
    bscAddress: "0x0000000000000000000000000000000000000A02",
  },
  submitter: { kind: "kms", keyId: "kms-key-id-placeholder-submitter", address: "0x0000000000000000000000000000000000000A03" },
  db: { urlEnv: "RELAYER_DATABASE_URL" },
  api: { host: "127.0.0.1", port: 8080, corsOrigins: ["https://bridge.wanto.pro"] },
  poll: { intervalMs: 3000, rescanBlocks: 100, maxBlockRange: 2000 },
  tx: { replaceByFee: true, stuckAfterMs: 120_000, feeBumpPercent: 15, maxFeeBumps: 5 },
  gas: { wantosMinBalanceWei: "1000000000000000000", bscMinBalanceWei: "50000000000000000" },
  heartbeat: { intervalMs: 60_000, staleAfterMs: 300_000 },
};

const LOOPBACK_HOSTS = ["127.0.0.1", "::1"];
const CRED_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
function credName(n: unknown, what: string): string {
  if (typeof n !== "string" || !CRED_NAME.test(n)) throw new Error(`config: ${what} must be a systemd credential name`);
  return n;
}

export type KeyRefResolved = ({ kind: "kms"; keyId: string; address: Address }) | ({ kind: "local-keystore" } & KeystoreRef);

function keystoreRef(r: unknown, what: string): KeystoreRef {
  const o = (r ?? {}) as Partial<KeystoreRef>;
  if (typeof o.keystorePath !== "string" || !o.keystorePath.startsWith("/") || o.keystorePath.includes("..")) throw new Error(`config: ${what}.keystorePath must be an absolute path`);
  credName(o.passphraseCredential, `${what}.passphraseCredential`);
  if (typeof o.address !== "string" || !isAddress(o.address, { strict: false })) throw new Error(`config: ${what}.address is not a valid address`);
  return { keystorePath: o.keystorePath, passphraseCredential: o.passphraseCredential!, address: o.address };
}

/** The three sending keys (two payout keys + submission service), normalised; validates their shape. */
export function keyRefs(c: RelayerConfig): { wantos: KeyRefResolved; bsc: KeyRefResolved; submitter: KeyRefResolved } {
  const s = c.signer as Record<string, unknown> & { kind?: string };
  let wantos: KeyRefResolved, bsc: KeyRefResolved, submitter: KeyRefResolved;
  if (s?.kind === "kms") {
    const k = c.signer as Extract<RelayerConfig["signer"], { kind: "kms" }>;
    wantos = { kind: "kms", keyId: k.wantosKeyId, address: k.wantosAddress };
    bsc = { kind: "kms", keyId: k.bscKeyId, address: k.bscAddress };
  } else if (s?.kind === "local-keystore") {
    wantos = { kind: "local-keystore", ...keystoreRef(s["wantos"], "signer.wantos") };
    bsc = { kind: "local-keystore", ...keystoreRef(s["bsc"], "signer.bsc") };
  } else throw new Error(`config: signer.kind must be "kms" or "local-keystore"`);
  const u = c.submitter as Record<string, unknown> & { kind?: string };
  if (u?.kind === "kms") submitter = { kind: "kms", keyId: String(u["keyId"]), address: u["address"] as Address };
  else if (u?.kind === "local-keystore") submitter = { kind: "local-keystore", ...keystoreRef(u, "submitter") };
  else throw new Error(`config: submitter.kind must be "kms" or "local-keystore"`);
  for (const [n, r] of [["signer.wantos", wantos], ["signer.bsc", bsc], ["submitter", submitter]] as const)
    if (!isAddress(r.address, { strict: false })) throw new Error(`config: ${n} address is not a valid address`);
  return { wantos, bsc, submitter };
}

const KEY_NAME = /priv|secret|mnemonic|seed|password/i;
const RAW_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

function scanForKeyMaterial(v: unknown, path: string): void {
  if (v === null || v === undefined) return;
  if (typeof v === "string") {
    if (RAW_KEY.test(v)) throw new Error(`config: key material is not allowed (${path})`);
    return;
  }
  if (Array.isArray(v)) return v.forEach((x, i) => scanForKeyMaterial(x, `${path}[${i}]`));
  if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (KEY_NAME.test(k)) throw new Error(`config: key material is not allowed (${path}.${k})`);
      scanForKeyMaterial(x, `${path}.${k}`);
    }
  }
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const URL_LIKE = /:\/\//;

function scanForUrls(v: unknown, path: string): void {
  if (typeof v === "string") {
    if (URL_LIKE.test(v)) throw new Error(`config: URL found at ${path}; RPC URLs must come from environment variables`);
    return;
  }
  if (Array.isArray(v)) return v.forEach((x, i) => scanForUrls(x, `${path}[${i}]`));
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k !== "corsOrigins") scanForUrls(x, `${path}.${k}`);
}

function envName(n: unknown, what: string): string {
  if (typeof n !== "string" || !ENV_NAME.test(n)) throw new Error(`config: ${what} must be an environment variable name`);
  return n;
}

/** Reads RPC URLs from the environment (never from the config file; Gate2 B3). */
export function resolveRpcUrls(c: RelayerConfig, env: Record<string, string | undefined> = process.env) {
  const get = (n: string): string => {
    const v = env[n];
    if (!v) throw new Error(`config: ${n} is not set`);
    return v;
  };
  const wantosPrimary = get(c.wantos.primaryRpcUrlEnv);
  const wantosCross = c.wantos.crossCheckRpcUrlEnvs.map(get);
  const bsc = c.bsc.rpcUrlEnvs.map(get);
  if (wantosCross.includes(wantosPrimary)) throw new Error("config: WANTOS cross-check URL must be distinct from the primary");
  if (new Set(bsc).size !== bsc.length) throw new Error("config: BSC RPC URLs must be distinct");
  return { wantosPrimary, wantosCross, bsc };
}

export function parseConfig(raw: RelayerConfig): RelayerConfig {
  scanForKeyMaterial(raw, "config");
  const c = raw;
  envName(c.wantos?.primaryRpcUrlEnv, "wantos.primaryRpcUrlEnv");
  scanForUrls(raw, "config");
  if (!c.bsc || !Array.isArray(c.bsc.rpcUrlEnvs) || c.bsc.rpcUrlEnvs.length < 2) {
    throw new Error("config: BSC needs at least 2 independent RPC urls");
  }
  c.bsc.rpcUrlEnvs.forEach((n, i) => envName(n, `bsc.rpcUrlEnvs[${i}]`));
  if (new Set(c.bsc.rpcUrlEnvs).size !== c.bsc.rpcUrlEnvs.length) throw new Error("config: BSC RPC url env vars must be distinct");
  if (!c.wantos || !Array.isArray(c.wantos.crossCheckRpcUrlEnvs) || c.wantos.crossCheckRpcUrlEnvs.length < 1) {
    throw new Error("config: WANTOS needs at least 1 cross-check RPC url");
  }
  c.wantos.crossCheckRpcUrlEnvs.forEach((n, i) => envName(n, `wantos.crossCheckRpcUrlEnvs[${i}]`));
  if (c.wantos.crossCheckRpcUrlEnvs.includes(c.wantos.primaryRpcUrlEnv)) {
    throw new Error("config: WANTOS cross-check RPC must be distinct from the primary");
  }
  if (!Number.isInteger(c.wantos.confirmations) || c.wantos.confirmations < 6) {
    throw new Error("config: WANTOS confirmations must be >= 6 (DESIGN §6.2)");
  }
  for (const [n, a] of [["wantos.bridgeAddress", c.wantos.bridgeAddress], ["bsc.bridgeAddress", c.bsc.bridgeAddress]] as const) {
    if (!isAddress(a, { strict: false })) throw new Error(`config: ${n} is not a valid address`);
  }
  if (c.wantos.chainId === c.bsc.chainId) throw new Error("config: chain ids must differ");
  if (c.poll.rescanBlocks < 100) throw new Error("config: rescanBlocks must be >= 100 (DESIGN §6.4)");
  if (!Number.isInteger(c.poll.intervalMs) || c.poll.intervalMs < 1000) throw new Error("config: poll.intervalMs must be >= 1000");
  if (!LOOPBACK_HOSTS.includes(c.api.host)) throw new Error("config: api.host must be loopback (127.0.0.1 / ::1); public access goes through Cloudflare Tunnel");
  if (c.wantos.writeRpcUrlEnv !== undefined) envName(c.wantos.writeRpcUrlEnv, "wantos.writeRpcUrlEnv");
  if (c.bsc.writeRpcUrlEnv !== undefined) envName(c.bsc.writeRpcUrlEnv, "bsc.writeRpcUrlEnv");
  for (const [k, v] of Object.entries(c.rpcNodes ?? {})) {
    envName(k, `rpcNodes key ${k}`);
    if (typeof v !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(v)) throw new Error(`config: rpcNodes.${k} must be a node label`);
  }
  if (c.externalRpc) {
    const e = c.externalRpc;
    if (!(e.maxRequestsPerMinute >= 1 && e.maxRequestsPerMinute <= 600 && e.burst >= 1 && e.maxLogsBlockRange >= 1 && e.maxLogsBlockRange <= 2000))
      throw new Error("config: externalRpc limits out of range (1..600 req/min, burst >= 1, 1..2000 blocks)");
  }
  const refs = keyRefs(c);
  const addrs = [refs.wantos.address, refs.bsc.address, refs.submitter.address].map((a) => a.toLowerCase());
  if (new Set(addrs).size !== 3) throw new Error("config: wantos payout, bsc payout and submitter keys must be three different addresses");
  const paths = [refs.wantos, refs.bsc, refs.submitter].filter((r) => r.kind === "local-keystore").map((r) => (r as KeystoreRef).keystorePath);
  if (new Set(paths).size !== paths.length) throw new Error("config: keystore paths must be distinct");
  if (c.alerts?.telegram) {
    credName(c.alerts.telegram.botTokenCredential, "alerts.telegram.botTokenCredential");
    credName(c.alerts.telegram.chatIdCredential, "alerts.telegram.chatIdCredential");
  } else if (c.alerts?.requireTelegram) throw new Error("config: alerts.requireTelegram is set but alerts.telegram is missing");
  if (c.alerts?.logFile !== undefined && !c.alerts.logFile.startsWith("/")) throw new Error("config: alerts.logFile must be absolute");
  if (c.heartbeat.urlCredential !== undefined) credName(c.heartbeat.urlCredential, "heartbeat.urlCredential");
  return c;
}
