import { useI18n } from "../context";
import type { WalletState } from "../wallet/useAutoConnect";

/** The wallet list: the EVM wallets found in the browser (or the generic browser wallet). */
export function WalletPicker({ wallet }: { wallet: WalletState }) {
  const { t } = useI18n();
  if (!wallet.open) return null;
  return (
    <div className="picker" role="dialog" aria-label={t("wallet.choose")}>
      <div className="picker-head">
        <strong>{t("wallet.choose")}</strong>
        <button type="button" className="link" onClick={() => wallet.setOpen(false)}>
          {t("wallet.cancel")}
        </button>
      </div>
      {wallet.list.map((c) => (
        <button type="button" className="wallet-item" key={c.uid} disabled={wallet.connecting} onClick={() => void wallet.choose(c)}>
          {c.id === "injected" ? t("wallet.browser") : c.name}
        </button>
      ))}
      {wallet.error && <p className="error">{wallet.error}</p>}
    </div>
  );
}
