/**
 * Minimal DB interface shared by the production `pg` adapter and the test PGlite adapter.
 * SQL is plain PostgreSQL with `$n` placeholders.
 */
export interface QueryResult<T> {
  rows: T[];
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run `fn` inside a transaction (BEGIN/COMMIT, ROLLBACK on throw). */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
