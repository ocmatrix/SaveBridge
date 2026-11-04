import { numberToHex } from "viem";
import type { ChainConf } from "../config";

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

const hex = (id: number) => numberToHex(id);
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("wallet timeout")), ms))]);

/** Ask the wallet to switch to `c`. `add` also lets the wallet add the chain (shows its own prompt) when the switch fails. */
export async function requestChain(provider: Eip1193Like, c: ChainConf, add: boolean): Promise<number> {
  try {
    await withTimeout(provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex(c.id) }] }), add ? 60_000 : 8_000);
  } catch (e) {
    if (!add || (e as { code?: number }).code === 4001) throw e;
    await withTimeout(provider.request({ method: "wallet_addEthereumChain", params: [buildAddChainParams(c)] }), 60_000);
  }
  return Number(await provider.request({ method: "eth_chainId" }));
}
