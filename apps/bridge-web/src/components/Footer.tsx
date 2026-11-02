import { useI18n } from "../context";

/** One line under the card: who can use the bridge. */
export function Footer() {
  const { t } = useI18n();
  return (
    <footer className="foot">
      <small>{t("footer.notice")}</small>
    </footer>
  );
}
