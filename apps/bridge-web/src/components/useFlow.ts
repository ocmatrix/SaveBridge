import { useState } from "react";
import { useConfig, useConnection } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { useDeps, useI18n, usePendingStore } from "../context";
import { describeError, translateError } from "../lib/errors";
import { clientFor } from "../lib/clients";
import type { Step, StepFn, TxContext, UnconfirmedTxError } from "../lib/flows";
import { pendingKey } from "../lib/pendingTx";

/**
 * Runs one approve→send flow with the connected wallet on `chainId`; exposes step / result / error text.
 * Errors before broadcast → `error`. A broadcast transaction whose receipt could not be obtained becomes a
 * page-level lock for (account, chain, action) (round-2 A1): shown with its hash, the same action stays
 * disabled until `recheck` reads a receipt from the chain.
 */
export function useFlow(chainId: number, decimals: number, action: "w2b" | "b2w") {
  const { cfg, clients } = useDeps();
  const { lang, t } = useI18n();
  const wagmiConfig = useConfig();
  const queryClient = useQueryClient();
  const { address } = useConnection();
  const store = usePendingStore();
  const key = address ? pendingKey(address, chainId, action) : null;
  const pending = key ? store.get(key) : null;
  const [step, setStep] = useState<Step | null>(null);
  const [hash, setHash] = useState<`0x${string}` | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
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
      if ((e as { name?: string }).name === "UnconfirmedTxError") {
        const u = e as UnconfirmedTxError;
        store.set({ account, chainId, action, hash: u.hash, kind: u.kind, nonce: u.nonce });
      } else setError(describeError(translateError(e, { decimals }), lang));
      return null;
    } finally {
      setStep(null);
      setHash(null);
      setBusy(false);
      await queryClient.invalidateQueries();
    }
  }

  /** The only way to release a lock: a receipt read from the chain. */
  async function recheck() {
    if (!pending || !key) return;
    setNote(null);
    setDone(null);
    setError(null);
    try {
      const r = await clientFor(cfg, clients, chainId).getTransactionReceipt({ hash: pending.hash });
      store.clear(key);
      if (r.status !== "success") setError(t("pending.reverted"));
      else setDone(t(pending.kind === "approve" ? "pending.approveConfirmed" : "pending.confirmed"));
      await queryClient.invalidateQueries();
    } catch {
      setNote(t("pending.notYet"));
    }
  }

  return { step, hash, busy, error, done, pending: pending?.hash ?? null, note, run, recheck };
}

export type Flow = ReturnType<typeof useFlow>;
