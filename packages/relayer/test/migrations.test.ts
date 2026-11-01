import { describe, expect, it } from "vitest";
import { newTestDb } from "./helpers/db";
import { migrate, MIGRATIONS } from "../src/db/migrations";

describe("migrations (DESIGN §6.5)", () => {
  it("creates all §6.5 tables and is re-runnable", async () => {
    const db = await newTestDb();
    await migrate(db);
    await migrate(db); // idempotent
    const r = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    const names = r.rows.map((x) => x.table_name);
    for (const t of ["orders", "tx_attempts", "chain_cursor", "controlled_set", "audit_log", "schema_migrations"]) {
      expect(names).toContain(t);
    }
    const applied = await db.query<{ n: number }>("select count(*)::int as n from schema_migrations");
    expect(applied.rows[0]!.n).toBe(MIGRATIONS.length);
  });

  it("event_key is a unique primary key (idempotent ingestion)", async () => {
    const db = await newTestDb();
    await migrate(db);
    const ins = `insert into orders (event_key, direction, src_chain, src_event_nonce, src_tx_hash, user_addr, to_addr, amount_wei, status)
      values ($1,'W2B',1,1,$2,$3,$3,10,'DETECTED') on conflict (event_key) do nothing`;
    const k = new Uint8Array(32).fill(1);
    await db.query(ins, [k, new Uint8Array(32), new Uint8Array(20)]);
    await db.query(ins, [k, new Uint8Array(32), new Uint8Array(20)]);
    const r = await db.query<{ n: number }>("select count(*)::int as n from orders");
    expect(r.rows[0]!.n).toBe(1);
  });

  it("tx_attempts has a unique (chain_id, tx_hash) index and orders has status/user indexes", async () => {
    const db = await newTestDb();
    await migrate(db);
    const r = await db.query<{ indexname: string }>("select indexname from pg_indexes where schemaname='public'");
    const idx = r.rows.map((x) => x.indexname);
    expect(idx).toContain("tx_attempts_chain_hash_uq");
    expect(idx).toContain("orders_status_idx");
    expect(idx).toContain("orders_user_idx");
    expect(idx).toContain("orders_to_idx");
  });
});
