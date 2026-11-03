import { useEffect, useRef, useState } from "react";
import { useConnection, useSwitchChain } from "wagmi";
import type { ChainConf } from "../config";
import { useDeps, useI18n } from "../context";
import { addWantosNetwork, type Eip1193Like } from "../wallet/network";

/**
 * Both chains work by default: the switch is requested once on its own (wagmi adds the chain from config when the
 * wallet lacks it) and nothing is shown meanwhile. Only if that fails (chain missing or refused) a single button
 * appears; no other text.
 */
export function NetworkPrompt({ target }: { target: ChainConf }) {
  const { cfg } = useDeps();
  const { t } = useI18n();
  const { connector } = useConnection();
  const { mutateAsync: switchChain, isPending } = useSwitchChain();
  const [failed, setFailed] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };

  const asked = useRef<number | null>(null);
  useEffect(() => {
    if (asked.current === target.id) return;
    asked.current = target.id;
    void run(() => switchChain({ chainId: target.id }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id]);

  if (!failed) return null;
  return (
    <div className="net-switch">
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
  );
}
