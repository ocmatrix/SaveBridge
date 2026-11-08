import { useI18n } from "../context";
import type { ChainConf } from "../config";
import type { Flow } from "./useFlow";

export function StepLine({ flow, amount }: { flow: Flow; amount: string }) {
  const { t } = useI18n();
  const { step, hash } = flow;
  if (!step) return null;
  // broadcast, hash known: the hash on its own, then what it means (layout only; same condition as before)
  if (step !== "approve" && step !== "send" && hash) {
    return (
      <p className="step" role="status">
        <span className="step-label">{t("step.hashLabel")}</span>
        <span className="step-hash">{hash}</span>
        <span className="step-msg">{t("step.submitted")}</span>
      </p>
    );
  }
  const text = step === "approve" ? t("step.approve", { amount }) : step === "send" ? t("step.send") : t("step.confirming");
  return (
    <p className="step" role="status">
      {text}
    </p>
  );
}

/** A broadcast transaction without a known result: hash, explorer link, re-check; never "failed" (B1). */
export function PendingTx({ flow, chain }: { flow: Flow; chain: ChainConf }) {
  const { t } = useI18n();
  if (!flow.pending) return null;
  return (
    <div className="notice warn">
      <p className="hash">{t("err.unconfirmed", { hash: flow.pending })}</p>
      <div className="row">
        <a href={`${chain.explorerUrl}/tx/${flow.pending}`} target="_blank" rel="noopener noreferrer">
          {t("pending.check")}
        </a>
        <button type="button" className="secondary" onClick={() => void flow.recheck()}>
          {t("pending.recheck")}
        </button>
      </div>
      {flow.note && <p>{flow.note}</p>}
    </div>
  );
}
