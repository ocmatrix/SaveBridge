import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { AppConfig } from "./config";
import type { Clients } from "./lib/clients";
import type { StatusProvider } from "./lib/statusProvider";
import { t as translate, type I18nKey, type Lang } from "./i18n";

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
