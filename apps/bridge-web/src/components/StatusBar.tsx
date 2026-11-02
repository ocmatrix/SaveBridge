import { useI18n } from "../context";
import { DecimalsMismatchError, type BridgeState } from "../lib/reader";

export function StatusBar({ state, connected, loading, error, onRefresh }: { state: BridgeState | undefined; connected: boolean; loading: boolean; error: unknown; onRefresh(): void }) {
  const { t } = useI18n();
  return (
    <div className="statusbar">
      {loading && <p>{t("status.loading")}</p>}
      {error instanceof DecimalsMismatchError && <p className="notice warn">{t("status.decimalsMismatch")}</p>}
      {!!error && !(error instanceof DecimalsMismatchError) && (
        <p className="error">
          {t("status.readError")}{" "}
          <button type="button" className="link" onClick={onRefresh}>
            {t("status.refresh")}
          </button>
        </p>
      )}
      {state && (state.wantos.paused || state.bsc.paused) && <p className="notice warn">{t("status.paused")}</p>}
      {state && state.supplyCeilingHit && <p className="notice warn">{t("status.supplyCeiling")}</p>}
      {state && connected && (
        <p className={`wl wl-${state.wl}`}>
          <span>{t("wl.label")}：</span>
          {t(state.wl === "open" ? "wl.open" : state.wl === "syncing" ? "wl.syncing" : "wl.closed")}
        </p>
      )}
    </div>
  );
}
