import { createConfig, http, type CreateConnectorFn, type Storage } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import type { AppConfig } from "../config";
import { toViemChain } from "../lib/clients";

export interface WagmiOptions {
  /** Override connectors (tests use wagmi's mock connector). */
  connectors?: CreateConnectorFn[];
  /** `null` disables persistence (tests). */
  storage?: Storage | null;
}

/**
 * Injected wallets (EIP-1193 + EIP-6963 discovery: TP / MetaMask / OKX DApp browsers and extensions) and,
 * when a project id is configured, WalletConnect v2 with our own QR (no hosted modal → strict CSP).
 */
export function createWagmiConfig(cfg: AppConfig, opts: WagmiOptions = {}) {
  const wantos = toViemChain(cfg.wantos);
  const bsc = toViemChain(cfg.bsc);
  const connectors =
    opts.connectors ??
    [
      injected({ shimDisconnect: true }),
      ...(cfg.walletConnectProjectId
        ? [
            walletConnect({
              projectId: cfg.walletConnectProjectId,
              showQrModal: false,
              metadata: {
                name: "WANTOS Bridge",
                description: "WANTOS ⇄ BSC USDT bridge",
                url: typeof location !== "undefined" ? location.origin : "https://bridge.wanto.pro",
                icons: [],
              },
            }),
          ]
        : []),
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
