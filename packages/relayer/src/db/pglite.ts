import type { PGlite } from "@electric-sql/pglite";
import type { Db, QueryResult } from "./types";

/** Embedded Postgres adapter (tests). */
export class PgliteDb implements Db {
  constructor(private readonly pg: PGlite) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const r = await this.pg.query<T>(sql, params as any[]);
    return { rows: r.rows };
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (t) => {
      const inner: Db = {
        query: async <U>(sql: string, params: unknown[] = []) => ({ rows: (await t.query<U>(sql, params as any[])).rows }),
        tx: (f) => f(inner),
        close: async () => {},
      };
      return fn(inner);
    }) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
