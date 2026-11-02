import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { parseAmount } from "./amount.js";
import { checkLogIndex, isTxHash, oldKey } from "./oldkey.js";
import type { LegacySourceData, OldPayout, ScanEntry, ScanStatus, SourceOrder } from "./types.js";

export interface ScanOptions {
  /** Cut-over time T (unix seconds). Orders at or after T are excluded (AFTER_T). */
  cutoverT: number;
}

/**
 * Clock-skew allowance between the two chains: a loose payout counts against an order when it happened no earlier
 * than `orderTime - LOOSE_TIME_SKEW_SECONDS` (B7). Rules that name the order's own tx are never time-filtered.
 */
export const LOOSE_TIME_SKEW_SECONDS = 600;

export interface ScanResult {
  /** Every distinct order, sorted, with its status. */
  entries: ScanEntry[];
  /** Only the PAYABLE ones (what goes into the manifest). */
  payable: ScanEntry[];
  /** Identical duplicate events dropped (orders + payouts). */
  duplicatesDropped: number;
  /** Linked old payouts whose source order is not in the input (reported; they also count as unlinked payouts). */
  orphanPayouts: OldPayout[];
}

function addr(a: unknown, what: string): Address {
  if (typeof a !== "string" || !isAddress(a, { strict: false })) throw new Error(`bad ${what} address ${String(a)}`);
  return getAddress(a);
}

function sortKey(e: { srcChainId: number; srcTxHash: string; srcLogIndex: number }): [number, string, number] {
  return [e.srcChainId, e.srcTxHash.toLowerCase(), e.srcLogIndex];
}

export function compareSrc(a: { srcChainId: number; srcTxHash: string; srcLogIndex: number }, b: typeof a): number {
  const [ca, ta, la] = sortKey(a);
  const [cb, tb, lb] = sortKey(b);
  if (ca !== cb) return ca - cb;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return la - lb;
}

export interface NormOrder {
  key: Hex;
  o: SourceOrder;
  from: Address;
  payee: Address;
  /** recipient named by the old event (or `from`). */
  named: Address;
  canon: string;
}

/** Normalised view of one old order (also used by the preflight to re-check a manifest row against the source). */
export function normOrder(raw: SourceOrder): NormOrder {
  // hex case is normalised once, at the entry (B5)
  const o: SourceOrder = { ...raw, txHash: (typeof raw.txHash === "string" ? raw.txHash.toLowerCase() : raw.txHash) as Hex };
  if (!Number.isSafeInteger(o.srcChainId) || o.srcChainId <= 0) throw new Error(`bad srcChainId ${String(o.srcChainId)}`);
  if (!isTxHash(o.txHash)) throw new Error(`bad txHash ${String(o.txHash)}`);
  checkLogIndex(o.logIndex);
  if (!Number.isSafeInteger(o.timestamp) || o.timestamp <= 0) throw new Error(`bad timestamp ${String(o.timestamp)} in ${o.txHash}`);
  if (o.direction !== "W2B" && o.direction !== "B2W") throw new Error(`bad direction ${String(o.direction)}`);
  const from = addr(o.from, "from");
  // W2B pays the BSC recipient the user named (or the sender when the old event has no recipient);
  // B2W refunds the BSC depositor itself.
  const named = o.recipient !== undefined ? addr(o.recipient, "recipient") : from;
  const payee = o.direction === "W2B" ? named : from;
  const key = oldKey(o.txHash, o.logIndex);
  const canon = JSON.stringify([o.srcChainId, o.timestamp, o.direction, from, named, o.amount]);
  return { key, o, from, payee, named, canon };
}

export function scanLegacy(data: LegacySourceData, opts: ScanOptions): ScanResult {
  if (!Number.isSafeInteger(opts.cutoverT) || opts.cutoverT <= 0) throw new Error("cutoverT (T) is required");
  let duplicatesDropped = 0;

  // 1. orders: dedupe by oldKey; identical duplicates dropped, conflicting ones are fatal.
  const orders = new Map<Hex, NormOrder>();
  for (const raw of data.orders) {
    const n = normOrder(raw);
    const prev = orders.get(n.key);
    if (prev) {
      if (prev.canon !== n.canon) throw new Error(`conflicting duplicate order ${raw.txHash}#${raw.logIndex}`);
      duplicatesDropped++;
      continue;
    }
    orders.set(n.key, n);
  }

  // 2. old payouts: dedupe, index linked sums; payouts not linked to a known order are "loose".
  const idx = indexOldPayouts(data.payouts, new Set(orders.keys()));
  duplicatesDropped += idx.duplicatesDropped;

  // 3. classify.
  const entries: ScanEntry[] = [];
  for (const { key, o, from, payee, named } of orders.values()) {
    let amount = 0n;
    let status: ScanStatus = "PAYABLE";
    let note: string | undefined;
    try {
      amount = parseAmount(o.amount);
    } catch (e) {
      status = "INVALID_AMOUNT";
      note = (e as Error).message;
    }
    const l = idx.linked.get(key);
    const loose = looseHit(idx, o.txHash, [from, payee, named], o.timestamp);
    if (status !== "PAYABLE") {
      /* keep INVALID_AMOUNT */
    } else if (payee === zeroAddress) status = "INVALID_ZERO_ADDRESS";
    else if (amount === 0n) status = "INVALID_ZERO_AMOUNT";
    else if (l && l.sum >= amount) {
      status = "OLD_PAID";
      if (!l.to.has(payee) || l.to.size > 1) note = `old payout went to ${[...l.to].join(",")}`;
    } else if (l) {
      status = "OLD_PARTIAL";
      note = `old bridge paid ${l.sum} of ${amount}`;
    } else if (loose) {
      status = "SUSPECT_PAID";
      note = loose;
    } else if (o.timestamp >= opts.cutoverT) status = "AFTER_T";
    entries.push({ oldKey: key, srcChainId: o.srcChainId, srcTxHash: o.txHash, srcLogIndex: o.logIndex, direction: o.direction, timestamp: o.timestamp, payee, srcRecipient: named, amount, status, ...(note ? { note } : {}) });
  }
  entries.sort(compareSrc);
  return { entries, payable: entries.filter((e) => e.status === "PAYABLE"), duplicatesDropped, orphanPayouts: idx.orphans };
}

/**
 * A "loose" old payout (unlinked, or linked to an order we do not know) is a reason for manual review when:
 * - it names this order's tx (with another or no logIndex) — no time filter, it points at this tx explicitly; or
 * - it went to any address of this order (any amount — the old bridge may have taken a fee), at or after
 *   `orderTime - LOOSE_TIME_SKEW_SECONDS` (earlier payouts cannot be for it). Payouts without a time always count.
 * Returns the reason, or null.
 */
export function looseHit(idx: OldPayoutIndex, txHash: string, addrs: Address[], orderTime: number): string | null {
  const tx = txHash.toLowerCase();
  if (idx.looseSrcTx.has(tx)) return `an old payout names ${tx} without being linked to this order`;
  const hit = addrs.find((a) => (idx.looseTo.get(a) ?? -Infinity) >= orderTime - LOOSE_TIME_SKEW_SECONDS);
  return hit ? `an old payout not linked to this order went to ${hit}` : null;
}

export interface OldPayoutIndex {
  /** Payouts linked to a known order: sum and recipients per oldKey. */
  linked: Map<Hex, { sum: bigint; to: Set<string> }>;
  /** Recipient (checksummed) -> latest time of a loose payout to it (Infinity when the time is unknown). */
  looseTo: Map<string, number>;
  /** Lower-case srcTxHash named by payouts not linked to a known order (other logIndex, or no logIndex at all). */
  looseSrcTx: Set<string>;
  /** Linked payouts whose order is unknown. */
  orphans: OldPayout[];
  duplicatesDropped: number;
}

const later = (m: Map<string, number>, k: string, t: number): void => {
  m.set(k, Math.max(m.get(k) ?? -1, t));
};

/**
 * Dedupes old-bridge payouts by (chainId, txHash, logIndex) — conflicting duplicates are fatal — and indexes them.
 * A payout linked to an oldKey outside `knownOrders` is treated as loose (never silently ignored).
 */
export function indexOldPayouts(payouts: OldPayout[], knownOrders: ReadonlySet<string>): OldPayoutIndex {
  const seen = new Map<string, string>();
  const linked = new Map<Hex, { sum: bigint; to: Set<string> }>();
  const looseTo = new Map<string, number>();
  const looseSrcTx = new Set<string>();
  const orphans: OldPayout[] = [];
  let duplicatesDropped = 0;
  for (const raw of payouts) {
    // hex case is normalised once, at the entry (B5)
    const p: OldPayout = { ...raw, txHash: (typeof raw.txHash === "string" ? raw.txHash.toLowerCase() : raw.txHash) as Hex, ...(typeof raw.srcTxHash === "string" ? { srcTxHash: raw.srcTxHash.toLowerCase() as Hex } : {}) };
    if (!isTxHash(p.txHash)) throw new Error(`bad payout txHash ${String(p.txHash)}`);
    checkLogIndex(p.logIndex);
    if (p.timestamp !== undefined && (!Number.isSafeInteger(p.timestamp) || p.timestamp <= 0)) throw new Error(`bad payout timestamp ${String(p.timestamp)}`);
    const to = addr(p.to, "payout to");
    const amount = parseAmount(p.amount);
    // a full link needs both fields; srcTxHash alone (some old formats) names a tx but no order -> loose by tx
    if (p.srcTxHash !== undefined && !isTxHash(p.srcTxHash)) throw new Error(`bad payout srcTxHash ${String(p.srcTxHash)}`);
    const link = p.srcTxHash !== undefined && p.srcLogIndex !== undefined ? oldKey(p.srcTxHash, p.srcLogIndex) : null;
    const id = `${p.chainId}|${p.txHash}|${p.logIndex}`;
    const canon = JSON.stringify([to, amount.toString(), link, p.srcTxHash ?? null]);
    const prev = seen.get(id);
    if (prev !== undefined) {
      if (prev !== canon) throw new Error(`conflicting duplicate payout ${p.txHash}#${p.logIndex}`);
      duplicatesDropped++;
      continue;
    }
    seen.set(id, canon);
    if (link && knownOrders.has(link)) {
      const l = linked.get(link) ?? { sum: 0n, to: new Set<string>() };
      l.sum += amount;
      l.to.add(to);
      linked.set(link, l);
      continue;
    }
    const t = p.timestamp ?? Number.POSITIVE_INFINITY;
    later(looseTo, to, t);
    if (link) orphans.push(p);
    if (p.srcTxHash !== undefined) looseSrcTx.add(p.srcTxHash);
  }
  return { linked, looseTo, looseSrcTx, orphans, duplicatesDropped };
}
