import { useCallback, useEffect, useRef, useState } from "react";
import { useConnect, useConnection, useConnectors, type Connector } from "wagmi";
import { useDeps, useI18n } from "../context";
import { describeError, translateError } from "../lib/errors";

export interface WalletState {
  /** Why there is no connected wallet (none detected / refused), else null. */
  note: string | null;
  connecting: boolean;
  retry(): void;
  /** The wallet list (opened by the big button while no wallet is connected). */
  open: boolean;
  setOpen(v: boolean): void;
  list: Connector[];
  error: string | null;
  choose(c: Connector): Promise<void>;
}

/**
 * Inside the host app's browser (or any wallet browser) there is exactly one wallet: connect to it on load, no
 * picker, straight onto WANTOS (the default direction). Otherwise — no wallet, or several announced (EIP-6963)
 * ones — the big button reads 「连接钱包」 and opens the list of wallets found in the browser.
 */
export function useAutoConnect(): WalletState {
  const { t, lang } = useI18n();
  const { cfg } = useDeps();
  const { address, status } = useConnection();
  const connectors = useConnectors();
  const { mutateAsync: connect, isPending } = useConnect();
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tried = useRef(false);

  // EIP-6963-announced wallets replace the generic injected entry
  const announced = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  const list = connectors.filter((c) => c.type !== "injected" || c.id !== "injected" || announced.length === 0);

  const fail = useCallback(
    (e: unknown) => ((e as { name?: string }).name === "ProviderNotFoundError" ? t("wallet.noWallet", { app: cfg.appName }) : describeError(translateError(e, { decimals: 18 }), lang)),
    [t, cfg.appName, lang],
  );

  const run = useCallback(async () => {
    const c = announced[0] ?? list[0];
    if (!c) return;
    setNote(null);
    try {
      await connect({ connector: c, chainId: cfg.wantos.id });
    } catch (e) {
      setNote(fail(e));
    }
  }, [announced, list, connect, cfg.wantos.id, fail]);

  const choose = useCallback(
    async (c: Connector) => {
      setError(null);
      try {
        await connect({ connector: c, chainId: cfg.wantos.id });
        setOpen(false);
        setNote(null);
      } catch (e) {
        setError(fail(e));
      }
    },
    [connect, cfg.wantos.id, fail],
  );

  useEffect(() => {
    if (address || tried.current || status === "reconnecting" || status === "connecting" || connectors.length === 0) return;
    tried.current = true;
    if (announced.length > 1) return; // several wallets: the user picks
    void run();
  }, [address, status, connectors.length, announced.length, run]);

  return {
    note: address ? null : note,
    connecting: isPending || status === "connecting" || status === "reconnecting",
    retry: () => void run(),
    open,
    setOpen,
    list,
    error,
    choose,
  };
}
