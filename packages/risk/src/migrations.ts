import type { Db } from "@bridge/relayer/src/db/types";

/**
 * PR-4 tables (self-built WANTOS transaction index, PR3-NOTES Q3). Versions live in the relayer's
 * `schema_migrations` table in the 4xx range so they never collide with relayer versions (1..99).
 * Requires the relayer migrations (controlled_set) to have run first.
 *
 * risk_flows: one row per value movement — ERC-20 Transfer of USDT/MG/TIDE (log_index ≥ 0) or a
 *   successful top-level native transfer (log_index = -1).
 *   src       = effective source: `tx_from` when the token left one of the factory pairs (pool swap /
 *               LP burn, §7 "同一笔交易发起人"), otherwise `from_addr`.
 *   value_usdt = USDT value counted for the ratio: USDT rows only; for pair rows the USDT the matching
 *               Swap event says was received (no price conversion, §7); 0 for other assets.
 * risk_swaps: raw pair Swap events (kept for audit / cross-checks with Blockscout).
 * risk_index_state: single-row cursor (block + hash) plus head / last successful tick for the
 *   "index unavailable or behind → WAIT(index)" rule; `broken` set when a reorg cannot be resolved.
 * risk_index_checkpoints: (block, hash) of recent cursors, used to find the fork point on a reorg.
 * controlled_set.effective_from: an address only counts as controlled for movements at/after this time
 *   (old vault 0x8dFd: transfers after the cut-over time T, §7). NULL = always.
 */
export const RISK_MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 401,
    name: "risk_index_tables",
    sql: `
create table if not exists risk_flows (
  tx_hash bytea not null, log_index int not null,
  block_number bigint not null, block_hash bytea not null, block_time timestamptz not null,
  asset text not null, from_addr bytea not null, to_addr bytea not null, tx_from bytea not null, src bytea not null,
  amount numeric(78,0) not null, value_usdt numeric(78,0) not null default 0,
  primary key (tx_hash, log_index));
create index if not exists risk_flows_to_time_idx on risk_flows (to_addr, block_time);
create index if not exists risk_flows_src_time_idx on risk_flows (src, block_time);
create index if not exists risk_flows_block_idx on risk_flows (block_number);
create table if not exists risk_swaps (
  tx_hash bytea not null, log_index int not null,
  block_number bigint not null, block_hash bytea not null, block_time timestamptz not null,
  pair bytea not null, sender bytea not null, to_addr bytea not null, tx_from bytea not null,
  amount0_in numeric(78,0) not null, amount1_in numeric(78,0) not null,
  amount0_out numeric(78,0) not null, amount1_out numeric(78,0) not null,
  primary key (tx_hash, log_index));
create index if not exists risk_swaps_block_idx on risk_swaps (block_number);
create table if not exists risk_index_state (id int primary key check (id = 1),
  last_block bigint not null, last_block_hash bytea not null, last_block_time timestamptz,
  head_block bigint, checked_at timestamptz, broken text);
create table if not exists risk_index_checkpoints (block_number bigint primary key, block_hash bytea not null);
alter table controlled_set add column if not exists effective_from timestamptz
`,
  },
];

export async function migrateRisk(db: Db): Promise<void> {
  await db.query(
    "create table if not exists schema_migrations (version int primary key, name text not null, applied_at timestamptz default now())",
  );
  for (const m of RISK_MIGRATIONS) {
    await db.tx(async (t) => {
      const done = await t.query("select version from schema_migrations where version = $1", [m.version]);
      if (done.rows.length > 0) return;
      for (const stmt of m.sql.split(";").map((s) => s.trim()).filter(Boolean)) await t.query(stmt);
      await t.query("insert into schema_migrations (version, name) values ($1, $2) on conflict do nothing", [m.version, m.name]);
    });
  }
}
