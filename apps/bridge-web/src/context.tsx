import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { AppConfig } from "./config";
import type { Clients } from "./lib/clients";
import type { StatusProvider } from "./lib/statusProvider";
import { t as translate, type I18nKey, type Lang } from "./i18n";
import { loadPending, pendingKey, savePending, sessionStore, type PendingMap, type PendingTx } from "./lib/pendingTx";

export interface Deps {
  cfg: AppConfig;
  clients: Clients;
  statusProvider: StatusProvider;
}

const DepsCtx = createContext<Deps | null>(null);
const LangCtx = createContext<{ lang: Lang; setLang(l: Lang): void } | null>(null);

export function DepsProvider({ value, children }: { value: Deps; children: ReactNode }) {
  return <DepsCtx.Provider value={value}>{children}</DepsCtx.Provider>;
}

export function useDeps(): Deps {
  const d = useContext(DepsCtx);
  if (!d) throw new Error("DepsProvider missing");
  return d;
}

const LANG_KEY = "bridge.lang";

export function LangProvider({ initial, children }: { initial: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* storage unavailable: preference is per-session only */
    }
  }, []);
  const v = useMemo(() => ({ lang, setLang }), [lang, setLang]);
  return <LangCtx.Provider value={v}>{children}</LangCtx.Provider>;
}

export function storedLang(): Lang | null {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === "zh" || v === "en" ? v : null;
  } catch {
    return null;
  }
}

export function useI18n() {
  const c = useContext(LangCtx);
  if (!c) throw new Error("LangProvider missing");
  const { lang, setLang } = c;
  const t = useCallback((key: I18nKey, params?: Record<string, string>) => translate(lang, key, params), [lang]);
  return { lang, setLang, t };
}

interface PendingApi {
  get(key: string): PendingTx | null;
  set(p: PendingTx): void;
  clear(key: string): void;
}
const PendingCtx = createContext<PendingApi | null>(null);

/** Page-level store of unconfirmed-transaction locks (survives tab switches; persisted to sessionStorage). */
export function PendingProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<PendingMap>(() => loadPending(sessionStore()));
  const update = useCallback((f: (m: PendingMap) => PendingMap) => {
    setMap((m) => {
      const next = f(m);
      savePending(sessionStore(), next);
      return next;
    });
  }, []);
  const api = useMemo<PendingApi>(
    () => ({
      get: (k) => map[k] ?? null,
      set: (p) => update((m) => ({ ...m, [pendingKey(p.account, p.chainId, p.action)]: p })),
      clear: (k) =>
        update((m) => {
          const { [k]: _gone, ...rest } = m;
          return rest;
        }),
    }),
    [map, update],
  );
  return <PendingCtx.Provider value={api}>{children}</PendingCtx.Provider>;
}

export function usePendingStore(): PendingApi {
  const c = useContext(PendingCtx);
  if (!c) throw new Error("PendingProvider missing");
  return c;
}
