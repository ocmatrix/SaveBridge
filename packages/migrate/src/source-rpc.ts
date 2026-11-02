import { formatUnits, getAddress, isAddress, parseAbiItem, type AbiEvent, type Address, type Hex, type PublicClient } from "viem";
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
  /** Order specs: a block number (e.g. the block at T) or "latest". Payout specs: only "latest" (see PayoutEventSpec). */
  toBlock: bigint | "latest";
  /** Token decimals of the amount argument. */
  decimals: number;
  /** When set, `decimals()` of this token must equal `decimals` (checked once per spec). */
  token?: Address;
  /** Optional indexed-argument filter, e.g. { from: "0xeC6E…" } for transfers out of the old vault. */
  args?: Record<string, string>;
}

export interface OrderEventSpec extends EventSpec {
  direction: Direction;
  fields: { from: string; recipient?: string; amount: string };
}

export interface PayoutEventSpec extends EventSpec {
  /** Always the current head: a late old-bridge payout is exactly what must not be missed. */
  toBlock: "latest";
  fields: { to: string; amount: string; srcTxHash?: string; srcLogIndex?: string };
}

export interface RpcSourceConfig {
  orders: OrderEventSpec[];
  payouts: PayoutEventSpec[];
  /** Blocks per getLogs call (default 5000). */
  chunk?: bigint;
}

export type SourceClient = Pick<PublicClient, "getLogs" | "getBlock" | "readContract" | "getBlockNumber" | "getChainId">;

class ConfigError extends Error {
  constructor(msg: string) {
    super(`rpc-config: ${msg}`);
  }
}

/**
 * Runtime check of an RPC source config (it usually comes from JSON, so the TypeScript types prove nothing).
 * Block numbers must be real bigints; payout specs must read to "latest"; anything else is a config error.
 */
export function checkRpcConfig(cfg: unknown): asserts cfg is RpcSourceConfig {
  if (typeof cfg !== "object" || cfg === null) throw new ConfigError("not an object");
  const c = cfg as Record<string, unknown>;
  if (!Array.isArray(c["orders"]) || !Array.isArray(c["payouts"])) throw new ConfigError("orders[] and payouts[] are required");
  if (c["chunk"] !== undefined && (typeof c["chunk"] !== "bigint" || c["chunk"] < 1n)) throw new ConfigError(`chunk must be a bigint ≥ 1, got ${String(c["chunk"])}`);
  const specs = [...(c["orders"] as unknown[]).map((x, i) => ["order", x, i] as const), ...(c["payouts"] as unknown[]).map((x, i) => ["payout", x, i] as const)];
  specs.forEach(([kind, x, i]) => {
    const where = `${kind} spec #${i}`;
    if (typeof x !== "object" || x === null) throw new ConfigError(`${where} is not an object`);
    const s = x as Record<string, unknown>;
    if (!Number.isSafeInteger(s["chainId"]) || (s["chainId"] as number) <= 0) throw new ConfigError(`${where}: bad chainId ${String(s["chainId"])}`);
    if (typeof s["address"] !== "string" || !isAddress(s["address"], { strict: false })) throw new ConfigError(`${where}: bad address ${String(s["address"])}`);
    if (typeof s["fromBlock"] !== "bigint" || s["fromBlock"] < 0n) throw new ConfigError(`${where}: fromBlock must be a bigint (write "123n"), got ${JSON.stringify(String(s["fromBlock"]))}`);
    const to = s["toBlock"];
    if (kind === "payout") {
      if (to !== "latest") throw new ConfigError(`${where}: toBlock must be the literal "latest", got ${JSON.stringify(typeof to === "bigint" ? `${to}n` : to ?? null)}`);
    } else if (to !== "latest" && typeof to !== "bigint") throw new ConfigError(`${where}: toBlock must be a bigint (write "123n") or "latest", got ${JSON.stringify(to ?? null)}`);
    if (!Number.isSafeInteger(s["decimals"]) || (s["decimals"] as number) < 0) throw new ConfigError(`${where}: bad decimals ${String(s["decimals"])}`);
    if (typeof s["event"] !== "string") throw new ConfigError(`${where}: event signature missing`);
    if (kind === "order" && s["direction"] !== "W2B" && s["direction"] !== "B2W") throw new ConfigError(`${where}: bad direction ${String(s["direction"])}`);
  });
}

interface RawLog {
  address: Address;
  args: Record<string, unknown>;
  transactionHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  removed?: boolean;
}

const decimalsAbi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;

type ResolvedSpec = Omit<EventSpec, "toBlock"> & { toBlock: bigint };

async function fetchLogs(client: SourceClient, s: ResolvedSpec, chunk: bigint): Promise<RawLog[]> {
  if (s.toBlock < s.fromBlock) throw new Error(`toBlock < fromBlock for ${s.event}`);
  if (s.token) {
    const d = Number(await client.readContract({ address: s.token, abi: decimalsAbi, functionName: "decimals" }));
    if (d !== s.decimals) throw new Error(`token ${s.token} has ${d} decimals, config says ${s.decimals}`);
  }
  if (chunk < 1n) throw new Error("chunk must be ≥ 1");
  const event = parseAbiItem(s.event) as AbiEvent;
  if (event.type !== "event") throw new Error(`not an event: ${s.event}`);
  const out: RawLog[] = [];
  for (let from = s.fromBlock; from <= s.toBlock; from += chunk) {
    const to = from + chunk - 1n < s.toBlock ? from + chunk - 1n : s.toBlock;
    const logs = (await client.getLogs({ address: s.address, event, ...(s.args ? { args: s.args } : {}), fromBlock: from, toBlock: to, strict: true } as Parameters<SourceClient["getLogs"]>[0])) as unknown as RawLog[];
    for (const l of logs) {
      if (l.transactionHash == null || l.logIndex == null || l.blockNumber == null) throw new Error("pending log returned");
      if (l.removed === true) throw new Error(`removed (re-orged) log ${l.transactionHash}#${l.logIndex}`);
      if (typeof l.address !== "string" || l.address.toLowerCase() !== s.address.toLowerCase()) throw new Error(`log from ${String(l.address)}, expected ${s.address}`);
      if (l.blockNumber < from || l.blockNumber > to) throw new Error(`log at block ${l.blockNumber} outside ${from}..${to}`);
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

/**
 * Loads old orders and payouts. Fails closed (throws) on anything that could hide a payment:
 * an invalid config (checkRpcConfig: payout specs always read to "latest" = the head at load start), a chain with
 * order specs but no payout spec on itself and on another chain, an RPC serving another chain id, a payout spec that
 * returns no logs (wrong address / range), and a tx captured by two different order specs (two oldKeys).
 */
export async function loadFromRpc(cfg: RpcSourceConfig, clients: Record<number, SourceClient>): Promise<LegacySourceData> {
  checkRpcConfig(cfg);
  const chunk = cfg.chunk ?? 5000n;
  const client = (id: number): SourceClient => {
    const c = clients[id];
    if (!c) throw new Error(`no RPC client for chain ${id}`);
    return c;
  };
  // every order chain needs payout coverage on itself (refunds from the old vault) and on another chain (the bridge payout)
  const payoutChains = new Set(cfg.payouts.map((p) => p.chainId));
  for (const o of cfg.orders) {
    if (!payoutChains.has(o.chainId)) throw new Error(`chain ${o.chainId} has order specs but no payout spec`);
    if (![...payoutChains].some((c) => c !== o.chainId)) throw new Error(`orders on chain ${o.chainId} need a payout spec on the other chain`);
  }
  const heads = new Map<number, bigint>();
  for (const id of new Set([...cfg.orders, ...cfg.payouts].map((x) => x.chainId))) {
    const got = await client(id).getChainId();
    if (got !== id) throw new Error(`RPC for chain ${id} serves chain ${got}`);
    heads.set(id, await client(id).getBlockNumber({ cacheTime: 0 }));
  }
  const resolve = <S extends EventSpec>(s: S): Omit<S, "toBlock"> & { toBlock: bigint } => ({ ...s, toBlock: s.toBlock === "latest" ? heads.get(s.chainId)! : s.toBlock });
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
  const txSpec = new Map<string, number>();
  for (const [si, s] of cfg.orders.entries()) {
    for (const l of await fetchLogs(client(s.chainId), resolve(s), chunk)) {
      const tk = `${s.chainId}|${l.transactionHash.toLowerCase()}`;
      const prev = txSpec.get(tk);
      if (prev !== undefined && prev !== si) throw new Error(`tx ${l.transactionHash} was captured by order specs #${prev} and #${si} (it would become two oldKeys)`);
      txSpec.set(tk, si);
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
  for (const [si, raw] of cfg.payouts.entries()) {
    const s = resolve(raw);
    const logs = await fetchLogs(client(s.chainId), s, chunk);
    if (logs.length === 0) throw new Error(`payout spec #${si} (${s.event} @ ${s.address}) returned no logs — check address/range`);
    for (const l of logs) {
      const p: OldPayout = { chainId: s.chainId, txHash: l.transactionHash, logIndex: l.logIndex, timestamp: await ts(s.chainId, l.blockNumber), to: getAddress(field(l, s.fields.to) as string), amount: amountOf(l, s.fields.amount, s.decimals) };
      if (s.fields.srcTxHash) p.srcTxHash = field(l, s.fields.srcTxHash) as Hex;
      if (s.fields.srcLogIndex) p.srcLogIndex = Number(field(l, s.fields.srcLogIndex));
      payouts.push(p);
    }
  }
  return { orders, payouts };
}
