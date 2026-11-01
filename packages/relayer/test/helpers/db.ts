import { PGlite } from "@electric-sql/pglite";
import { PgliteDb } from "../../src/db/pglite";
import { migrate } from "../../src/db/migrations";
import type { Db } from "../../src/db/types";

export async function newTestDb(): Promise<Db> {
  return new PgliteDb(new PGlite());
}

export async function newMigratedDb(): Promise<Db> {
  const db = await newTestDb();
  await migrate(db);
  return db;
}
