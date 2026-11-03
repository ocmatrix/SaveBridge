import { useI18n } from "../context";

/** Under the card: the credit line and the language switch. */
export function Footer() {
  const { t, lang, setLang } = useI18n();
  return (
    <footer className="foot">
      <small className="powered">{t("footer.powered")}</small>
      <div className="lang" role="group" aria-label="Language">
        {(["zh", "en"] as const).map((l) => (
          <button key={l} type="button" lang={l} aria-pressed={lang === l} onClick={() => setLang(l)}>
            {l === "zh" ? "中文" : "English"}
          </button>
        ))}
      </div>
    </footer>
  );
}
