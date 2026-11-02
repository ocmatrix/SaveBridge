import { useCallback, useEffect, useRef, useState } from "react";
import { useConnect, useConnection, useConnectors } from "wagmi";
import { useDeps, useI18n } from "../context";
import { describeError, translateError } from "../lib/errors";

export interface WalletState {
  /** Why there is no connected wallet (none detected / refused), else null. */
  note: string | null;
  connecting: boolean;
  retry(): void;
}

/**
 * The page lives inside the host app's browser, which provides the wallet: connect to it on load, no picker.
 * Prefers an EIP-6963-announced wallet, else the first connector; connects straight onto WANTOS (the default direction).
 * No provider → a note naming the app.
 */
export function useAutoConnect(): WalletState {
  const { t, lang } = useI18n();
  const { cfg } = useDeps();
  const { address, status } = useConnection();
  const connectors = useConnectors();
  const { mutateAsync: connect, isPending } = useConnect();
  const [note, setNote] = useState<string | null>(null);
  const tried = useRef(false);

  const run = useCallback(async () => {
    const c = connectors.find((x) => x.type === "injected" && x.id !== "injected") ?? connectors[0];
    if (!c) return;
    setNote(null);
    try {
      await connect({ connector: c, chainId: cfg.wantos.id });
    } catch (e) {
      const name = (e as { name?: string }).name;
      setNote(name === "ProviderNotFoundError" ? t("wallet.noWallet", { app: cfg.appName }) : describeError(translateError(e, { decimals: 18 }), lang));
    }
  }, [connectors, connect, t, cfg.appName, lang]);

  useEffect(() => {
    if (address || tried.current || status === "reconnecting" || status === "connecting" || connectors.length === 0) return;
    tried.current = true;
    void run();
  }, [address, status, connectors.length, run]);

  return { note: address ? null : note, connecting: isPending || status === "connecting" || status === "reconnecting", retry: () => void run() };
}
