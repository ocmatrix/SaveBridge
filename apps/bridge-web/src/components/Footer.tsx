import { useDeps, useI18n } from "../context";

/** Fixed footer: both bridge addresses from build config (DESIGN §8.1), so users can verify what they sign. */
export function Footer() {
  const { cfg } = useDeps();
  const { t } = useI18n();
  return (
    <footer>
      <h3>{t("footer.contracts")}</h3>
      <dl>
        <dt>
          {t("footer.wantos")} ({cfg.wantos.name} · {cfg.wantos.id})
        </dt>
        <dd>
          <a href={`${cfg.wantos.explorerUrl}/address/${cfg.wantos.bridge}`} target="_blank" rel="noopener noreferrer">
            <code>{cfg.wantos.bridge}</code>
          </a>
        </dd>
        <dt>
          {t("footer.bsc")} ({cfg.bsc.name} · {cfg.bsc.id})
        </dt>
        <dd>
          <a href={`${cfg.bsc.explorerUrl}/address/${cfg.bsc.bridge}`} target="_blank" rel="noopener noreferrer">
            <code>{cfg.bsc.bridge}</code>
          </a>
        </dd>
      </dl>
      <p className="muted">{t("footer.notice")}</p>
    </footer>
  );
}
