import type { Pool, PoolClient } from "pg";
import type { Db, QueryResult } from "./types";

/** Production adapter over `pg`. Connection string comes from the environment, never from code. */
export class PgDb implements Db {
  constructor(private readonly pool: Pool) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pool.query(sql, params);
    return { rows: r.rows as T[] };
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    const inner: Db = {
      query: async <U>(sql: string, params: unknown[] = []) => ({ rows: (await client.query(sql, params)).rows as U[] }),
      tx: (f) => f(inner),
      close: async () => {},
    };
    try {
      await client.query("begin");
      const out = await fn(inner);
      await client.query("commit");
      return out;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
