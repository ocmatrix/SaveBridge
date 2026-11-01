import { useState } from "react";
import { useConfig } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { useDeps, useI18n } from "../context";
import { describeError, translateError } from "../lib/errors";
import type { Step, TxContext } from "../lib/flows";

/** Runs one approve→send flow with the connected wallet on `chainId`; exposes step / result / error text. */
export function useFlow(chainId: number, decimals: number) {
  const { cfg, clients } = useDeps();
  const { lang } = useI18n();
  const wagmiConfig = useConfig();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run<T>(account: Address, fn: (ctx: TxContext, onStep: (s: Step) => void) => Promise<T>, onSuccess: (r: T) => string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const wallet = await getWalletClient(wagmiConfig, { chainId, account });
      const r = await fn({ cfg, clients, wallet }, setStep);
      setDone(onSuccess(r));
      return r;
    } catch (e) {
      setError(describeError(translateError(e, { decimals }), lang));
      return null;
    } finally {
      setStep(null);
      setBusy(false);
      await queryClient.invalidateQueries();
    }
  }

  return { step, busy, error, done, run };
}
