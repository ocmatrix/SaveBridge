import { useEffect, useId, useState } from "react";
import { useConnection } from "wagmi";
import { formatUnits, getAddress } from "viem";
import { useDeps, useI18n } from "../context";
import type { BridgeState } from "../lib/reader";
import { formatAmount, parseAmountInput, validateB2W, validRecipient } from "../lib/amount";
import { depositFlow } from "../lib/flows";
import { formatNative } from "../lib/fee";
import { useDepositFee } from "../hooks";
import type { I18nKey } from "../i18n";
import type { WalletState } from "../wallet/useAutoConnect";
import { AmountBox, FlipButton, short } from "./AmountBox";
import { NetworkPrompt } from "./NetworkPrompt";
import { useFlow } from "./useFlow";
import { PendingTx, StepLine } from "./StepLine";
import { WalletNote } from "./WalletNote";

/** Deposits are disabled while either side is paused (conservative: the credit could not be processed). */
export function b2wBlocker(st: BridgeState): I18nKey | null {
  if (st.bsc.paused || st.wantos.paused) return "status.paused";
  if (st.b2wRemaining < st.bsc.minDeposit) return "quota.exhausted";
  return null;
}

export function B2WPanel({ state, onDeposit, wallet, onFlip }: { state: BridgeState | undefined; onDeposit(nonce: bigint): void; wallet: WalletState; onFlip(): void }) {
  const { cfg } = useDeps();
  const { t } = useI18n();
  const recipientId = useId();
  const { address, chainId } = useConnection();
  const [input, setInput] = useState("");
  const [recipient, setRecipient] = useState("");
  const [editing, setEditing] = useState(false);
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
  const amountText = parsed?.ok ? f(parsed.value) : "";
  const feeQuery = useDepositFee(address);
  const fee = feeQuery.data?.fee ?? 0n;
  const customRecipient = !!address && recipientOk && getAddress(recipient) !== getAddress(address);

  async function submit() {
    if (!address || !parsed?.ok || !recipientOk) return;
    const to = getAddress(recipient);
    const r = await flow.run(address, (ctx, onStep) => depositFlow(ctx, parsed.value, to, onStep), (res) => t("step.b2wDone", { id: res.nonce.toString() }));
    if (r) {
      onDeposit(r.nonce);
      setInput("");
    }
  }

  const label = !address
    ? wallet.connecting
      ? t("wallet.connecting")
      : t("wallet.connect")
    : canSubmit
      ? t("cta.b2w", { amount: amountText })
      : parsed?.ok && !problem
        ? t("b2w.submit")
        : t("cta.enterAmount");

  return (
    <section className="panel" aria-label={t("tab.b2w")}>
      {!address && <WalletNote wallet={wallet} />}
      {wrongNet && <NetworkPrompt target={cfg.bsc} />}
      {address && blocker && <p className="bar warn">{t(blocker)}</p>}
      <AmountBox
        side="from"
        tone="bsc"
        chainName={cfg.bsc.name}
        top={
          address && state ? (
            <>
              <span>{t("amount.balance", { amount: f(state.bsc.balance) })}</span>
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
        tone="wantos"
        chainName={cfg.wantos.name}
        top={
          address ? (
            <>
              <span>
                {t("swap.recipient")} {recipientOk ? short(getAddress(recipient)) : "—"}
              </span>
              <button type="button" className="chip" disabled={flow.busy} aria-expanded={editing} onClick={() => setEditing((e) => !e)}>
                {t("swap.edit")}
              </button>
            </>
          ) : null
        }
        inputLabel={t("amount.receive")}
        value={amountText}
        readOnly
      />
      {editing && (
        <div className="field">
          <label htmlFor={recipientId}>{t("b2w.recipient")}</label>
          <input id={recipientId} autoComplete="off" spellCheck={false} value={recipient} disabled={flow.busy} onChange={(e) => setRecipient(e.target.value.trim())} />
          <small className="warn-text">{t("b2w.recipientHint")}</small>
          {recipient && !recipientOk && <p className="error">{t("b2w.recipientInvalid")}</p>}
        </div>
      )}
      {state && <p className="info">{t("info.b2w", { min: f(state.bsc.minDeposit) })}</p>}
      {problem && <p className="error">{t(problem.key, problem.params)}</p>}
      {fee > 0n && <p className="info" data-testid="fee">{t("info.feeB2w", { fee: formatNative(fee), symbol: cfg.bsc.nativeSymbol })}</p>}
      {canSubmit && !flow.step && (
        <p className="info">
          {t("steps.hint")}。{t("amount.approveNote", { amount: amountText })} {t("b2w.eta")}
        </p>
      )}
      {customRecipient && parsed?.ok && <p className="confirm">{t("b2w.confirmRecipient", { amount: amountText, to: getAddress(recipient) })}</p>}
      <StepLine flow={flow} amount={amountText} />
      <PendingTx flow={flow} chain={cfg.bsc} />
      {flow.done && <p className="ok">{flow.done}</p>}
      {flow.error && <p className="error">{flow.error}</p>}
      <button type="button" className="cta" data-testid="submit" disabled={address ? !canSubmit : wallet.connecting} onClick={() => (address ? void submit() : wallet.setOpen(true))}>
        {label}
      </button>
    </section>
  );
}
