import type { Db } from "@bridge/relayer/src/db/types";
import type { Address, Hex } from "@bridge/relayer/src/types";
import { addrFromBytes, fromBytes, toBig, toBytes } from "@bridge/relayer/src/bytes";

export type Asset = "USDT" | "NATIVE" | string;

export interface FlowRow {
  txHash: Hex;
  logIndex: number; // -1 = top-level native transfer
  blockNumber: bigint;
  blockHash: Hex;
  blockTime: Date;
  asset: Asset;
  from: Address;
  to: Address;
  txFrom: Address;
  src: Address;
  amount: bigint;
  valueUsdt: bigint;
}

export interface SwapRow {
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  blockHash: Hex;
  blockTime: Date;
  pair: Address;
  sender: Address;
  to: Address;
  txFrom: Address;
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
}

export interface IndexState {
  lastBlock: bigint;
  lastBlockHash: Hex;
  lastBlockTime: Date | null;
  headBlock: bigint | null;
  checkedAt: Date | null;
  broken: string | null;
}

export const b = (a: string): Uint8Array => toBytes(a);

export async function insertFlows(db: Db, rows: FlowRow[]): Promise<void> {
  for (const r of rows) {
    await db.query(
      `insert into risk_flows (tx_hash, log_index, block_number, block_hash, block_time, asset, from_addr, to_addr, tx_from, src, amount, value_usdt)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (tx_hash, log_index) do nothing`,
      [b(r.txHash), r.logIndex, r.blockNumber.toString(), b(r.blockHash), r.blockTime, r.asset, b(r.from), b(r.to), b(r.txFrom), b(r.src), r.amount.toString(), r.valueUsdt.toString()],
    );
  }
}

export async function insertSwaps(db: Db, rows: SwapRow[]): Promise<void> {
  for (const r of rows) {
    await db.query(
      `insert into risk_swaps (tx_hash, log_index, block_number, block_hash, block_time, pair, sender, to_addr, tx_from, amount0_in, amount1_in, amount0_out, amount1_out)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (tx_hash, log_index) do nothing`,
      [b(r.txHash), r.logIndex, r.blockNumber.toString(), b(r.blockHash), r.blockTime, b(r.pair), b(r.sender), b(r.to), b(r.txFrom), r.amount0In.toString(), r.amount1In.toString(), r.amount0Out.toString(), r.amount1Out.toString()],
    );
  }
}

/** Removes everything indexed above `block` (reorg / rescan). */
export async function deleteAbove(db: Db, block: bigint): Promise<void> {
  await db.query("delete from risk_flows where block_number > $1", [block.toString()]);
  await db.query("delete from risk_swaps where block_number > $1", [block.toString()]);
  await db.query("delete from risk_index_checkpoints where block_number > $1", [block.toString()]);
}

export async function getState(db: Db): Promise<IndexState | null> {
  const r = await db.query<Record<string, unknown>>("select * from risk_index_state where id = 1");
  const x = r.rows[0];
  if (!x) return null;
  return {
    lastBlock: toBig(x.last_block),
    lastBlockHash: fromBytes(x.last_block_hash as Uint8Array)!,
    lastBlockTime: x.last_block_time ? new Date(x.last_block_time as string | Date) : null,
    headBlock: x.head_block === null || x.head_block === undefined ? null : toBig(x.head_block),
    checkedAt: x.checked_at ? new Date(x.checked_at as string | Date) : null,
    broken: (x.broken as string | null) ?? null,
  };
}

export async function putState(db: Db, s: IndexState): Promise<void> {
  await db.query(
    `insert into risk_index_state (id, last_block, last_block_hash, last_block_time, head_block, checked_at, broken)
     values (1,$1,$2,$3,$4,$5,$6)
     on conflict (id) do update set last_block = excluded.last_block, last_block_hash = excluded.last_block_hash,
       last_block_time = excluded.last_block_time, head_block = excluded.head_block, checked_at = excluded.checked_at, broken = excluded.broken`,
    [s.lastBlock.toString(), b(s.lastBlockHash), s.lastBlockTime, s.headBlock === null ? null : s.headBlock.toString(), s.checkedAt, s.broken],
  );
}

export interface ControlledEntry {
  addr: Address;
  label: string | null;
  effectiveFrom: Date | null;
}

/** Controlled source set (DESIGN 附录 A + §7), maintained by the owner via the admin backend (PR-6). */
export async function listControlled(db: Db): Promise<ControlledEntry[]> {
  const r = await db.query<Record<string, unknown>>("select addr, label, effective_from from controlled_set order by addr");
  return r.rows.map((x) => ({
    addr: addrFromBytes(x.addr as Uint8Array),
    label: (x.label as string | null) ?? null,
    effectiveFrom: x.effective_from ? new Date(x.effective_from as string | Date) : null,
  }));
}

/** Add/update an entry; always writes audit_log (§7: every change is audited). */
export async function upsertControlled(db: Db, actor: string, e: { addr: Address; label?: string | null; effectiveFrom?: Date | null }): Promise<void> {
  await db.tx(async (t) => {
    await t.query(
      `insert into controlled_set (addr, label, effective_from) values ($1,$2,$3)
       on conflict (addr) do update set label = excluded.label, effective_from = excluded.effective_from`,
      [b(e.addr), e.label ?? null, e.effectiveFrom ?? null],
    );
    await t.query("insert into audit_log (actor, action, payload) values ($1, 'controlled_set.upsert', $2)", [
      actor,
      JSON.stringify({ addr: e.addr.toLowerCase(), label: e.label ?? null, effectiveFrom: e.effectiveFrom?.toISOString() ?? null }),
    ]);
  });
}

export async function removeControlled(db: Db, actor: string, addr: Address): Promise<void> {
  await db.tx(async (t) => {
    await t.query("delete from controlled_set where addr = $1", [b(addr)]);
    await t.query("insert into audit_log (actor, action, payload) values ($1, 'controlled_set.remove', $2)", [actor, JSON.stringify({ addr: addr.toLowerCase() })]);
  });
}
