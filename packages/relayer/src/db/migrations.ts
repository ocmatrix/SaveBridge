import type { Db } from "./types";

/**
 * DESIGN §6.5 tables plus relayer-internal columns/indexes. Every statement is idempotent
 * (`if not exists`), and applied versions are recorded in `schema_migrations`, so running
 * `migrate()` repeatedly is safe.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "design_6_5_tables",
    sql: `
create table if not exists orders (
  event_key bytea primary key, direction text not null,
  src_chain int not null, src_event_nonce numeric not null, src_tx_hash bytea not null,
  user_addr bytea not null, to_addr bytea not null, amount_wei numeric(78,0) not null,
  status text not null, reason text, reasons jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now());
create table if not exists tx_attempts (id bigserial primary key, event_key bytea, chain_id int, nonce bigint,
  tx_hash bytea, gas_price numeric, raw_tx bytea, state text, created_at timestamptz default now());
create table if not exists chain_cursor (chain_id int primary key, last_processed_block bigint, last_block_hash bytea);
create table if not exists audit_log (id bigserial primary key, actor text, action text, payload jsonb, at timestamptz default now());
`,
  },
  {
    version: 2,
    name: "relayer_internal_columns_and_indexes",
    sql: `
alter table orders add column if not exists src_block_number bigint;
alter table orders add column if not exists src_block_hash bytea;
alter table orders add column if not exists review_level text;
alter table orders add column if not exists state_since timestamptz default now();
alter table orders add column if not exists timeout_alerted_for text;
alter table orders add column if not exists executable_at timestamptz;
alter table orders add column if not exists last_tx_hash bytea;
alter table orders add column if not exists last_error text;
alter table tx_attempts add column if not exists action text;
alter table tx_attempts add column if not exists updated_at timestamptz default now();
create unique index if not exists tx_attempts_chain_hash_uq on tx_attempts (chain_id, tx_hash);
create index if not exists tx_attempts_chain_nonce_idx on tx_attempts (chain_id, nonce);
create index if not exists tx_attempts_state_idx on tx_attempts (state);
create index if not exists orders_status_idx on orders (status);
create index if not exists orders_user_idx on orders (user_addr);
create index if not exists orders_to_idx on orders (to_addr);
create index if not exists orders_direction_nonce_idx on orders (direction, src_event_nonce);
`,
  },
  {
    version: 3,
    name: "review_approval",
    sql: `
alter table orders add column if not exists approved_at timestamptz;
alter table orders add column if not exists approved_by bytea;
`,
  },
  {
    version: 4,
    name: "timelock_notices",
    sql: `
create table if not exists timelock_notices (chain_id int not null, op_id bytea not null, kind text not null,
  at timestamptz default now(), primary key (chain_id, op_id, kind));
`,
  },
  {
    version: 5,
    name: "tx_attempts_from_addr",
    sql: `
alter table tx_attempts add column if not exists from_addr bytea;
create index if not exists tx_attempts_chain_from_nonce_idx on tx_attempts (chain_id, from_addr, nonce);
`,
  },
  {
    version: 6,
    name: "approval_scope",
    sql: `
alter table orders add column if not exists approved_level text;
alter table orders add column if not exists approved_reason text;
`,
  },
  {
    version: 7,
    name: "timelock_scan_state",
    sql: `
create table if not exists timelock_cursor (chain_id int not null, timelock bytea not null, last_block bigint not null,
  primary key (chain_id, timelock));
create table if not exists timelock_calls (chain_id int not null, op_id bytea not null, idx numeric not null,
  target bytea not null, value numeric not null, data bytea not null, predecessor bytea not null,
  primary key (chain_id, op_id, idx));
create table if not exists timelock_salts (chain_id int not null, op_id bytea not null, salt bytea not null,
  primary key (chain_id, op_id));
`,
  },
  {
    version: 8,
    name: "review_signatures_single_use",
    sql: `
create table if not exists review_signatures (msg_hash bytea primary key, event_key bytea not null, decision text not null,
  at timestamptz default now());
`,
  },
];

export async function migrate(db: Db): Promise<void> {
  await db.query(
    "create table if not exists schema_migrations (version int primary key, name text not null, applied_at timestamptz default now())",
  );
  for (const m of MIGRATIONS) {
    await db.tx(async (t) => {
      const done = await t.query<{ version: number }>("select version from schema_migrations where version = $1", [m.version]);
      if (done.rows.length > 0) return;
      for (const stmt of m.sql.split(";").map((s) => s.trim()).filter(Boolean)) {
        await t.query(stmt);
      }
      await t.query("insert into schema_migrations (version, name) values ($1, $2) on conflict do nothing", [m.version, m.name]);
    });
  }
}
