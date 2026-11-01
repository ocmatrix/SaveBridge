import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";
import type { AppConfig, ChainConf } from "../config";

export function toViemChain(c: ChainConf): Chain {
  return defineChain({
    id: c.id,
    name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [c.rpcUrl] } },
    blockExplorers: { default: { name: c.name, url: c.explorerUrl } },
  });
}

export interface Clients {
  wantos: PublicClient;
  bsc: PublicClient;
}

/** Read-only clients talk only to the configured RPCs (never to the wallet's RPC). */
export function makeClients(cfg: AppConfig): Clients {
  const mk = (c: ChainConf) => createPublicClient({ chain: toViemChain(c), transport: http(c.rpcUrl, { retryCount: 1 }) }) as PublicClient;
  return { wantos: mk(cfg.wantos), bsc: mk(cfg.bsc) };
}

export function clientFor(cfg: AppConfig, clients: Clients, chainId: number): PublicClient {
  if (chainId === cfg.wantos.id) return clients.wantos;
  if (chainId === cfg.bsc.id) return clients.bsc;
  throw new Error(`unknown chain ${chainId}`);
}
