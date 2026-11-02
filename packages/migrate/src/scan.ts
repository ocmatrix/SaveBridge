import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { parseAmount } from "./amount.js";
import { checkLogIndex, isTxHash, oldKey } from "./oldkey.js";
import type { LegacySourceData, OldPayout, ScanEntry, ScanStatus, SourceOrder } from "./types.js";

export interface ScanOptions {
  /** Cut-over time T (unix seconds). Orders at or after T are excluded (AFTER_T). */
  cutoverT: number;
  /** oldKeys already paid on the new vault (`legacyPaid(oldKey) == true` or a `LegacyPaid` event). */
  alreadyPaid?: ReadonlySet<string>;
}

export interface ScanResult {
  /** Every distinct order, sorted, with its status. */
  entries: ScanEntry[];
  /** Only the PAYABLE ones (what goes into the manifest). */
  payable: ScanEntry[];
  /** Identical duplicate events dropped (orders + payouts). */
  duplicatesDropped: number;
  /** Linked old payouts whose source order is not in the input (reported, not used). */
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

interface NormOrder {
  key: Hex;
  o: SourceOrder;
  payee: Address;
  canon: string;
}

function normOrder(o: SourceOrder): NormOrder {
  if (!Number.isSafeInteger(o.srcChainId) || o.srcChainId <= 0) throw new Error(`bad srcChainId ${String(o.srcChainId)}`);
  if (!isTxHash(o.txHash)) throw new Error(`bad txHash ${String(o.txHash)}`);
  checkLogIndex(o.logIndex);
  if (!Number.isSafeInteger(o.timestamp) || o.timestamp <= 0) throw new Error(`bad timestamp ${String(o.timestamp)} in ${o.txHash}`);
  if (o.direction !== "W2B" && o.direction !== "B2W") throw new Error(`bad direction ${String(o.direction)}`);
  const from = addr(o.from, "from");
  // W2B pays the BSC recipient the user named (or the sender when the old event has no recipient);
  // B2W refunds the BSC depositor itself.
  const payee = o.direction === "W2B" && o.recipient !== undefined ? addr(o.recipient, "recipient") : from;
  const key = oldKey(o.txHash, o.logIndex);
  const canon = JSON.stringify([o.srcChainId, o.timestamp, o.direction, from, payee, o.amount]);
  return { key, o, payee, canon };
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

  // 2. old payouts: dedupe, then index linked sums and unlinked (payee|amount).
  const idx = indexOldPayouts(data.payouts);
  duplicatesDropped += idx.duplicatesDropped;
  const { linked, unlinked } = idx;
  const orphanPayouts = idx.linkedPayouts.filter(([k]) => !orders.has(k)).map(([, p]) => p);

  // 3. classify.
  const entries: ScanEntry[] = [];
  for (const { key, o, payee } of orders.values()) {
    let amount = 0n;
    let status: ScanStatus = "PAYABLE";
    let note: string | undefined;
    try {
      amount = parseAmount(o.amount);
    } catch (e) {
      status = "INVALID_AMOUNT";
      note = (e as Error).message;
    }
    const l = linked.get(key);
    if (status !== "PAYABLE") {
      /* keep INVALID_AMOUNT */
    } else if (payee === zeroAddress) status = "INVALID_ZERO_ADDRESS";
    else if (amount === 0n) status = "INVALID_ZERO_AMOUNT";
    else if (opts.alreadyPaid?.has(key)) status = "NEW_PAID";
    else if (l && l.sum >= amount) {
      status = "OLD_PAID";
      if (!l.to.has(payee) || l.to.size > 1) note = `old payout went to ${[...l.to].join(",")}`;
    } else if (l) {
      status = "OLD_PARTIAL";
      note = `old bridge paid ${l.sum} of ${amount}`;
    } else if (unlinked.has(`${payee}|${amount}`)) status = "SUSPECT_PAID";
    else if (o.timestamp >= opts.cutoverT) status = "AFTER_T";
    entries.push({ oldKey: key, srcChainId: o.srcChainId, srcTxHash: o.txHash.toLowerCase() as Hex, srcLogIndex: o.logIndex, direction: o.direction, timestamp: o.timestamp, payee, amount, status, ...(note ? { note } : {}) });
  }
  entries.sort(compareSrc);
  return { entries, payable: entries.filter((e) => e.status === "PAYABLE"), duplicatesDropped, orphanPayouts };
}

export interface OldPayoutIndex {
  linked: Map<Hex, { sum: bigint; to: Set<string> }>;
  /** `${checksummedTo}|${amountWei}` of payouts without a source link. */
  unlinked: Set<string>;
  linkedPayouts: [Hex, OldPayout][];
  duplicatesDropped: number;
}

/** Dedupes old-bridge payouts by (chainId, txHash, logIndex) — conflicting duplicates are fatal — and indexes them. */
export function indexOldPayouts(payouts: OldPayout[]): OldPayoutIndex {
  const seen = new Map<string, string>();
  const linked = new Map<Hex, { sum: bigint; to: Set<string> }>();
  const unlinked = new Set<string>();
  const linkedPayouts: [Hex, OldPayout][] = [];
  let duplicatesDropped = 0;
  for (const p of payouts) {
    if (!isTxHash(p.txHash)) throw new Error(`bad payout txHash ${String(p.txHash)}`);
    checkLogIndex(p.logIndex);
    const to = addr(p.to, "payout to");
    const amount = parseAmount(p.amount);
    const hasLink = p.srcTxHash !== undefined || p.srcLogIndex !== undefined;
    const link = hasLink ? oldKey(p.srcTxHash as Hex, p.srcLogIndex as number) : null;
    const id = `${p.chainId}|${p.txHash.toLowerCase()}|${p.logIndex}`;
    const canon = JSON.stringify([to, amount.toString(), link]);
    const prev = seen.get(id);
    if (prev !== undefined) {
      if (prev !== canon) throw new Error(`conflicting duplicate payout ${p.txHash}#${p.logIndex}`);
      duplicatesDropped++;
      continue;
    }
    seen.set(id, canon);
    if (link) {
      linkedPayouts.push([link, p]);
      const l = linked.get(link) ?? { sum: 0n, to: new Set<string>() };
      l.sum += amount;
      l.to.add(to);
      linked.set(link, l);
    } else {
      unlinked.add(`${to}|${amount}`);
    }
  }
  return { linked, unlinked, linkedPayouts, duplicatesDropped };
}
