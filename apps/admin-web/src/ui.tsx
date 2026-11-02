import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getAddress, type Address } from "viem";
import { describeError, type Chains, type Signer } from "./lib/chain";
import type { AppConfig } from "./lib/config";
import type { Gate } from "./lib/perm";
import { readBoth, type BothStates } from "./lib/state";
import type { AdminApi } from "./lib/api";

export interface AppCtx {
  cfg: AppConfig;
  chains: Chains;
  signer: Signer | null;
  /** null when VITE_ADMIN_API is not configured */
  api: AdminApi | null;
  both: BothStates | null;
  loadError: string | null;
  reload: () => Promise<void>;
}

export const Ctx = createContext<AppCtx | null>(null);
export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("no app context");
  return c;
}

/** Live chain state of both chains (re-read after each action). */
export function useBothStates(chains: Chains) {
  const [both, setBoth] = useState<BothStates | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const live = useRef(true);
  const reload = useCallback(async () => {
    try {
      const b = await readBoth(chains);
      if (live.current) {
        setBoth(b);
        setErr(null);
      }
    } catch (e) {
      if (live.current) setErr(describeError(e));
    }
  }, [chains]);
  useEffect(() => {
    live.current = true;
    void reload();
    const t = setInterval(() => void reload(), 30_000);
    return () => {
      live.current = false;
      clearInterval(t);
    };
  }, [reload]);
  return { both, err, reload };
}

export function Addr({ a }: { a: string }) {
  let s = a;
  try {
    s = getAddress(a);
  } catch {
    /* show raw */
  }
  return (
    <code className="addr" title={s}>
      {s}
    </code>
  );
}

/**
 * A write button. Disabled — with the reason shown next to it — whenever the gate (decided from contract reads) fails.
 * `confirmText` adds a second click for dangerous actions.
 */
export function ActionButton(p: { label: string; gate: Gate; run: () => Promise<unknown>; confirmText?: string; danger?: boolean }) {
  const { reload } = useApp();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const go = async () => {
    setAsking(false);
    setBusy(true);
    setMsg(null);
    try {
      await p.run();
      setMsg({ ok: true, text: "已完成" });
    } catch (e) {
      setMsg({ ok: false, text: describeError(e) });
    } finally {
      setBusy(false);
      await reload();
    }
  };
  return (
    <span className="action">
      <button type="button" className={p.danger ? "danger" : undefined} disabled={!p.gate.ok || busy} onClick={() => (p.confirmText ? setAsking(true) : void go())}>
        {busy ? "处理中…" : p.label}
      </button>
      {!p.gate.ok && <span className="why">{p.gate.reason}</span>}
      {asking && (
        <span className="confirm" role="alertdialog">
          {p.confirmText}
          <button type="button" className="danger" onClick={() => void go()}>
            确认
          </button>
          <button type="button" onClick={() => setAsking(false)}>
            取消
          </button>
        </span>
      )}
      {msg && <span className={msg.ok ? "ok" : "err"}>{msg.text}</span>}
    </span>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export const me = (s: Signer | null): Address | undefined => s?.address;
export const ts = (t: bigint) => (t === 0n ? "—" : new Date(Number(t) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC");
