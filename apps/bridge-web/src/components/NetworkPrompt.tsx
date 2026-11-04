import { useEffect, useRef, useState } from "react";
import { useConnection } from "wagmi";
import type { ChainConf } from "../config";
import { useDeps, useI18n } from "../context";
import { requestChain, type Eip1193Like } from "../wallet/network";

/**
 * Both chains work by default: the switch is requested once on its own (wagmi adds the chain from config when the
 * wallet lacks it) and nothing is shown meanwhile. Only if that fails (chain missing or refused) a single button
 * appears; no other text.
 */
export function NetworkPrompt({ target }: { target: ChainConf }) {
  const { cfg } = useDeps();
  const { t } = useI18n();
  const { connector } = useConnection();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const isWantos = target.id === cfg.wantos.id;
  const short = isWantos ? "WANTOS" : "BSC";

  /** Direct EIP-1193 request: wagmi's own switch waits for a chainChanged event some wallets never send. */
  const run = async (add: boolean) => {
    if (!connector) return;
    setBusy(true);
    try {
      const provider = (await connector.getProvider()) as Eip1193Like;
      const now = await requestChain(provider, target, add);
      if (now === target.id) connector.onChainChanged(String(now));
      setFailed(now !== target.id);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const asked = useRef<number | null>(null);
  useEffect(() => {
    if (!connector || asked.current === target.id) return;
    asked.current = target.id;
    void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id, connector]);

  if (!failed) return null;
  return (
    <div className={`net-switch ${isWantos ? "wantos" : "bsc"}`}>
      <button type="button" disabled={busy} onClick={() => void run(true)}>
        <span className="dot" aria-hidden="true" />
        {t("net.switchTo", { chain: short })}
      </button>
    </div>
  );
}
