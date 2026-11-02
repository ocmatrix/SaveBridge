import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, useConnection } from "wagmi";
import { App } from "./App";
import { ConfigError, parseConfig } from "./lib/config";
import { makeChains, type Chains } from "./lib/chain";
import { createWagmiConfig, wagmiSigner, WalletButtons, type AdminWagmiConfig } from "./wallet/wagmi";
import "./styles.css";

function Root({ cfg, chains, wagmi }: { cfg: ReturnType<typeof parseConfig>; chains: Chains; wagmi: AdminWagmiConfig }) {
  const { address, status } = useConnection();
  const signer = useMemo(() => (status === "connected" && address ? wagmiSigner(wagmi, address) : null), [status, address, wagmi]);
  return <App cfg={cfg} chains={chains} signer={signer} walletSlot={<WalletButtons />} />;
}

const root = createRoot(document.getElementById("root")!);
try {
  const cfg = parseConfig(import.meta.env as unknown as Record<string, string | undefined>);
  const chains = makeChains(cfg);
  const wagmi = createWagmiConfig(chains);
  root.render(
    <StrictMode>
      <WagmiProvider config={wagmi}>
        <QueryClientProvider client={new QueryClient()}>
          <Root cfg={cfg} chains={chains} wagmi={wagmi} />
        </QueryClientProvider>
      </WagmiProvider>
    </StrictMode>,
  );
} catch (e) {
  root.render(<p className="err">配置错误：{e instanceof ConfigError ? e.message : "unexpected"}</p>);
}
