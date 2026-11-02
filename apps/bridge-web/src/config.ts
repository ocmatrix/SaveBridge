import { getAddress, isAddress, zeroAddress, type Address } from "viem";

/** One chain's build-time settings. No contract address is hard-coded anywhere in the app (DESIGN §8.1). */
export interface ChainConf {
  id: number;
  name: string;
  nativeSymbol: string;
  rpcUrl: string;
  explorerUrl: string;
  bridge: Address;
  usdt: Address;
  /** First block to scan for the user's own events (bridge deployment block). */
  fromBlock: bigint;
}

export interface AppConfig {
  wantos: ChainConf;
  bsc: ChainConf;
  /** Optional read-only relayer API base (no trailing slash), e.g. https://api.example.org */
  relayerApi: string | null;
  walletConnectProjectId: string | null;
  /** Max blocks scanned backwards for events when no relayer API is configured. */
  logLookback: bigint;
  /** Built from `.env.placeholder` (CI/build check only): the app renders an error and never connects a wallet. */
  placeholder: boolean;
  /** Name of the host app, shown in "open this page in …" (VITE_APP_NAME, default "SafeBridge"). */
  appName: string;
  /** `VITE_NETWORK=testnet` → testnet build (permanent banner, built into dist-testnet/). */
  network: "mainnet" | "testnet";
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

function req(env: Env, k: string): string {
  const v = env[k]?.trim();
  if (!v) throw new ConfigError(`missing ${k}`);
  return v;
}

function url(env: Env, k: string, required: boolean): string | null {
  const raw = required ? req(env, k) : env[k]?.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${k} is not a URL`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new ConfigError(`${k} must be https`);
  return raw.replace(/\/+$/, "");
}

function addr(env: Env, k: string): Address {
  const v = req(env, k);
  if (!isAddress(v, { strict: false }) || v.toLowerCase() === zeroAddress) throw new ConfigError(`${k} is not a valid address`);
  return getAddress(v);
}

function uint(env: Env, k: string, fallback?: string): bigint {
  const v = env[k]?.trim() || fallback;
  if (v === undefined) throw new ConfigError(`missing ${k}`);
  if (!/^\d+$/.test(v)) throw new ConfigError(`${k} must be a non-negative integer`);
  return BigInt(v);
}

function chain(env: Env, p: "WANTOS" | "BSC"): ChainConf {
  const id = Number(uint(env, `VITE_${p}_CHAIN_ID`));
  if (!Number.isSafeInteger(id) || id <= 0) throw new ConfigError(`VITE_${p}_CHAIN_ID out of range`);
  const c: ChainConf = {
    id,
    name: req(env, `VITE_${p}_CHAIN_NAME`),
    nativeSymbol: req(env, `VITE_${p}_NATIVE_SYMBOL`),
    rpcUrl: url(env, `VITE_${p}_RPC_URL`, true)!,
    explorerUrl: url(env, `VITE_${p}_EXPLORER_URL`, true)!,
    bridge: addr(env, `VITE_${p}_BRIDGE`),
    usdt: addr(env, `VITE_${p}_USDT`),
    fromBlock: uint(env, `VITE_${p}_FROM_BLOCK`, "0"),
  };
  if (c.bridge === c.usdt) throw new ConfigError(`VITE_${p}_BRIDGE equals VITE_${p}_USDT`);
  return c;
}

function networkKind(v: string | undefined): "mainnet" | "testnet" {
  const n = v?.trim() || "mainnet";
  if (n !== "mainnet" && n !== "testnet") throw new ConfigError("VITE_NETWORK must be mainnet or testnet");
  return n;
}

export function parseConfig(env: Env): AppConfig {
  const wantos = chain(env, "WANTOS");
  const bsc = chain(env, "BSC");
  if (wantos.id === bsc.id) throw new ConfigError("WANTOS and BSC chain ids must differ");
  // DESIGN §5.1: deterministic deployment gives the bridge proxy the same address on both chains
  if (wantos.bridge !== bsc.bridge) throw new ConfigError("VITE_WANTOS_BRIDGE and VITE_BSC_BRIDGE must be the same address");
  return {
    wantos,
    bsc,
    relayerApi: url(env, "VITE_RELAYER_API", false),
    walletConnectProjectId: env.VITE_WC_PROJECT_ID?.trim() || null,
    logLookback: uint(env, "VITE_LOG_LOOKBACK_BLOCKS", "50000"),
    placeholder: env.VITE_CONFIG_PLACEHOLDER === "1",
    appName: env.VITE_APP_NAME?.trim() || "SafeBridge",
    network: networkKind(env.VITE_NETWORK),
  };
}

export function chainById(cfg: AppConfig, chainId: number): ChainConf | null {
  if (chainId === cfg.wantos.id) return cfg.wantos;
  if (chainId === cfg.bsc.id) return cfg.bsc;
  return null;
}

export function isPlaceholder(cfg: AppConfig): boolean {
  return cfg.placeholder;
}
