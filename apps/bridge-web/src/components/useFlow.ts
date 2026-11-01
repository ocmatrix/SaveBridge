import { useState } from "react";
import { useConfig } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { useQueryClient } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { useDeps, useI18n } from "../context";
import { describeError, translateError } from "../lib/errors";
import { clientFor } from "../lib/clients";
import type { Step, StepFn, TxContext } from "../lib/flows";

/**
 * Runs one approve→send flow with the connected wallet on `chainId`; exposes step / result / error text.
 * Errors before broadcast → `error`. A broadcast transaction whose receipt could not be obtained → `pending`
 * (shown as submitted-awaiting-confirmation with its hash); the same action stays locked until `recheck`
 * finds a receipt (B1).
 */
export function useFlow(chainId: number, decimals: number) {
  const { cfg, clients } = useDeps();
  const { lang, t } = useI18n();
  const wagmiConfig = useConfig();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step | null>(null);
  const [hash, setHash] = useState<Hex | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, setPending] = useState<Hex | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const onStep: StepFn = (s, h) => {
    setStep(s);
    setHash(h ?? null);
  };

  async function run<T>(account: Address, fn: (ctx: TxContext, onStep: StepFn) => Promise<T>, onSuccess: (r: T) => string) {
    if (pending) return null;
    setBusy(true);
    setError(null);
    setDone(null);
    setNote(null);
    try {
      const wallet = await getWalletClient(wagmiConfig, { chainId, account });
      const r = await fn({ cfg, clients, wallet }, onStep);
      setDone(onSuccess(r));
      return r;
    } catch (e) {
      if ((e as { name?: string }).name === "UnconfirmedTxError") setPending((e as { hash: Hex }).hash);
      else setError(describeError(translateError(e, { decimals }), lang));
      return null;
    } finally {
      setStep(null);
      setHash(null);
      setBusy(false);
      await queryClient.invalidateQueries();
    }
  }

  async function recheck() {
    if (!pending) return;
    setNote(null);
    try {
      const r = await clientFor(cfg, clients, chainId).getTransactionReceipt({ hash: pending });
      setPending(null);
      if (r.status === "success") setDone(t("pending.confirmed"));
      else setError(t("pending.reverted"));
      await queryClient.invalidateQueries();
    } catch {
      setNote(t("pending.notYet"));
    }
  }

  return { step, hash, busy, error, done, pending, note, run, recheck };
}

export type Flow = ReturnType<typeof useFlow>;
