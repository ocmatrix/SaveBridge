import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Abi } from "viem";
import { wantosBridgeV2Abi, bscVaultV2Abi } from "@bridge/abi";
import type { BlockLite, ChainReader, RawLog, ReceiptLite } from "../../src/chain/reader";
import type { Address, Hex } from "../../src/types";

/** In-memory chain used for fault injection. Each `reader()` is an independent "RPC". */
export class FakeChain {
  blocks: BlockLite[] = [];
  logs: RawLog[] = [];
  receipts = new Map<string, ReceiptLite>();
  finalizedLag = 64n;
  private salt = 0;

  constructor(blocks = 1) {
    for (let i = 0; i < blocks; i++) this.mine();
  }

  get head(): bigint {
    return BigInt(this.blocks.length - 1);
  }

  mine(n = 1): void {
    for (let i = 0; i < n; i++) {
      const number = BigInt(this.blocks.length);
      this.blocks.push({ number, hash: keccak256(toHex(`b${number}:${this.salt}`)), timestamp: 1_700_000_000n + number });
    }
  }

  /** Rewrites the hash of every block >= `from` (simulated reorg) and re-points their logs/receipts. */
  reorgFrom(from: bigint): void {
    this.salt++;
    for (const b of this.blocks) {
      if (b.number >= from) b.hash = keccak256(toHex(`b${b.number}:${this.salt}`));
    }
    for (const l of this.logs) if (l.blockNumber >= from) l.blockHash = this.blocks[Number(l.blockNumber)]!.hash;
    for (const r of this.receipts.values()) {
      if (r.blockNumber >= from) {
        r.blockHash = this.blocks[Number(r.blockNumber)]!.hash;
        for (const l of r.logs) l.blockHash = r.blockHash;
      }
    }
  }

  /** Mines a block containing one tx that emits `log`. */
  addEvent(address: Address, topics: Hex[], data: Hex): RawLog {
    this.mine();
    const b = this.blocks[this.blocks.length - 1]!;
    const tx = keccak256(toHex(`tx${b.number}:${this.logs.length}:${this.salt}`));
    const log: RawLog = { address, topics, data, blockNumber: b.number, blockHash: b.hash, transactionHash: tx, logIndex: 0 };
    this.logs.push(log);
    this.receipts.set(tx, { status: "success", blockNumber: b.number, blockHash: b.hash, logs: [{ ...log }] });
    return log;
  }

  reader(label: string): FakeReader {
    return new FakeReader(label, this);
  }
}

export class FakeReader implements ChainReader {
  down = false;
  noFinalized = false;
  calls: { method: string; args: unknown }[] = [];
  /** Optional per-reader overrides to simulate a lying / lagging RPC. */
  receiptOverride?: (hash: Hex, r: ReceiptLite | null) => ReceiptLite | null;
  logsOverride?: (logs: RawLog[]) => RawLog[];
  blockHashOverride?: (n: bigint, h: Hex) => Hex;

  constructor(
    readonly label: string,
    private readonly chain: FakeChain,
  ) {}

  private check(method: string, args: unknown) {
    this.calls.push({ method, args });
    if (this.down) throw new Error(`${this.label}: connection refused`);
  }

  async getBlockNumber() {
    this.check("getBlockNumber", null);
    return this.chain.head;
  }

  async getBlock(arg: { blockNumber: bigint } | { blockTag: "finalized" | "latest" }) {
    this.check("getBlock", arg);
    let n: bigint;
    if ("blockTag" in arg) {
      if (arg.blockTag === "finalized") {
        if (this.noFinalized) return null;
        n = this.chain.head - this.chain.finalizedLag;
        if (n < 0n) n = 0n;
      } else n = this.chain.head;
    } else n = arg.blockNumber;
    const b = this.chain.blocks[Number(n)];
    if (!b) return null;
    return { ...b, hash: this.blockHashOverride ? this.blockHashOverride(b.number, b.hash) : b.hash };
  }

  async getLogs(args: { address: Address; fromBlock: bigint; toBlock: bigint }) {
    this.check("getLogs", args);
    if (args.toBlock > this.chain.head) throw new Error("block range beyond head");
    // Like a real node with an address filter, but we deliberately return foreign-address logs too
    // when a test injects them via logsOverride.
    const ls = this.chain.logs
      .filter((l) => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock && l.address.toLowerCase() === args.address.toLowerCase())
      .map((l) => ({ ...l }));
    return this.logsOverride ? this.logsOverride(ls) : ls;
  }

  async getTransactionReceipt(hash: Hex) {
    this.check("getTransactionReceipt", hash);
    const r = this.chain.receipts.get(hash) ?? null;
    const copy = r ? { ...r, logs: r.logs.map((l) => ({ ...l })) } : null;
    return this.receiptOverride ? this.receiptOverride(hash, copy) : copy;
  }
}

export function bridgeOutLog(orderId: bigint, user: Address, amount: bigint): { topics: Hex[]; data: Hex } {
  const topics = encodeEventTopics({ abi: wantosBridgeV2Abi as Abi, eventName: "BridgeOut", args: { orderId, user } }) as Hex[];
  return { topics, data: encodeAbiParameters([{ type: "uint256" }], [amount]) };
}

export function depositedLog(nonce: bigint, from: Address, wantosRecipient: Address, amount: bigint): { topics: Hex[]; data: Hex } {
  const topics = encodeEventTopics({ abi: bscVaultV2Abi as Abi, eventName: "Deposited", args: { nonce, from, wantosRecipient } }) as Hex[];
  return { topics, data: encodeAbiParameters([{ type: "uint256" }], [amount]) };
}
