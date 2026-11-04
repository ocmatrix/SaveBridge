import { useI18n } from "../context";
import type { WalletState } from "../wallet/useAutoConnect";

/** Shown while there is no wallet: none detected (open the page inside the app) or the connection was refused. */
export function WalletNote({ wallet }: { wallet: WalletState }) {
  const { t } = useI18n();
  if (!wallet.note) return null;
  return (
    <p className="bar warn">
      {wallet.note}{" "}
      <button type="button" className="link" onClick={wallet.retry}>
        {t("wallet.retry")}
      </button>
    </p>
  );
}
