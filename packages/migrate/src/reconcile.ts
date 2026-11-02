import { bscVaultV2Abi } from "@bridge/abi";
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { indexOldPayouts, looseHit } from "./scan.js";
import type { LegacyPaidEvent, Manifest, ManifestEntry, OldPayout } from "./types.js";

export interface PreflightInput {
  /** `vault.legacyPaid(oldKey)` on the new vault. */
  isLegacyPaid: (oldKey: Hex) => Promise<boolean>;
  /** Old-bridge payouts re-read right before execution (DESIGN §10: "每批放款前再查一次旧 BSC 金库"). */
  oldPayouts: OldPayout[];
  /**
   * oldKeys of every old order known (e.g. all orders the RPC loader returned). Payouts linked to an oldKey outside
   * this set are "loose" and block any row whose address they paid. Default: only the rows being checked (strictest).
   */
  knownOrders?: ReadonlySet<string>;
}

export interface PreflightResult {
  ok: boolean;
  blockers: string[];
}

/** Run before `execute`: any blocker means do not execute (cancel the operation and re-propose without that row). */
export async function preflightBatch(entries: ManifestEntry[], input: PreflightInput): Promise<PreflightResult> {
  const blockers: string[] = [];
  const known = new Set([...(input.knownOrders ?? []), ...entries.map((e) => e.oldKey)].map((k) => k.toLowerCase()));
  const idx = indexOldPayouts(input.oldPayouts, known);
  for (const e of entries) {
    if (await input.isLegacyPaid(e.oldKey)) blockers.push(`${e.oldKey}: already paid on the new vault`);
    const l = idx.linked.get(e.oldKey.toLowerCase() as Hex);
    if (l) blockers.push(`${e.oldKey}: old bridge paid ${l.sum} for this order since the manifest was built`);
    const loose = looseHit(idx, e.srcTxHash, [e.to, e.srcRecipient]);
    if (loose) blockers.push(`${e.oldKey}: ${loose}`);
  }
  return { ok: blockers.length === 0, blockers };
}

export interface ReconcileResult {
  ok: boolean;
  /** All rows paid and ΣLegacyPaid == Σmanifest. */
  complete: boolean;
  errors: string[];
  manifestCount: number;
  manifestTotal: bigint;
  paidCount: number;
  /** ΣLegacyPaid as seen on-chain (all events, including unknown ones). */
  legacyPaidTotal: bigint;
  unpaid: ManifestEntry[];
}

/** Matches on-chain `LegacyPaid` events against the published manifest(s). Any unknown / mismatching / repeated payment is an error. */
export function reconcileLegacy(manifests: Manifest[], events: LegacyPaidEvent[]): ReconcileResult {
  const errors: string[] = [];
  const rows = new Map<string, ManifestEntry>();
  for (const m of manifests)
    for (const e of m.entries) {
      const k = e.oldKey.toLowerCase();
      if (rows.has(k)) errors.push(`oldKey ${e.oldKey} appears in more than one manifest`);
      rows.set(k, e);
    }
  const paid = new Set<string>();
  let legacyPaidTotal = 0n;
  for (const ev of events) {
    const k = ev.oldKey.toLowerCase();
    legacyPaidTotal += ev.amount;
    const row = rows.get(k);
    if (paid.has(k)) errors.push(`oldKey ${ev.oldKey} paid more than once`);
    paid.add(k);
    if (!row) {
      errors.push(`LegacyPaid ${ev.oldKey} (${ev.amount} to ${ev.to}) is not in any published manifest`);
      continue;
    }
    if (getAddress(ev.to) !== row.to) errors.push(`oldKey ${ev.oldKey}: paid to ${ev.to}, manifest says ${row.to}`);
    if (ev.amount !== row.amount) errors.push(`oldKey ${ev.oldKey}: paid ${ev.amount}, manifest says ${row.amount}`);
  }
  const unpaid = [...rows.values()].filter((e) => !paid.has(e.oldKey.toLowerCase()));
  const manifestTotal = [...rows.values()].reduce((s, e) => s + e.amount, 0n);
  const ok = errors.length === 0;
  return { ok, complete: ok && unpaid.length === 0 && legacyPaidTotal === manifestTotal, errors, manifestCount: rows.size, manifestTotal, paidCount: paid.size, legacyPaidTotal, unpaid };
}

/** Reads every `LegacyPaid` from the vault. */
export async function readLegacyPaid(client: PublicClient, vault: Address, fromBlock: bigint, toBlock?: bigint): Promise<LegacyPaidEvent[]> {
  const logs = await client.getContractEvents({ address: vault, abi: bscVaultV2Abi, eventName: "LegacyPaid", fromBlock, ...(toBlock !== undefined ? { toBlock } : {}), strict: true });
  return logs.map((l) => {
    const a = l.args as { oldKey: Hex; to: Address; amount: bigint };
    return { oldKey: a.oldKey, to: a.to, amount: a.amount, txHash: l.transactionHash };
  });
}

export function legacyPaidReader(client: PublicClient, vault: Address): (k: Hex) => Promise<boolean> {
  return (k) => client.readContract({ address: vault, abi: bscVaultV2Abi, functionName: "legacyPaid", args: [k] }) as Promise<boolean>;
}
