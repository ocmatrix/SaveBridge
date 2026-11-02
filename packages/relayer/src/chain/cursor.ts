import type { Db } from "../db/types";
import type { Hex } from "../types";
import { fromBytes, toBig, toBytes } from "../bytes";

export interface Cursor {
  block: bigint;
  hash: Hex;
}

/** chain_cursor (DESIGN §6.4): last processed block and its hash. */
export class CursorRepo {
  constructor(private readonly db: Db) {}

  async get(chainId: number): Promise<Cursor | null> {
    const r = await this.db.query<{ last_processed_block: unknown; last_block_hash: Uint8Array }>(
      "select last_processed_block, last_block_hash from chain_cursor where chain_id = $1",
      [chainId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { block: toBig(row.last_processed_block), hash: fromBytes(row.last_block_hash)! };
  }

  async set(chainId: number, block: bigint, hash: Hex): Promise<void> {
    await this.db.query(
      `insert into chain_cursor (chain_id, last_processed_block, last_block_hash) values ($1, $2, $3)
       on conflict (chain_id) do update set last_processed_block = excluded.last_processed_block, last_block_hash = excluded.last_block_hash`,
      [chainId, block.toString(), toBytes(hash)],
    );
  }

  /** Operator recovery after a reorg halt: point the cursor at a block/hash that has been re-verified. */
  async rewind(chainId: number, block: bigint, hash: Hex): Promise<void> {
    await this.set(chainId, block, hash);
  }
}
