import { useI18n } from "../context";
import { DecimalsMismatchError, type BridgeState } from "../lib/reader";

/**
 * Read problems at the top of the card. Pause / ceiling / whitelist reasons are shown by the panel itself
 * (they are what disables its button), so they are not repeated here.
 */
export function StatusBar({ state, loading, error, onRefresh }: { state: BridgeState | undefined; loading: boolean; error: unknown; onRefresh(): void }) {
  const { t } = useI18n();
  return (
    <div className="statusbar">
      {loading && !state && <p className="muted">{t("status.loading")}</p>}
      {error instanceof DecimalsMismatchError && <p className="bar warn">{t("status.decimalsMismatch")}</p>}
      {!!error && !(error instanceof DecimalsMismatchError) && (
        <p className="error">
          {t("status.readError")}{" "}
          <button type="button" className="link" onClick={onRefresh}>
            {t("status.refresh")}
          </button>
        </p>
      )}
    </div>
  );
}
