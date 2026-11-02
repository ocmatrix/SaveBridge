import { getAddress, isAddress, type Address } from "viem";

export type Side = "bsc" | "wantos";
export const SIDES: readonly Side[] = ["bsc", "wantos"];
export const SIDE_NAME: Record<Side, string> = { bsc: "BSC", wantos: "WANTOS" };

export interface ChainCfg {
  side: Side;
  chainId: number;
  rpcUrl: string;
  /** Bridge proxy (same address on both chains, DESIGN §5.1). Timelock and token are read from the bridge itself. */
  bridge: Address;
  /** First block to scan for events (deployment block). */
  fromBlock: bigint;
}

export interface AppConfig {
  bsc: ChainCfg;
  wantos: ChainCfg;
  /** Cloudflare Worker that forwards to the relayer admin API (SIWE session). `null` → those panels show a placeholder. */
  adminApi: string | null;
  /** Hostname the SIWE message binds to. */
  siweDomain: string;
}

export class ConfigError extends Error {}

function need(env: Record<string, string | undefined>, k: string): string {
  const v = env[k]?.trim();
  if (!v) throw new ConfigError(`缺少配置 ${k}`);
  return v;
}

function chain(env: Record<string, string | undefined>, side: Side): ChainCfg {
  const p = `VITE_${side.toUpperCase()}_`;
  const chainId = Number(need(env, `${p}CHAIN_ID`));
  if (!Number.isInteger(chainId) || chainId <= 0) throw new ConfigError(`${p}CHAIN_ID 无效`);
  const rpcUrl = need(env, `${p}RPC_URL`);
  const u = new URL(rpcUrl);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost")))
    throw new ConfigError(`${p}RPC_URL 必须是 https`);
  const bridge = need(env, `${p}BRIDGE`);
  if (!isAddress(bridge, { strict: false })) throw new ConfigError(`${p}BRIDGE 不是地址`);
  const fb = env[`${p}FROM_BLOCK`]?.trim() || "0";
  if (!/^\d+$/.test(fb)) throw new ConfigError(`${p}FROM_BLOCK 无效`);
  return { side, chainId, rpcUrl, bridge: getAddress(bridge), fromBlock: BigInt(fb) };
}

/** Build-time configuration (Vite env). Only public values: chain ids, RPC URLs, contract addresses. */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const bsc = chain(env, "bsc");
  const wantos = chain(env, "wantos");
  if (bsc.chainId === wantos.chainId) throw new ConfigError("两条链的 chainId 不能相同");
  if (bsc.bridge !== wantos.bridge) throw new ConfigError("两条链的桥合约地址必须相同（§5.1 确定性部署）");
  const api = env.VITE_ADMIN_API?.trim() || null;
  if (api) {
    const u = new URL(api);
    if (u.protocol !== "https:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new ConfigError("VITE_ADMIN_API 必须是 https");
  }
  return { bsc, wantos, adminApi: api, siweDomain: env.VITE_SIWE_DOMAIN?.trim() || "admin.wanto.pro" };
}

/** Placeholder builds (CI artifact without real addresses) use the dead address. */
export const PLACEHOLDER_BRIDGE = "0x000000000000000000000000000000000000dEaD";
export const isPlaceholder = (c: AppConfig) => c.bsc.bridge === getAddress(PLACEHOLDER_BRIDGE);
