import type { PublicClient } from "viem";
import type { Address, Hex } from "../types";

export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}

export interface BlockLite {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

export interface ReceiptLite {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
  logs: RawLog[];
}

/** Read-only view of one RPC endpoint. Every method may throw (network down). */
export interface ChainReader {
  readonly label: string;
  getBlockNumber(): Promise<bigint>;
  /** Returns null when the node does not know the block/tag (e.g. `finalized` unsupported). */
  getBlock(arg: { blockNumber: bigint } | { blockTag: "finalized" | "latest" }): Promise<BlockLite | null>;
  getLogs(args: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]>;
  getTransactionReceipt(hash: Hex): Promise<ReceiptLite | null>;
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function logId(l: RawLog): string {
  return `${l.transactionHash.toLowerCase()}:${l.logIndex}:${l.address.toLowerCase()}:${l.topics.join(",").toLowerCase()}:${l.data.toLowerCase()}:${l.blockHash.toLowerCase()}`;
}

/** viem-backed reader. */
export class ViemChainReader implements ChainReader {
  constructor(
    readonly label: string,
    private readonly client: PublicClient,
  ) {}

  getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }

  async getBlock(arg: { blockNumber: bigint } | { blockTag: "finalized" | "latest" }): Promise<BlockLite | null> {
    try {
      const b = await this.client.getBlock(arg as never);
      if (!b || b.number === null || b.hash === null) return null;
      return { number: b.number, hash: b.hash, timestamp: b.timestamp };
    } catch (e) {
      if ((e as { name?: string }).name === "BlockNotFoundError") return null;
      throw e;
    }
  }

  async getLogs(args: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<RawLog[]> {
    const logs = await this.client.getLogs(args);
    return logs.map((l) => ({
      address: l.address,
      topics: l.topics as Hex[],
      data: l.data,
      blockNumber: l.blockNumber!,
      blockHash: l.blockHash!,
      transactionHash: l.transactionHash!,
      logIndex: l.logIndex!,
    }));
  }

  async getTransactionReceipt(hash: Hex): Promise<ReceiptLite | null> {
    try {
      const r = await this.client.getTransactionReceipt({ hash });
      return {
        status: r.status,
        blockNumber: r.blockNumber,
        blockHash: r.blockHash,
        logs: r.logs.map((l) => ({
          address: l.address,
          topics: l.topics as Hex[],
          data: l.data,
          blockNumber: l.blockNumber,
          blockHash: l.blockHash,
          transactionHash: l.transactionHash,
          logIndex: l.logIndex,
        })),
      };
    } catch (e) {
      if ((e as { name?: string }).name === "TransactionReceiptNotFoundError") return null;
      throw e;
    }
  }
}
