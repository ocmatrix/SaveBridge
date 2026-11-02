import { useCallback, useEffect, useState } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { WagmiProvider, useConnection } from "wagmi";
import type { AppConfig } from "./config";
import type { Clients } from "./lib/clients";
import type { KnownIds, StatusProvider } from "./lib/statusProvider";
import type { BridgeWagmiConfig } from "./wallet/wagmi";
import type { Lang } from "./i18n";
import { DepsProvider, LangProvider, PendingProvider, useDeps, useI18n } from "./context";
import { useBridgeState, useOrders } from "./hooks";
import { useAutoConnect } from "./wallet/useAutoConnect";
import { StatusBar } from "./components/StatusBar";
import { W2BPanel } from "./components/W2BPanel";
import { B2WPanel } from "./components/B2WPanel";
import { Orders } from "./components/Orders";
import { Footer } from "./components/Footer";
import { browserStorage, loadKnown, saveKnown, type Known } from "./lib/knownOrders";

export interface AppProps {
  cfg: AppConfig;
  clients: Clients;
  statusProvider: StatusProvider;
  wagmiConfig: BridgeWagmiConfig;
  queryClient: QueryClient;
  initialLang: Lang;
}

export function App(p: AppProps) {
  return (
    <WagmiProvider config={p.wagmiConfig}>
      <QueryClientProvider client={p.queryClient}>
        <DepsProvider value={{ cfg: p.cfg, clients: p.clients, statusProvider: p.statusProvider }}>
          <LangProvider initial={p.initialLang}>
            <PendingProvider>
              <Page />
            </PendingProvider>
          </LangProvider>
        </DepsProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

/** The whole page is one card: from / to boxes, one button, the last few orders below. */
function Page() {
  const { t } = useI18n();
  const { cfg } = useDeps();
  const { address } = useConnection();
  const wallet = useAutoConnect();
  const [dir, setDir] = useState<"w2b" | "b2w">("w2b");
  const [known, setKnown] = useState<Known>({ w2b: [], b2w: [] });
  useEffect(() => setKnown(address ? loadKnown(browserStorage(), address) : { w2b: [], b2w: [] }), [address]);
  const state = useBridgeState(address);
  const knownIds: KnownIds = known;
  const orders = useOrders(address, knownIds);
  const remember = useCallback(
    (d: keyof Known, id: bigint) =>
      setKnown((k) => {
        const next = { ...k, [d]: [...k[d], id] };
        if (address) saveKnown(browserStorage(), address, next);
        return next;
      }),
    [address],
  );
  const addW2b = useCallback((id: bigint) => remember("w2b", id), [remember]);
  const addB2w = useCallback((id: bigint) => remember("b2w", id), [remember]);
  const flip = useCallback(() => setDir((d) => (d === "w2b" ? "b2w" : "w2b")), []);

  return (
    <div className="page">
      {cfg.network === "testnet" && (
        <div className="testnet-banner" role="alert" aria-label={t("testnet.label")}>
          {t("testnet.banner")}
        </div>
      )}
      <main className="stage">
        <div className="card">
          <StatusBar state={state.data} loading={state.isLoading} error={state.error} onRefresh={() => void state.refetch()} />
          {dir === "w2b" ? (
            <W2BPanel state={state.data} onOrder={addW2b} wallet={wallet} onFlip={flip} />
          ) : (
            <B2WPanel state={state.data} onDeposit={addB2w} wallet={wallet} onFlip={flip} />
          )}
          {/* amounts are formatted with chain decimals: no state (e.g. decimals mismatch) → no order list */}
          {address && state.data && <Orders orders={orders.data} decimals={{ wantos: state.data.wantos.decimals, bsc: state.data.bsc.decimals }} />}
        </div>
        <Footer key={cfg.wantos.bridge} />
      </main>
    </div>
  );
}
