import type { Hex } from "viem";

/**
 * A broadcast transaction whose result is not known yet. It locks the same action for the same account and
 * chain until a receipt is read from the chain. Only the lock is persisted (sessionStorage, survives reload):
 * an outcome such as "confirmed" is never stored or restored — it can only come from a receipt. A forged
 * entry can only keep a button disabled longer; it cannot bypass the duplicate-submission guard.
 * sessionStorage is per tab: the lock protects this tab and its reloads only (defence in depth, not a spec
 * requirement); closing the tab resets it.
 */
export interface PendingTx {
  account: string;
  chainId: number;
  action: "w2b" | "b2w";
  hash: Hex;
  kind: "approve" | "send";
}

export type PendingMap = Record<string, PendingTx>;

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const KEY = "bridge.pending";

export const pendingKey = (account: string, chainId: number, action: "w2b" | "b2w") => `${account.toLowerCase()}:${chainId}:${action}`;

function valid(v: unknown): PendingTx | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.account)) return null;
  if (typeof o.chainId !== "number" || !Number.isSafeInteger(o.chainId)) return null;
  if (o.action !== "w2b" && o.action !== "b2w") return null;
  if (typeof o.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(o.hash)) return null;
  if (o.kind !== "approve" && o.kind !== "send") return null;
  return { account: o.account, chainId: o.chainId, action: o.action, hash: o.hash as Hex, kind: o.kind };
}

export function loadPending(s: StorageLike | null): PendingMap {
  try {
    const raw = s?.getItem(KEY);
    if (!raw) return {};
    const out: PendingMap = {};
    for (const v of Object.values(JSON.parse(raw) as Record<string, unknown>)) {
      const p = valid(v);
      if (p) out[pendingKey(p.account, p.chainId, p.action)] = p;
    }
    return out;
  } catch {
    return {};
  }
}

export function savePending(s: StorageLike | null, m: PendingMap): void {
  try {
    s?.setItem(KEY, JSON.stringify(m));
  } catch {
    /* storage unavailable: lock lives for this page only */
  }
}

export function sessionStore(): StorageLike | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}
