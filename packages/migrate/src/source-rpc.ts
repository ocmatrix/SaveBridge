import { formatUnits, getAddress, parseAbiItem, type AbiEvent, type Address, type Hex, type PublicClient } from "viem";
import type { Direction, LegacySourceData, OldPayout, SourceOrder } from "./types.js";

/**
 * Reads old-bridge events over RPC and normalises them into `LegacySourceData`.
 * The old bridge's event layout is not in this repo, so it is configuration: the event signature
 * (human-readable ABI) and which argument holds which field.
 */
export interface EventSpec {
  chainId: number;
  address: Address;
  /** e.g. "event Transfer(address indexed from, address indexed to, uint256 value)" */
  event: string;
  fromBlock: bigint;
  toBlock: bigint;
  /** Token decimals of the amount argument. */
  decimals: number;
  /** Optional indexed-argument filter, e.g. { from: "0xeC6E…" } for transfers out of the old vault. */
  args?: Record<string, string>;
}

export interface OrderEventSpec extends EventSpec {
  direction: Direction;
  fields: { from: string; recipient?: string; amount: string };
}

export interface PayoutEventSpec extends EventSpec {
  fields: { to: string; amount: string; srcTxHash?: string; srcLogIndex?: string };
}

export interface RpcSourceConfig {
  orders: OrderEventSpec[];
  payouts: PayoutEventSpec[];
  /** Blocks per getLogs call (default 5000). */
  chunk?: bigint;
}

export type SourceClient = Pick<PublicClient, "getLogs" | "getBlock">;

interface RawLog {
  args: Record<string, unknown>;
  transactionHash: Hex;
  logIndex: number;
  blockNumber: bigint;
}

async function fetchLogs(client: SourceClient, s: EventSpec, chunk: bigint): Promise<RawLog[]> {
  if (s.toBlock < s.fromBlock) throw new Error(`toBlock < fromBlock for ${s.event}`);
  if (chunk < 1n) throw new Error("chunk must be ≥ 1");
  const event = parseAbiItem(s.event) as AbiEvent;
  if (event.type !== "event") throw new Error(`not an event: ${s.event}`);
  const out: RawLog[] = [];
  for (let from = s.fromBlock; from <= s.toBlock; from += chunk) {
    const to = from + chunk - 1n < s.toBlock ? from + chunk - 1n : s.toBlock;
    const logs = (await client.getLogs({ address: s.address, event, ...(s.args ? { args: s.args } : {}), fromBlock: from, toBlock: to, strict: true } as Parameters<SourceClient["getLogs"]>[0])) as unknown as RawLog[];
    for (const l of logs) {
      if (l.transactionHash == null || l.logIndex == null || l.blockNumber == null) throw new Error("pending log returned");
      out.push(l);
    }
  }
  return out;
}

function field(l: RawLog, name: string): unknown {
  if (!(name in l.args)) throw new Error(`event has no argument "${name}"`);
  return l.args[name];
}

function amountOf(l: RawLog, name: string, decimals: number): string {
  const v = field(l, name);
  if (typeof v !== "bigint") throw new Error(`argument "${name}" is not a uint`);
  return formatUnits(v, decimals);
}

export async function loadFromRpc(cfg: RpcSourceConfig, clients: Record<number, SourceClient>): Promise<LegacySourceData> {
  const chunk = cfg.chunk ?? 5000n;
  const client = (id: number): SourceClient => {
    const c = clients[id];
    if (!c) throw new Error(`no RPC client for chain ${id}`);
    return c;
  };
  const tsCache = new Map<string, number>();
  const ts = async (id: number, n: bigint): Promise<number> => {
    const k = `${id}:${n}`;
    let t = tsCache.get(k);
    if (t === undefined) {
      t = Number((await client(id).getBlock({ blockNumber: n })).timestamp);
      tsCache.set(k, t);
    }
    return t;
  };
  const orders: SourceOrder[] = [];
  for (const s of cfg.orders) {
    for (const l of await fetchLogs(client(s.chainId), s, chunk)) {
      orders.push({
        srcChainId: s.chainId,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
        timestamp: await ts(s.chainId, l.blockNumber),
        direction: s.direction,
        from: getAddress(field(l, s.fields.from) as string),
        ...(s.fields.recipient ? { recipient: getAddress(field(l, s.fields.recipient) as string) } : {}),
        amount: amountOf(l, s.fields.amount, s.decimals),
      });
    }
  }
  const payouts: OldPayout[] = [];
  for (const s of cfg.payouts) {
    for (const l of await fetchLogs(client(s.chainId), s, chunk)) {
      const p: OldPayout = { chainId: s.chainId, txHash: l.transactionHash, logIndex: l.logIndex, to: getAddress(field(l, s.fields.to) as string), amount: amountOf(l, s.fields.amount, s.decimals) };
      if (s.fields.srcTxHash) p.srcTxHash = field(l, s.fields.srcTxHash) as Hex;
      if (s.fields.srcLogIndex) p.srcLogIndex = Number(field(l, s.fields.srcLogIndex));
      payouts.push(p);
    }
  }
  return { orders, payouts };
}
