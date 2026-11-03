import { encodeAbiParameters, keccak256, pad, toHex } from "viem";
import type { RawLog } from "@bridge/relayer/src/chain/reader";
import type { Address, Hex } from "@bridge/relayer/src/types";
import { SWAP_TOPIC, TRANSFER_TOPIC, type IndexBlock, type IndexReader, type IndexTx } from "../../src/indexer";

type LogSpec = { address: Address; topics: Hex[]; data: Hex; tx: Hex };
interface FBlock extends IndexBlock {
  logs: LogSpec[];
}

export const transferLog = (token: Address, from: Address, to: Address, amount: bigint, tx: Hex): LogSpec => ({
  address: token,
  topics: [TRANSFER_TOPIC, pad(from), pad(to)],
  data: pad(toHex(amount)),
  tx,
});
export const swapLog = (pair: Address, sender: Address, to: Address, a: [bigint, bigint, bigint, bigint], tx: Hex): LogSpec => ({
  address: pair,
  topics: [SWAP_TOPIC, pad(sender), pad(to)],
  data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], a),
  tx,
});

/** In-memory WANTOS for indexer tests: blocks with txs + logs, reorgs, failures. */
export class FakeIndexChain implements IndexReader {
  blocks: FBlock[] = [];
  failed = new Set<string>();
  calls = { getLogs: 0, getBlock: 0 };
  failNext: string | null = null;
  private salt = 0;
  private n = 0;
  constructor(genesisTime = 1_760_000_000n) {
    this.blocks.push({ number: 0n, hash: keccak256(toHex("g")), parentHash: `0x${"00".repeat(32)}`, timestamp: genesisTime, txs: [], logs: [] });
  }
  tx(): Hex {
    return keccak256(toHex(`tx-${++this.n}`));
  }
  /** Appends a block; each tx carries its logs. */
  add(txs: { tx?: Hex; from: Address; to?: Address | null; value?: bigint; logs?: ((tx: Hex) => LogSpec)[] }[] = [], dt = 1n): FBlock {
    const prev = this.blocks[this.blocks.length - 1]!;
    const number = prev.number + 1n;
    const itxs: IndexTx[] = [];
    const logs: LogSpec[] = [];
    for (const t of txs) {
      const h = t.tx ?? this.tx();
      itxs.push({ hash: h, from: t.from, to: t.to === undefined ? null : t.to, value: t.value ?? 0n });
      for (const mk of t.logs ?? []) logs.push(mk(h));
    }
    const b: FBlock = { number, hash: keccak256(toHex(`b-${number}-${this.salt}`)), parentHash: prev.hash, timestamp: prev.timestamp + dt, txs: itxs, logs };
    this.blocks.push(b);
    return b;
  }
  mine(k: number): void {
    for (let i = 0; i < k; i++) this.add();
  }
  /** Drop blocks ≥ n (they will be re-added with new hashes). */
  reorgFrom(n: bigint): void {
    this.salt++;
    this.blocks = this.blocks.filter((b) => b.number < n);
  }
  private maybeFail(m: string) {
    if (this.failNext === m) {
      this.failNext = null;
      throw new Error(`${m} down`);
    }
  }
  async getBlockNumber(): Promise<bigint> {
    this.maybeFail("getBlockNumber");
    return this.blocks[this.blocks.length - 1]!.number;
  }
  async getBlock(n: bigint): Promise<IndexBlock | null> {
    this.calls.getBlock++;
    const b = this.blocks.find((x) => x.number === n);
    return b ? { number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp, txs: b.txs } : null;
  }
  async getLogs(a: { address: Address[]; topic0: Hex; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]> {
    this.calls.getLogs++;
    this.maybeFail("getLogs");
    const out: RawLog[] = [];
    const addrs = new Set(a.address.map((x) => x.toLowerCase()));
    for (const b of this.blocks) {
      if (b.number < a.fromBlock || b.number > a.toBlock) continue;
      b.logs.forEach((l, i) => {
        if (addrs.has(l.address.toLowerCase()) && l.topics[0] === a.topic0)
          out.push({ address: l.address, topics: l.topics, data: l.data, blockNumber: b.number, blockHash: b.hash, transactionHash: l.tx, logIndex: i });
      });
    }
    return out;
  }
  async txSucceeded(hash: Hex): Promise<boolean> {
    return !this.failed.has(hash);
  }
}
