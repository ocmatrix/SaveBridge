/**
 * Remembers the order / deposit ids this browser created, per address, so they keep showing after a reload even
 * beyond the event look-back. Convenience only: every id is re-read on chain and must belong to the address.
 */
export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export interface Known {
  w2b: bigint[];
  b2w: bigint[];
}

const MAX = 50;
const key = (addr: string) => `bridge.orders.${addr.toLowerCase()}`;

function ids(v: unknown): bigint[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && /^[1-9]\d{0,76}$/.test(x)).map((x) => BigInt(x));
}

export function loadKnown(s: StorageLike | null, addr: string): Known {
  try {
    const raw = s?.getItem(key(addr));
    if (!raw) return { w2b: [], b2w: [] };
    const j = JSON.parse(raw) as { w2b?: unknown; b2w?: unknown };
    return { w2b: ids(j.w2b), b2w: ids(j.b2w) };
  } catch {
    return { w2b: [], b2w: [] };
  }
}

export function saveKnown(s: StorageLike | null, addr: string, k: Known): void {
  try {
    const last = (a: bigint[]) => [...new Set(a.map(String))].slice(-MAX);
    s?.setItem(key(addr), JSON.stringify({ w2b: last(k.w2b), b2w: last(k.b2w) }));
  } catch {
    /* storage unavailable */
  }
}

export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
