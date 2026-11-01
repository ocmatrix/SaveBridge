import { numberToHex } from "viem";
import type { AppConfig, ChainConf } from "../config";

export interface Eip1193Like {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

/** EIP-3085 parameters, all values from build-time config (DESIGN §8.1). */
export function buildAddChainParams(c: ChainConf) {
  return {
    chainId: numberToHex(c.id),
    chainName: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
    rpcUrls: [c.rpcUrl],
    blockExplorerUrls: [c.explorerUrl],
  };
}

export async function addWantosNetwork(provider: Eip1193Like, cfg: AppConfig): Promise<void> {
  await provider.request({ method: "wallet_addEthereumChain", params: [buildAddChainParams(cfg.wantos)] });
}
