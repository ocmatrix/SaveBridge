import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { App } from "./App";
import { ConfigError, isPlaceholder, parseConfig } from "./config";
import { makeClients } from "./lib/clients";
import { ChainStatusProvider } from "./lib/statusProvider";
import { createWagmiConfig } from "./wallet/wagmi";
import { storedLang } from "./context";
import { pickInitialLang, t } from "./i18n";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const lang = storedLang() ?? pickInitialLang(navigator.languages ?? []);

try {
  const cfg = parseConfig(import.meta.env as unknown as Record<string, string | undefined>);
  if (isPlaceholder(cfg)) throw new ConfigError("placeholder build (no real configuration)");
  const clients = makeClients(cfg);
  root.render(
    <StrictMode>
      <App
        cfg={cfg}
        clients={clients}
        statusProvider={new ChainStatusProvider(cfg, clients)}
        wagmiConfig={createWagmiConfig(cfg)}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } })}
        initialLang={lang}
      />
    </StrictMode>,
  );
} catch (e) {
  const msg = e instanceof ConfigError ? e.message : "unexpected";
  root.render(<p className="error">{t(lang, "config.error", { msg })}</p>);
}
