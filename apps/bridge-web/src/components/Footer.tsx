import { useDeps, useI18n } from "../context";

/** Fixed footer: the bridge address from build config (DESIGN §8.1), so users can compare it with the announced one. The address is the same on both chains (checked by parseConfig). */
export function Footer() {
  const { cfg } = useDeps();
  const { t } = useI18n();
  return (
    <footer className="foot">
      <span>{t("footer.contract")}</span>
      <a href={`${cfg.wantos.explorerUrl}/address/${cfg.wantos.bridge}`} target="_blank" rel="noopener noreferrer">
        <code>{cfg.wantos.bridge}</code>
      </a>
      <small>{t("footer.notice")}</small>
    </footer>
  );
}
