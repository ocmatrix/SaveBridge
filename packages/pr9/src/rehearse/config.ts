import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { LOCAL_CHAIN_IDS, TESTNET_CHAIN_IDS, type Profile, type Side } from "./guard";

/** All addresses, RPC endpoints and keys come from this file + environment variables (never from code). */
export interface ChainCfg {
  chainId: number;
  /** Names of env vars holding RPC URLs (testnet). Local: ignored, anvils are spawned. ≥1; watcher wants ≥2. */
  rpcUrlEnvs: string[];
  /** Existing test token to use instead of deploying a MockToken (testnet: confirm decimals = 18). */
  token: Address | null;
  /** WANTON: confirmations before a source event counts (DESIGN §6.2: 6). */
  confirmations: number;
}

export interface RehearsalConfig {
  profile: Profile;
  /** warp = anvil time travel; real = wait for real block time (testnet). */
  waitMode: "warp" | "real";
  chains: Record<Side, ChainCfg>;
  /** Contract parameters in whole tokens (18 decimals) / seconds. Fast variant ranges apply. */
  params: {
    bsc: { dailyCap: number; perAddrDailyCap: number; largeThreshold: number; releaseDelaySec: number; minDeposit: number; maxDepositPerTx: number };
    wantos: { w2bMinAmount: number; w2bPerAddrDailyCap: number; b2wDailyCap: number; b2wDelaySec: number };
    supplyHeadroom: number;
  };
  /** Reserves funded at the start (whole tokens). */
  reserves: { bsc: number; wantos: number };
  watcherGrace: { w2bSeconds: number; b2wBeforeEtaSeconds: number; refundBeforeExecSeconds: number; depositRefundBeforeExecSeconds: number };
  /** Native gas each key gets (wei, as string). Local: anvil_setBalance; testnet: checked, never auto-sent. */
  gasWei: { role: string; user: string };
  e2e: { smallW2B: number; largeW2B: number; b2w: number; quota: number; review: number; refund: number; negative: number };
  /** Seconds between relayer/watcher ticks in real mode. */
  tickSeconds: number;
  /** Local real-time rehearsal only: anvil interval mining (seconds); omit for automine + warp. */
  localBlockTimeSec?: number;
}

export function loadConfig(path: string): RehearsalConfig {
  const c = JSON.parse(readFileSync(path, "utf8")) as RehearsalConfig;
  validateConfig(c);
  return c;
}

export function validateConfig(c: RehearsalConfig): void {
  if (c.profile !== "local" && c.profile !== "testnet") throw new Error("config: profile must be local | testnet");
  const ids = c.profile === "local" ? LOCAL_CHAIN_IDS : TESTNET_CHAIN_IDS;
  for (const s of ["wantos", "bsc"] as const) {
    if (c.chains[s].chainId !== ids[s]) throw new Error(`config: ${s}.chainId must be ${ids[s]} for profile ${c.profile}`);
    if (c.profile === "testnet" && c.chains[s].rpcUrlEnvs.length < 2) throw new Error(`config: ${s} needs ≥2 RPC env vars (monitor minRpcAgreement=2)`);
    for (const n of c.chains[s].rpcUrlEnvs) if (!/^[A-Z][A-Z0-9_]*$/.test(n)) throw new Error(`config: ${n} is not an env var name`);
  }
  if (c.profile === "testnet" && c.waitMode !== "real") throw new Error("config: testnet can only wait in real time");
  if (c.profile === "local" && c.waitMode === "real" && !c.localBlockTimeSec) throw new Error("config: a local real-time rehearsal needs localBlockTimeSec (interval mining)");
  if (c.chains.wantos.confirmations < 6) throw new Error("config: WANTON confirmations must be ≥ 6 (DESIGN §6.2)");
  const p = c.params;
  if (p.bsc.releaseDelaySec < 60) throw new Error("config: releaseDelay below the fast lower bound (60s)");
  if (p.wantos.b2wDelaySec < 30) throw new Error("config: b2wDelay below the fast lower bound (30s)");
  if (p.bsc.largeThreshold > p.bsc.perAddrDailyCap || p.bsc.perAddrDailyCap > p.bsc.dailyCap) throw new Error("config: need largeThreshold ≤ perAddrDailyCap ≤ dailyCap");
  const t = c.e2e;
  const total = t.smallW2B + t.largeW2B + t.b2w + t.quota + t.review + t.refund + t.negative;
  if (total !== 100) throw new Error(`config: e2e mix must total 100 orders (got ${total})`);
}

export function rpcUrls(c: RehearsalConfig, side: Side, env: Record<string, string | undefined> = process.env): string[] {
  return c.chains[side].rpcUrlEnvs.map((n) => {
    const v = env[n];
    if (!v) throw new Error(`config: env ${n} is not set`);
    return v;
  });
}
