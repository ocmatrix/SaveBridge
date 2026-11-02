import { createConfig, http, type CreateConnectorFn, type Storage } from "wagmi";
import { injected } from "wagmi/connectors";
import type { AppConfig } from "../config";
import { toViemChain } from "../lib/clients";

export interface WagmiOptions {
  /** Override connectors (tests use wagmi's mock connector). */
  connectors?: CreateConnectorFn[];
  /** `null` disables persistence (tests). */
  storage?: Storage | null;
}

/**
 * Any EVM wallet that injects a provider: the host app's / TokenPocket's DApp browser, MetaMask, OKX, browser
 * extensions (EIP-1193 + EIP-6963 discovery). No WalletConnect / QR: the page is opened inside the wallet.
 */
export function createWagmiConfig(cfg: AppConfig, opts: WagmiOptions = {}) {
  const wantos = toViemChain(cfg.wantos);
  const bsc = toViemChain(cfg.bsc);
  const connectors =
    opts.connectors ??
    [
      injected({ shimDisconnect: true }),
    ];
  return createConfig({
    chains: [wantos, bsc],
    connectors,
    transports: { [wantos.id]: http(cfg.wantos.rpcUrl), [bsc.id]: http(cfg.bsc.rpcUrl) },
    multiInjectedProviderDiscovery: true,
    ...(opts.storage === null ? { storage: null } : opts.storage ? { storage: opts.storage } : {}),
  });
}

export type BridgeWagmiConfig = ReturnType<typeof createWagmiConfig>;
