import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { PublicClient } from "viem";
import { PgDb } from "../src/db/pg";
import { PgliteDb } from "../src/db/pglite";
import { migrate } from "../src/db/migrations";
import { ViemChainReader } from "../src/chain/reader";
import { startAnvil, type Anvil } from "./helpers/anvil";

/** A `pg.Pool`-shaped fake backed by PGlite, to exercise the production adapter's SQL/tx paths. */
function fakePool(pg: PGlite) {
  const q = async (sql: string, params: unknown[] = []) => ({ rows: (await pg.query(sql, params as any[])).rows });
  return {
    query: q,
    connect: async () => ({ query: q, release: () => undefined }),
    end: async () => pg.close(),
  };
}

describe("DB adapters", () => {
  it("PgDb (production adapter) migrates, commits and rolls back", async () => {
    const db = new PgDb(fakePool(new PGlite()) as any);
    await migrate(db);
    await migrate(db);
    await db.tx(async (t) => {
      await t.query("insert into audit_log (actor, action) values ('a', 'x')");
      await t.tx(async (t2) => t2.query("insert into audit_log (actor, action) values ('a', 'y')"));
    });
    await expect(
      db.tx(async (t) => {
        await t.query("insert into audit_log (actor, action) values ('a', 'z')");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const r = await db.query<{ action: string }>("select action from audit_log order by id");
    expect(r.rows.map((x) => x.action)).toEqual(["x", "y"]);
    await db.close();
  });

  it("PgliteDb rolls back on error and supports nested tx + close", async () => {
    const db = new PgliteDb(new PGlite());
    await migrate(db);
    await expect(
      db.tx(async (t) => {
        await t.tx(async (t2) => t2.query("insert into audit_log (actor, action) values ('a', 'z')"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await db.query<{ n: number }>("select count(*)::int as n from audit_log")).rows[0]!.n).toBe(0);
    await db.close();
  });
});

describe("ViemChainReader against anvil", () => {
  let a: Anvil;
  beforeAll(async () => {
    a = await startAnvil(31339);
    await a.testClient.mine({ blocks: 70 });
  });
  afterAll(async () => a?.stop());

  it("maps blocks, finalized tag, missing block / receipt to null", async () => {
    const r = new ViemChainReader("anvil", a.publicClient as unknown as PublicClient);
    expect(await r.getBlockNumber()).toBe(70n);
    expect((await r.getBlock({ blockTag: "finalized" }))!.number).toBe(6n);
    expect((await r.getBlock({ blockNumber: 3n }))!.number).toBe(3n);
    expect(await r.getBlock({ blockNumber: 10_000n })).toBeNull();
    expect(await r.getTransactionReceipt(("0x" + "ab".repeat(32)) as `0x${string}`)).toBeNull();
    expect(await r.getLogs({ address: "0x0000000000000000000000000000000000000001", fromBlock: 0n, toBlock: 70n })).toEqual([]);
  });
});
