import { useEffect, useId, useState } from "react";
import { useConnection } from "wagmi";
import { getAddress } from "viem";
import { useDeps, useI18n } from "../context";
import type { BridgeState } from "../lib/reader";
import { formatAmount, parseAmountInput, validateB2W, validRecipient } from "../lib/amount";
import { depositFlow } from "../lib/flows";
import type { I18nKey } from "../i18n";
import { AmountField } from "./AmountField";
import { NetworkPrompt } from "./NetworkPrompt";
import { useFlow } from "./useFlow";
import { PendingTx, StepLine } from "./StepLine";

/** Deposits are disabled while either side is paused (conservative: the credit could not be processed). */
export function b2wBlocker(st: BridgeState): I18nKey | null {
  if (st.bsc.paused || st.wantos.paused) return "status.paused";
  if (st.b2wRemaining < st.bsc.minDeposit) return "quota.exhausted";
  return null;
}

export function B2WPanel({ state, onDeposit }: { state: BridgeState | undefined; onDeposit(nonce: bigint): void }) {
  const { cfg } = useDeps();
  const { t } = useI18n();
  const recipientId = useId();
  const { address, chainId } = useConnection();
  const [input, setInput] = useState("");
  const [recipient, setRecipient] = useState("");
  const dec = state?.bsc.decimals ?? 18;
  const flow = useFlow(cfg.bsc.id, dec, "b2w");
  const f = (v: bigint) => formatAmount(v, dec);

  useEffect(() => {
    if (address) setRecipient(address);
  }, [address]);

  const wrongNet = !!address && chainId !== cfg.bsc.id;
  const blocker = state ? b2wBlocker(state) : null;
  const recipientOk = validRecipient(recipient);
  const parsed = input.trim() ? parseAmountInput(input, dec) : null;
  const problem =
    parsed && state
      ? parsed.ok
        ? validateB2W({
            amount: parsed.value,
            minDeposit: state.bsc.minDeposit,
            maxDepositPerTx: state.bsc.maxDepositPerTx,
            b2wRemaining: state.b2wRemaining,
            balance: state.bsc.balance,
            decimals: dec,
          })
        : parsed.error
      : null;
  const canSubmit = !!address && !!state && !wrongNet && !blocker && recipientOk && !!parsed?.ok && !problem && !flow.busy && !flow.pending;
  const maxAmount = state ? [state.b2wRemaining, state.bsc.balance, state.bsc.maxDepositPerTx].reduce((a, b) => (a < b ? a : b)) : null;

  async function submit() {
    if (!address || !parsed?.ok || !recipientOk) return;
    const to = getAddress(recipient);
    const r = await flow.run(address, (ctx, onStep) => depositFlow(ctx, parsed.value, to, onStep), (res) => t("step.b2wDone", { id: res.nonce.toString() }));
    if (r) {
      onDeposit(r.nonce);
      setInput("");
    }
  }

  return (
    <section className="panel" aria-label={t("tab.b2w")}>
      <p className="desc">{t("b2w.desc")}</p>
      {!address && <p className="notice">{t("wallet.connectFirst")}</p>}
      {wrongNet && <NetworkPrompt target={cfg.bsc} />}
      {address && blocker && <p className="notice warn">{t(blocker)}</p>}
      {address && state && state.wl !== "open" && <p className="notice">{t("b2w.notOpenNote")}</p>}
      {state && (
        <div className="quota">
          <div>{t("quota.b2wGlobal", { amount: f(state.b2wRemaining) })}</div>
          <small>{t("quota.limits", { min: f(state.bsc.minDeposit), max: f(state.bsc.maxDepositPerTx) })}</small>
        </div>
      )}
      <div className="field">
        <label htmlFor={recipientId}>{t("b2w.recipient")}</label>
        <input id={recipientId} autoComplete="off" spellCheck={false} value={recipient} disabled={flow.busy} onChange={(e) => setRecipient(e.target.value.trim())} />
        <small className="warn-text">{t("b2w.recipientHint")}</small>
        {recipient && !recipientOk && <p className="error">{t("b2w.recipientInvalid")}</p>}
      </div>
      <AmountField value={input} onChange={setInput} balance={address && state ? state.bsc.balance : null} max={address ? maxAmount : null} decimals={dec} disabled={flow.busy} />
      {problem && <p className="error">{t(problem.key, problem.params)}</p>}
      <p className="hint">{t("b2w.eta")}</p>
      <StepLine flow={flow} amount={parsed?.ok ? f(parsed.value) : ""} />
      <PendingTx flow={flow} chain={cfg.bsc} />
      {flow.done && <p className="ok">{flow.done}</p>}
      {flow.error && <p className="error">{flow.error}</p>}
      {recipientOk && parsed?.ok && <p className="confirm">{t("b2w.confirmRecipient", { amount: f(parsed.value), to: getAddress(recipient) })}</p>}
      <button type="button" className="primary" disabled={!canSubmit} onClick={() => void submit()}>
        {t("b2w.submit")}
      </button>
    </section>
  );
}
