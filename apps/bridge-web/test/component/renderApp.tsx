import { render } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { mock } from "wagmi/connectors";
import type { Address } from "viem";
import { App } from "../../src/App";
import { createWagmiConfig } from "../../src/wallet/wagmi";
import { makeClients, type Clients } from "../../src/lib/clients";
import { ChainStatusProvider, type StatusProvider } from "../../src/lib/statusProvider";
import type { AppConfig } from "../../src/config";

export function renderApp(cfg: AppConfig, account: Address | readonly [Address, ...Address[]], opts: { statusProvider?: StatusProvider; clients?: Clients } = {}) {
  const wagmiConfig = createWagmiConfig(cfg, { connectors: [mock({ accounts: typeof account === "string" ? [account] : account })], storage: null });
  const clients = opts.clients ?? makeClients(cfg);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const statusProvider = opts.statusProvider ?? new ChainStatusProvider(cfg, clients);
  const utils = render(
    <App cfg={cfg} clients={clients} wagmiConfig={wagmiConfig} queryClient={queryClient} statusProvider={statusProvider} initialLang="zh" />,
  );
  return { ...utils, wagmiConfig, queryClient };
}
