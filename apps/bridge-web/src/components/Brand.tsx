import { useI18n } from "../context";

/** The mark, traced from the supplied logo (4 polygons). Same path as public/logo.svg (the favicon). */
const LOGO_PATH = "M207 0.9 L318.8 0.9 L281 63.9 L243 63.9 Z M37 0.2 L49 19.9 L183 247.9 L330.1 0 L367 62.9 L184 371.9 L0 63.9 Z M194 0.2 L256 104.9 L218.8 168.9 L157 64.9 Z M487 0.2 L524 63.9 L340 372.9 L268 249.9 L305 187.2 L340.5 249.5 L472 24.9 Z";

/** Logo + name above the card. */
export function Brand() {
  const { t } = useI18n();
  return (
    <header className="brand">
      <svg viewBox="0 0 524 372.9" aria-hidden="true" focusable="false">
        <path fill="currentColor" d={LOGO_PATH} />
      </svg>
      <h1>{t("app.title")}</h1>
    </header>
  );
}
