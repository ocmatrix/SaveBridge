import { useCallback, useEffect, useState } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { WagmiProvider, useConnection } from "wagmi";
import type { AppConfig } from "./config";
import type { Clients } from "./lib/clients";
import type { KnownIds, StatusProvider } from "./lib/statusProvider";
import type { BridgeWagmiConfig } from "./wallet/wagmi";
import type { Lang } from "./i18n";
import { DepsProvider, LangProvider, useDeps, useI18n } from "./context";
import { useBridgeState, useOrders } from "./hooks";
import { ConnectWallet } from "./components/ConnectWallet";
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
            <Page />
          </LangProvider>
        </DepsProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function Page() {
  const { t, lang, setLang } = useI18n();
  const { cfg } = useDeps();
  const { address } = useConnection();
  const [tab, setTab] = useState<"w2b" | "b2w">("w2b");
  const [known, setKnown] = useState<Known>({ w2b: [], b2w: [] });
  useEffect(() => setKnown(address ? loadKnown(browserStorage(), address) : { w2b: [], b2w: [] }), [address]);
  const state = useBridgeState(address);
  const knownIds: KnownIds = known;
  const orders = useOrders(address, knownIds);
  const remember = useCallback(
    (dir: keyof Known, id: bigint) =>
      setKnown((k) => {
        const next = { ...k, [dir]: [...k[dir], id] };
        if (address) saveKnown(browserStorage(), address, next);
        return next;
      }),
    [address],
  );
  const addW2b = useCallback((id: bigint) => remember("w2b", id), [remember]);
  const addB2w = useCallback((id: bigint) => remember("b2w", id), [remember]);

  return (
    <div className="page">
      <header>
        <div>
          <h1>{t("app.title")}</h1>
          <p className="muted">{t("app.subtitle")}</p>
        </div>
        <div className="row">
          <button type="button" className="secondary" onClick={() => setLang(lang === "zh" ? "en" : "zh")}>
            {t("lang.toggle")}
          </button>
          <ConnectWallet />
        </div>
      </header>
      <main>
        <StatusBar state={state.data} connected={!!address} loading={state.isLoading} failed={state.isError} onRefresh={() => void state.refetch()} />
        <div role="tablist" className="tabs">
          {(["w2b", "b2w"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
              {t(k === "w2b" ? "tab.w2b" : "tab.b2w")}
            </button>
          ))}
        </div>
        {tab === "w2b" ? <W2BPanel state={state.data} onOrder={addW2b} /> : <B2WPanel state={state.data} onDeposit={addB2w} />}
        {address && (
          <Orders orders={orders.data} decimals={{ wantos: state.data?.wantos.decimals ?? 18, bsc: state.data?.bsc.decimals ?? 18 }} />
        )}
      </main>
      <Footer key={cfg.wantos.bridge} />
    </div>
  );
}
