import { useState } from "react";
import { useConnection } from "wagmi";
import { useDeps, useI18n } from "../context";
import type { BridgeState } from "../lib/reader";
import { formatAmount, parseAmountInput, validateW2B } from "../lib/amount";
import { bridgeOutFlow } from "../lib/flows";
import type { I18nKey } from "../i18n";
import { AmountField } from "./AmountField";
import { NetworkPrompt } from "./NetworkPrompt";
import { useFlow } from "./useFlow";
import { StepLine } from "./StepLine";

/** First reason the bridge-out button is disabled, or null. */
export function w2bBlocker(st: BridgeState): I18nKey | null {
  // B6: also when the payout side (BSC) is paused — otherwise the funds sit locked on WANTOS
  if (st.wantos.paused || st.bsc.paused) return "status.paused";
  // conservative: bridge out only when open on both chains (BSC release requires the BSC whitelist too)
  if (st.wl !== "open") return st.wl === "syncing" ? "wl.syncing" : "wl.closed";
  if (st.supplyCeilingHit) return "status.supplyCeiling";
  if (st.w2bRemaining < st.wantos.w2bMinAmount) return "quota.exhausted";
  return null;
}

export function W2BPanel({ state, onOrder }: { state: BridgeState | undefined; onOrder(id: bigint): void }) {
  const { cfg } = useDeps();
  const { t } = useI18n();
  const { address, chainId } = useConnection();
  const [input, setInput] = useState("");
  const dec = state?.wantos.decimals ?? 18;
  const flow = useFlow(cfg.wantos.id, dec);
  const f = (v: bigint) => formatAmount(v, dec);

  const wrongNet = !!address && chainId !== cfg.wantos.id;
  const blocker = state ? w2bBlocker(state) : null;
  const parsed = input.trim() ? parseAmountInput(input, dec) : null;
  const problem =
    parsed && state
      ? parsed.ok
        ? validateW2B({
            amount: parsed.value,
            min: state.wantos.w2bMinAmount,
            perAddrCap: state.wantos.w2bPerAddrDailyCap,
            addrRemaining: state.w2bRemaining,
            balance: state.wantos.balance,
            decimals: dec,
          })
        : parsed.error
      : null;
  const canSubmit = !!address && !!state && !wrongNet && !blocker && !!parsed?.ok && !problem && !flow.busy;
  const maxAmount = state ? [state.w2bRemaining, state.wantos.balance, state.wantos.w2bPerAddrDailyCap].reduce((a, b) => (a < b ? a : b)) : null;

  async function submit() {
    if (!address || !parsed?.ok) return;
    const r = await flow.run(address, (ctx, onStep) => bridgeOutFlow(ctx, parsed.value, onStep), (res) => t("step.w2bDone", { id: res.orderId.toString() }));
    if (r) {
      onOrder(r.orderId);
      setInput("");
    }
  }

  return (
    <section className="panel" aria-label={t("tab.w2b")}>
      <p className="desc">{t("w2b.desc")}</p>
      {!address && <p className="notice">{t("wallet.connectFirst")}</p>}
      {wrongNet && <NetworkPrompt target={cfg.wantos} />}
      {address && blocker && <p className="notice warn">{t(blocker)}</p>}
      {state && (
        <div className="quota">
          <div>{t("quota.w2bAddr", { amount: f(state.w2bRemaining) })}</div>
          <small>{t("quota.limits", { min: f(state.wantos.w2bMinAmount), max: f(state.wantos.w2bPerAddrDailyCap) })}</small>
        </div>
      )}
      <AmountField value={input} onChange={setInput} balance={address && state ? state.wantos.balance : null} max={address ? maxAmount : null} decimals={dec} disabled={flow.busy} />
      {problem && <p className="error">{t(problem.key, problem.params)}</p>}
      <StepLine step={flow.step} amount={parsed?.ok ? f(parsed.value) : ""} />
      {flow.done && <p className="ok">{flow.done}</p>}
      {flow.error && <p className="error">{flow.error}</p>}
      <button type="button" className="primary" disabled={!canSubmit} onClick={() => void submit()}>
        {t("w2b.submit")}
      </button>
    </section>
  );
}
