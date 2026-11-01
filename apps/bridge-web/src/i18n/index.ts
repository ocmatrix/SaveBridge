import { zh, type I18nKey } from "./zh";
import { en } from "./en";

export type Lang = "zh" | "en";
export type { I18nKey };
const dicts = { zh, en } as const;

export function t(lang: Lang, key: I18nKey, params?: Record<string, string>): string {
  const s: string = dicts[lang][key];
  return params ? s.replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m) : s;
}

export function pickInitialLang(languages: readonly string[]): Lang {
  const first = languages[0];
  if (!first) return "zh";
  return first.toLowerCase().startsWith("zh") ? "zh" : "en";
}
