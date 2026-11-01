import { getAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import type { AppConfig } from "../config";
import type { Clients } from "./clients";
import { b2wUserStatus, parseRelayerOrders, w2bUserStatus, type RelayerOrder, type UserStatus } from "./status";

export interface OrderView {
  direction: "W2B" | "B2W";
  /** W2B: WANTOS orderId. B2W: BSC deposit nonce. */
  id: bigint;
  amount: bigint;
  status: UserStatus;
  srcTxHash: Hex | null;
  dstTxHash: Hex | null;
  /** B2W only: WANTOS recipient (when known from the Deposited event). */
  recipient?: Address;
}

export interface KnownIds {
  w2b?: bigint[];
  b2w?: bigint[];
}

/** Replaceable source of the user's orders and their user-visible status (tests use a mock). */
export interface StatusProvider {
  list(user: Address, known?: KnownIds): Promise<OrderView[]>;
}

type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const CHUNK = 5_000n;

/**
 * Default provider. The chain is authoritative for every status: order ids come from the user's own events
 * (bounded look-back), the optional relayer read API, and ids the page just created; each id is then re-read
 * on chain (orders / deposits / payouts) and must belong to the user.
 */
export class ChainStatusProvider implements StatusProvider {
  constructor(
    private readonly cfg: AppConfig,
    private readonly clients: Clients,
    private readonly fetchFn: Fetch | null = typeof fetch === "function" ? (fetch as unknown as Fetch) : null,
  ) {}

  private async scan<T>(pc: PublicClient, fromBlock: bigint, get: (from: bigint, to: bigint) => Promise<T[]>): Promise<T[]> {
    const latest = await pc.getBlockNumber();
    const floor = latest > this.cfg.logLookback ? latest - this.cfg.logLookback : 0n;
    const start = fromBlock > floor ? fromBlock : floor;
    const out: T[] = [];
    for (let to = latest; to >= start; to -= CHUNK) {
      const from = to - CHUNK + 1n > start ? to - CHUNK + 1n : start;
      out.push(...(await get(from, to)));
      if (from === start) break;
    }
    return out;
  }

  private async fromApi(user: Address): Promise<RelayerOrder[]> {
    if (!this.cfg.relayerApi || !this.fetchFn) return [];
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8_000);
      const res = await this.fetchFn(`${this.cfg.relayerApi}/v1/orders?address=${user}`, {
        signal: ctl.signal,
        headers: { accept: "application/json" },
      });
      clearTimeout(timer);
      return res.ok ? parseRelayerOrders(await res.json()) : [];
    } catch {
      return []; // API is optional; chain remains the source of truth
    }
  }

  async list(user: Address, known: KnownIds = {}): Promise<OrderView[]> {
    const { wantos: w, bsc: b } = this.clients;
    const lc = user.toLowerCase();
    const [outLogs, depLogs, api] = await Promise.all([
      this.scan(w, this.cfg.wantos.fromBlock, (fromBlock, toBlock) =>
        w.getLogs({ address: this.cfg.wantos.bridge, event: getAbiItem({ abi: wantosBridgeV2Abi, name: "BridgeOut" }), args: { user }, fromBlock, toBlock }),
      ),
      this.scan(b, this.cfg.bsc.fromBlock, (fromBlock, toBlock) =>
        b.getLogs({ address: this.cfg.bsc.bridge, event: getAbiItem({ abi: bscVaultV2Abi, name: "Deposited" }), args: { from: user }, fromBlock, toBlock }),
      ),
      this.fromApi(user),
    ]);

    const w2b = new Map<bigint, { src: Hex | null; dst: Hex | null }>();
    const b2w = new Map<bigint, { src: Hex | null; dst: Hex | null; recipient?: Address }>();
    for (const id of known.w2b ?? []) w2b.set(id, { src: null, dst: null });
    for (const id of known.b2w ?? []) b2w.set(id, { src: null, dst: null });
    for (const l of outLogs) if (l.args.orderId !== undefined) w2b.set(l.args.orderId, { src: l.transactionHash, dst: null });
    for (const l of depLogs) {
      if (l.args.nonce !== undefined) b2w.set(l.args.nonce, { src: l.transactionHash, dst: null, recipient: l.args.wantosRecipient });
    }
    for (const o of api) {
      const m = o.direction === "W2B" ? w2b : b2w;
      const prev = m.get(o.nonce);
      m.set(o.nonce, { ...(prev ?? { src: null }), dst: o.dstTxHash ?? prev?.dst ?? null });
    }

    const W = { address: this.cfg.wantos.bridge, abi: wantosBridgeV2Abi } as const;
    const B = { address: this.cfg.bsc.bridge, abi: bscVaultV2Abi } as const;
    const payoutStatus = async (pc: PublicClient, keyOf: () => Promise<Hex>, abi: typeof wantosBridgeV2Abi | typeof bscVaultV2Abi, address: Address) => {
      try {
        const key = await keyOf();
        const p = (await pc.readContract({ address, abi, functionName: "payouts", args: [key] } as never)) as readonly [Address, bigint, bigint, number];
        return Number(p[3]);
      } catch {
        return null;
      }
    };

    const w2bViews = await Promise.all(
      [...w2b].map(async ([id, meta]): Promise<OrderView | null> => {
        const [owner, amount, , status] = await w.readContract({ ...W, functionName: "orders", args: [id] });
        if (status === 0 || owner.toLowerCase() !== lc) return null;
        const ps = await payoutStatus(b, () => b.readContract({ ...B, functionName: "eventKeyOf", args: [id] }), bscVaultV2Abi, B.address);
        return { direction: "W2B", id, amount, status: w2bUserStatus(status, ps), srcTxHash: meta.src, dstTxHash: meta.dst };
      }),
    );
    const b2wViews = await Promise.all(
      [...b2w].map(async ([id, meta]): Promise<OrderView | null> => {
        const [from, amount, , refundStatus] = await b.readContract({ ...B, functionName: "deposits", args: [id] });
        if (amount === 0n || from.toLowerCase() !== lc) return null;
        const ps = await payoutStatus(w, () => w.readContract({ ...W, functionName: "eventKeyOf", args: [id] }), wantosBridgeV2Abi, W.address);
        return {
          direction: "B2W",
          id,
          amount,
          status: b2wUserStatus(refundStatus, ps),
          srcTxHash: meta.src,
          dstTxHash: meta.dst,
          ...(meta.recipient ? { recipient: meta.recipient } : {}),
        };
      }),
    );
    return [...w2bViews, ...b2wViews]
      .filter((x): x is OrderView => x !== null)
      .sort((x, y) => (x.direction === y.direction ? (x.id > y.id ? -1 : 1) : x.direction === "W2B" ? -1 : 1));
  }
}
