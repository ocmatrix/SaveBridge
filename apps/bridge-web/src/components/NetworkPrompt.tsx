import { useEffect, useRef, useState } from "react";
import { useConnection, useSwitchChain } from "wagmi";
import type { ChainConf } from "../config";
import { useDeps, useI18n } from "../context";
import { addWantosNetwork, type Eip1193Like } from "../wallet/network";
import { describeError, translateError } from "../lib/errors";

/**
 * Shown when the wallet is on another chain. Both chains work by default: the switch is requested once on its own
 * (wagmi adds the chain from config when the wallet lacks it); the buttons stay as the fallback if it was refused.
 */
export function NetworkPrompt({ target }: { target: ChainConf }) {
  const { cfg } = useDeps();
  const { t, lang } = useI18n();
  const { connector } = useConnection();
  const { mutateAsync: switchChain, isPending } = useSwitchChain();
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(describeError(translateError(e, { decimals: 18 }), lang));
    }
  };

  const asked = useRef<number | null>(null);
  useEffect(() => {
    if (asked.current === target.id) return;
    asked.current = target.id;
    void run(() => switchChain({ chainId: target.id }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id]);

  return (
    <div className="notice warn">
      <p>{t("net.wrong", { chain: target.name })}</p>
      <div className="row">
        <button type="button" disabled={isPending} onClick={() => void run(() => switchChain({ chainId: target.id }))}>
          {t("net.switchTo", { chain: target.name })}
        </button>
        {target.id === cfg.wantos.id && connector && (
          <button
            type="button"
            className="secondary"
            onClick={() => void run(async () => addWantosNetwork((await connector.getProvider()) as Eip1193Like, cfg))}
          >
            {t("net.add", { chain: target.name })}
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
