import { useState } from "react";
import { useConnection } from "wagmi";
import { useDeps, useI18n } from "../context";
import type { BridgeState } from "../lib/reader";
import { formatAmount, parseAmountInput, validateW2B } from "../lib/amount";
import { bridgeOutFlow } from "../lib/flows";
import type { I18nKey } from "../i18n";
import type { WalletState } from "../wallet/useAutoConnect";
import { AmountBox, FlipButton, short } from "./AmountBox";
import { NetworkPrompt } from "./NetworkPrompt";
import { useFlow } from "./useFlow";
import { PendingTx, StepLine } from "./StepLine";
import { WalletNote } from "./WalletNote";
import { formatUnits, getAddress } from "viem";

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

export function W2BPanel({ state, onOrder, wallet, onFlip }: { state: BridgeState | undefined; onOrder(id: bigint): void; wallet: WalletState; onFlip(): void }) {
  const { cfg } = useDeps();
  const { t } = useI18n();
  const { address, chainId } = useConnection();
  const [input, setInput] = useState("");
  const dec = state?.wantos.decimals ?? 18;
  const flow = useFlow(cfg.wantos.id, dec, "w2b");
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
  const canSubmit = !!address && !!state && !wrongNet && !blocker && !!parsed?.ok && !problem && !flow.busy && !flow.pending;
  const maxAmount = state ? [state.w2bRemaining, state.wantos.balance, state.wantos.w2bPerAddrDailyCap].reduce((a, b) => (a < b ? a : b)) : null;
  const amountText = parsed?.ok ? f(parsed.value) : "";

  async function submit() {
    if (!address || !parsed?.ok) return;
    const r = await flow.run(address, (ctx, onStep) => bridgeOutFlow(ctx, parsed.value, onStep), (res) => t("step.w2bDone", { id: res.orderId.toString() }));
    if (r) {
      onOrder(r.orderId);
      setInput("");
    }
  }

  const label = !address
    ? wallet.connecting
      ? t("wallet.connecting")
      : t("cta.noWallet", { app: cfg.appName })
    : blocker === "wl.closed"
      ? t("cta.closed")
      : canSubmit
        ? t("cta.w2b", { amount: amountText })
        : parsed?.ok && !problem
          ? t("w2b.submit")
          : t("cta.enterAmount");

  return (
    <section className="panel" aria-label={t("tab.w2b")}>
      {!address && <WalletNote wallet={wallet} />}
      {wrongNet && <NetworkPrompt target={cfg.wantos} />}
      {address && blocker && <p className="bar warn">{t(blocker)}</p>}
      <AmountBox
        side="from"
        tone="wantos"
        chainName={cfg.wantos.name}
        top={
          address && state ? (
            <>
              <span>{t("amount.balance", { amount: f(state.wantos.balance) })}</span>
              {maxAmount !== null && maxAmount > 0n && (
                <button type="button" className="chip" disabled={flow.busy} onClick={() => setInput(formatUnits(maxAmount, dec))}>
                  {t("amount.max")}
                </button>
              )}
            </>
          ) : null
        }
        inputLabel={t("amount.label")}
        value={input}
        onChange={setInput}
        disabled={!address || flow.busy}
      />
      <FlipButton onClick={onFlip} disabled={flow.busy} />
      <AmountBox
        side="to"
        tone="bsc"
        chainName={cfg.bsc.name}
        top={address ? <span>{t("swap.recipient")} {short(getAddress(address))}</span> : null}
        inputLabel={t("amount.receive")}
        value={amountText}
        readOnly
      />
      {state && <p className="info">{t("info.w2b", { amount: f(state.w2bRemaining), min: f(state.wantos.w2bMinAmount), max: f(state.wantos.w2bPerAddrDailyCap) })}</p>}
      {problem && <p className="error">{t(problem.key, problem.params)}</p>}
      {canSubmit && !flow.step && (
        <p className="info">
          {t("steps.hint")}。{t("amount.approveNote", { amount: amountText })}
        </p>
      )}
      <StepLine flow={flow} amount={amountText} />
      <PendingTx flow={flow} chain={cfg.wantos} />
      {flow.done && <p className="ok">{flow.done}</p>}
      {flow.error && <p className="error">{flow.error}</p>}
      <button type="button" className="cta" data-testid="submit" disabled={!canSubmit} onClick={() => void submit()}>
        {label}
      </button>
    </section>
  );
}
