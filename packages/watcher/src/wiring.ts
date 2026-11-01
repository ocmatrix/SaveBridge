import { createPublicClient, http, type Account, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { WatcherConfig } from "./config.js";
import { bridgeAbiOf } from "./events.js";
import type { PauseChainReader, RawTxSender } from "./pauser.js";
import { MultiRpc } from "./rpc.js";
import type { ChainName } from "./types.js";

/** One independent viem client per configured URL. */
export function buildRpc(cfg: WatcherConfig): Record<ChainName, MultiRpc> {
  const mk = (c: ChainName) =>
    new MultiRpc(
      c,
      cfg.chains[c].rpcUrls.map((url, i) => ({ label: `${c}#${i}`, client: createPublicClient({ transport: http(url, { retryCount: 1, timeout: 15_000 }) }) as PublicClient })),
      cfg.minRpcAgreement,
    );
  return { bsc: mk("bsc"), wantos: mk("wantos") };
}

/** Reads `paused()` and waits for receipts through the chain's RPC set. */
export function multiRpcPauseReader(rpc: MultiRpc, bridge: Address): PauseChainReader {
  return {
    paused: () => rpc.primary((c) => c.readContract({ address: bridge, abi: bridgeAbiOf(rpc.chain), functionName: "paused" }) as Promise<boolean>),
    waitReceipt: async (hash: Hex) => (await rpc.primary((c) => c.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 120_000 }))).status,
  };
}

/**
 * Adapter for a viem wallet (local account in tests; a KMS-backed viem `Account` in production).
 * Wrap it in `PauseOnlySigner` — never hand it to anything else.
 */
export function viemRawTxSender(wallet: WalletClient, account: Account): RawTxSender {
  return {
    address: account.address,
    send: (tx) => wallet.sendTransaction({ account, chain: wallet.chain ?? null, to: tx.to, data: tx.data }),
  };
}
