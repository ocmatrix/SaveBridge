import { getAddress, hexToBigInt, keccak256, toHex, toBytes as strBytes, type PublicClient } from "viem";
import type { Db } from "@bridge/relayer/src/db/types";
import type { Address, Hex } from "@bridge/relayer/src/types";
import type { RawLog } from "@bridge/relayer/src/chain/reader";
import type { RiskConfig } from "./config";
import { deleteAbove, getState, insertFlows, insertSwaps, putState, b, type FlowRow, type IndexState, type SwapRow } from "./store";
import type { RiskAlertSink } from "./alerts";

export const TRANSFER_TOPIC = keccak256(strBytes("Transfer(address,address,uint256)"));
export const SWAP_TOPIC = keccak256(strBytes("Swap(address,uint256,uint256,uint256,uint256,address)"));
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

export interface IndexTx {
  hash: Hex;
  from: Address;
  to: Address | null;
  value: bigint;
}
export interface IndexBlock {
  number: bigint;
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
  txs: IndexTx[];
}

/** Read-only WANTOS access needed by the index. Every method may throw (node down). */
export interface IndexReader {
  getBlockNumber(): Promise<bigint>;
  /** Block with its transactions; null when the node does not have it. */
  getBlock(n: bigint): Promise<IndexBlock | null>;
  getLogs(a: { address: Address[]; topic0: Hex; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]>;
  /** Receipt status of a (mined) transaction. */
  txSucceeded(hash: Hex): Promise<boolean>;
}

export class ViemIndexReader implements IndexReader {
  constructor(private readonly client: PublicClient) {}
  getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }
  async getBlock(n: bigint): Promise<IndexBlock | null> {
    try {
      const x = await this.client.getBlock({ blockNumber: n, includeTransactions: true });
      if (!x || x.hash === null || x.number === null) return null;
      return {
        number: x.number,
        hash: x.hash,
        parentHash: x.parentHash,
        timestamp: x.timestamp,
        txs: x.transactions.map((t) => ({ hash: t.hash, from: t.from, to: t.to ?? null, value: t.value })),
      };
    } catch (e) {
      if ((e as { name?: string }).name === "BlockNotFoundError") return null;
      throw e;
    }
  }
  async getLogs(a: { address: Address[]; topic0: Hex; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]> {
    const logs = (await this.client.request({
      method: "eth_getLogs",
      params: [{ address: a.address, topics: [a.topic0], fromBlock: toHex(a.fromBlock), toBlock: toHex(a.toBlock) }],
    })) as { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex; removed?: boolean }[];
    return logs
      .filter((l) => !l.removed)
      .map((l) => ({
        address: getAddress(l.address),
        topics: l.topics,
        data: l.data,
        blockNumber: hexToBigInt(l.blockNumber),
        blockHash: l.blockHash,
        transactionHash: l.transactionHash,
        logIndex: Number(hexToBigInt(l.logIndex)),
      }));
  }
  async txSucceeded(hash: Hex): Promise<boolean> {
    return (await this.client.getTransactionReceipt({ hash })).status === "success";
  }
}

export interface IndexerOpts {
  db: Db;
  reader: IndexReader;
  cfg: RiskConfig;
  /** Same confirmation depth as the relayer's WANTOS scanner (≥ 6, §6.2). */
  confirmations: number;
  /** First block to index (must be ≥ 30 days before go-live so the look-back is complete). */
  startBlock: bigint;
  maxBlockRange: number;
  /** Index top-level native transfers (needs every block with its transactions). */
  indexNative: boolean;
  /** Checkpoints kept for reorg fork-point search. */
  keepCheckpoints?: number;
  alerts?: RiskAlertSink;
  now?: () => Date;
}

const topicAddr = (t: Hex | undefined): Address => {
  if (!t) throw new Error("missing topic");
  return getAddress(`0x${t.slice(-40)}`);
};
const word = (data: Hex, i: number): bigint => hexToBigInt(`0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}` as Hex);
const lc = (a: string) => a.toLowerCase();

/**
 * Incremental indexer for DESIGN §6.2 "自建交易索引": USDT/MG/TIDE Transfer, top-level native
 * transfers, and Swap events of the factory pairs. Cursor = (block, hash); a hash change at the cursor
 * rewinds to the newest checkpoint still on the canonical chain; no such checkpoint → `broken`
 * (the engine then answers WAIT(index) until an operator calls `rewindTo`).
 */
export class TxIndexer {
  private readonly now: () => Date;
  private readonly assetOf = new Map<string, string>();
  private readonly pairs = new Map<string, 0 | 1 | null>();

  constructor(private readonly o: IndexerOpts) {
    if (o.confirmations < 6) throw new Error("indexer: confirmations must be ≥ 6 (§6.2)");
    if (o.maxBlockRange < 1) throw new Error("indexer: maxBlockRange must be ≥ 1");
    this.now = o.now ?? (() => new Date());
    this.assetOf.set(lc(o.cfg.usdt), "USDT");
    for (const t of o.cfg.otherTokens) this.assetOf.set(lc(t.address), t.symbol);
    for (const p of o.cfg.pairs) this.pairs.set(lc(p.address), p.usdtIndex);
  }

  /** One step; never throws (errors are alerted and retried next tick). */
  async runTick(): Promise<void> {
    try {
      await this.tick();
    } catch (e) {
      await this.alert("INDEX_ERROR", "index-error", `indexer tick failed: ${(e as Error).message}`);
    }
  }

  async tick(): Promise<{ from: bigint; to: bigint } | null> {
    const { db, reader } = this.o;
    let st = await getState(db);
    if (!st) st = await this.init();
    if (st.broken) {
      await this.alert("INDEX_BROKEN", "index-broken", `index broken: ${st.broken}`);
      return null;
    }
    const head = await reader.getBlockNumber();
    if (st.lastBlock >= 0n) {
      const cur = await reader.getBlock(st.lastBlock);
      if (!cur) throw new Error(`node does not have indexed block ${st.lastBlock}`);
      if (lc(cur.hash) !== lc(st.lastBlockHash)) {
        await this.rewind(st);
        return null;
      }
    }
    const target = head - BigInt(this.o.confirmations);
    const from = st.lastBlock + 1n;
    const to = target < st.lastBlock + BigInt(this.o.maxBlockRange) ? target : st.lastBlock + BigInt(this.o.maxBlockRange);
    if (from > to) {
      await putState(db, { ...st, headBlock: head, checkedAt: this.now() });
      return null;
    }
    const tokens = [...this.assetOf.keys()].map((a) => getAddress(a));
    const [tLogs, sLogs] = await Promise.all([
      reader.getLogs({ address: tokens, topic0: TRANSFER_TOPIC, fromBlock: from, toBlock: to }),
      reader.getLogs({ address: this.o.cfg.pairs.map((p) => p.address), topic0: SWAP_TOPIC, fromBlock: from, toBlock: to }),
    ]);
    const need = new Set<bigint>([to]);
    if (this.o.indexNative) for (let n = from; n <= to; n++) need.add(n);
    for (const l of [...tLogs, ...sLogs]) need.add(l.blockNumber);
    const blocks = new Map<bigint, IndexBlock>();
    const list = [...need].sort((x, y) => (x < y ? -1 : 1));
    for (let i = 0; i < list.length; i += 10) {
      const got = await Promise.all(list.slice(i, i + 10).map((n) => reader.getBlock(n)));
      for (const [j, blk] of got.entries()) {
        if (!blk) throw new Error(`block ${list[i + j]} unavailable`);
        blocks.set(blk.number, blk);
      }
    }
    const first = blocks.get(from);
    if (first && st.lastBlock >= 0n && lc(first.parentHash) !== lc(st.lastBlockHash)) {
      await this.rewind(st);
      return null;
    }
    for (const l of [...tLogs, ...sLogs]) {
      if (lc(blocks.get(l.blockNumber)!.hash) !== lc(l.blockHash)) throw new Error(`log/block hash mismatch at ${l.blockNumber} (reorg in progress)`);
    }
    const txFrom = (blk: IndexBlock, h: Hex): Address => {
      const t = blk.txs.find((x) => lc(x.hash) === lc(h));
      if (!t) throw new Error(`tx ${h} not in block ${blk.number}`);
      return getAddress(t.from);
    };
    const swaps: SwapRow[] = sLogs
      .filter((l) => l.topics.length === 3 && l.data.length === 2 + 64 * 4)
      .map((l) => {
        const blk = blocks.get(l.blockNumber)!;
        return {
          txHash: l.transactionHash,
          logIndex: l.logIndex,
          blockNumber: l.blockNumber,
          blockHash: l.blockHash,
          blockTime: new Date(Number(blk.timestamp) * 1000),
          pair: getAddress(l.address),
          sender: topicAddr(l.topics[1]),
          to: topicAddr(l.topics[2]),
          txFrom: txFrom(blk, l.transactionHash),
          amount0In: word(l.data, 0),
          amount1In: word(l.data, 1),
          amount0Out: word(l.data, 2),
          amount1Out: word(l.data, 3),
        };
      });
    const flows: FlowRow[] = [];
    for (const l of tLogs) {
      if (l.topics.length !== 3 || l.data.length !== 66) continue; // not an ERC-20 Transfer
      const blk = blocks.get(l.blockNumber)!;
      const asset = this.assetOf.get(lc(l.address))!;
      const from = topicAddr(l.topics[1]);
      const to = topicAddr(l.topics[2]);
      const amount = word(l.data, 0);
      const tf = txFrom(blk, l.transactionHash);
      const isPair = this.pairs.has(lc(from));
      let valueUsdt = 0n;
      if (asset === "USDT") {
        valueUsdt = amount;
        const idx = this.pairs.get(lc(from));
        if (isPair && idx !== null && idx !== undefined) {
          // §7: count what the pool's Swap event says was received (next Swap of that pair to this recipient).
          const sw = swaps
            .filter((s) => lc(s.txHash) === lc(l.transactionHash) && lc(s.pair) === lc(from) && lc(s.to) === lc(to) && s.logIndex > l.logIndex)
            .sort((x, y) => x.logIndex - y.logIndex)[0];
          const out = sw ? (idx === 0 ? sw.amount0Out : sw.amount1Out) : 0n;
          if (out > 0n) valueUsdt = out;
        }
      }
      flows.push({
        txHash: l.transactionHash,
        logIndex: l.logIndex,
        blockNumber: l.blockNumber,
        blockHash: l.blockHash,
        blockTime: new Date(Number(blk.timestamp) * 1000),
        asset,
        from,
        to,
        txFrom: tf,
        src: isPair ? tf : from,
        amount,
        valueUsdt,
      });
    }
    if (this.o.indexNative) {
      for (const blk of blocks.values()) {
        if (blk.number < from || blk.number > to) continue;
        for (const t of blk.txs) {
          if (t.value === 0n || !t.to || lc(t.to) === lc(t.from)) continue;
          if (!(await reader.txSucceeded(t.hash))) continue;
          const f = getAddress(t.from);
          flows.push({
            txHash: t.hash,
            logIndex: -1,
            blockNumber: blk.number,
            blockHash: blk.hash,
            blockTime: new Date(Number(blk.timestamp) * 1000),
            asset: "NATIVE",
            from: f,
            to: getAddress(t.to),
            txFrom: f,
            src: f,
            amount: t.value,
            valueUsdt: 0n,
          });
        }
      }
    }
    const end = blocks.get(to)!;
    const keep = this.o.keepCheckpoints ?? 500;
    await db.tx(async (t) => {
      await t.query("delete from risk_flows where block_number between $1 and $2", [from.toString(), to.toString()]);
      await t.query("delete from risk_swaps where block_number between $1 and $2", [from.toString(), to.toString()]);
      await insertFlows(t, flows);
      await insertSwaps(t, swaps);
      await putState(t, { lastBlock: to, lastBlockHash: end.hash, lastBlockTime: new Date(Number(end.timestamp) * 1000), headBlock: head, checkedAt: this.now(), broken: null });
      await t.query("insert into risk_index_checkpoints (block_number, block_hash) values ($1,$2) on conflict (block_number) do update set block_hash = excluded.block_hash", [to.toString(), b(end.hash)]);
      await t.query(
        "delete from risk_index_checkpoints where block_number < (select min(block_number) from (select block_number from risk_index_checkpoints order by block_number desc limit $1) k)",
        [keep],
      );
    });
    return { from, to };
  }

  /** Operator recovery after `broken` (e.g. a WANTOS rollback deeper than the checkpoints). */
  async rewindTo(block: bigint): Promise<void> {
    const blk = block >= 0n ? await this.o.reader.getBlock(block) : null;
    if (block >= 0n && !blk) throw new Error(`block ${block} unavailable`);
    await this.o.db.tx(async (t) => {
      await deleteAbove(t, block);
      await putState(t, {
        lastBlock: block,
        lastBlockHash: blk?.hash ?? ZERO_HASH,
        lastBlockTime: blk ? new Date(Number(blk.timestamp) * 1000) : null,
        headBlock: null,
        checkedAt: null,
        broken: null,
      });
    });
  }

  private async init(): Promise<IndexState> {
    const last = this.o.startBlock - 1n;
    const blk = last >= 0n ? await this.o.reader.getBlock(last) : null;
    if (last >= 0n && !blk) throw new Error(`start block ${last} unavailable`);
    const st: IndexState = {
      lastBlock: last,
      lastBlockHash: blk?.hash ?? ZERO_HASH,
      lastBlockTime: blk ? new Date(Number(blk.timestamp) * 1000) : null,
      headBlock: null,
      checkedAt: null,
      broken: null,
    };
    await putState(this.o.db, st);
    return st;
  }

  private async rewind(st: IndexState): Promise<void> {
    const cps = await this.o.db.query<{ block_number: string; block_hash: Uint8Array }>(
      "select block_number, block_hash from risk_index_checkpoints where block_number < $1 order by block_number desc",
      [st.lastBlock.toString()],
    );
    for (const cp of cps.rows) {
      const n = BigInt(cp.block_number);
      const blk = await this.o.reader.getBlock(n);
      if (blk && lc(blk.hash) === lc(toHex(cp.block_hash))) {
        await this.o.db.tx(async (t) => {
          await deleteAbove(t, n);
          await putState(t, { ...st, lastBlock: n, lastBlockHash: blk.hash, lastBlockTime: new Date(Number(blk.timestamp) * 1000) });
        });
        await this.alert("INDEX_REORG", `index-reorg:${st.lastBlock}`, `WANTOS reorg: index rewound from ${st.lastBlock} to ${n}`, { from: st.lastBlock.toString(), to: n.toString() });
        return;
      }
    }
    await putState(this.o.db, { ...st, broken: `reorg at ${st.lastBlock}: no checkpoint on the canonical chain` });
    await this.alert("INDEX_BROKEN", "index-broken", `index broken: reorg at ${st.lastBlock} deeper than all checkpoints; rewindTo() needed`);
  }

  private async alert(kind: "INDEX_ERROR" | "INDEX_REORG" | "INDEX_BROKEN", key: string, message: string, data?: Record<string, unknown>) {
    await this.o.alerts?.emit({ kind, key, message, data }).catch(() => undefined);
  }
}
