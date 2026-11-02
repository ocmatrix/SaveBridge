import { useI18n } from "../context";

/** Under the card: who can use the bridge, and the credit line. */
export function Footer() {
  const { t } = useI18n();
  return (
    <footer className="foot">
      <small>{t("footer.notice")}</small>
      <small className="powered">{t("footer.powered")}</small>
    </footer>
  );
}
