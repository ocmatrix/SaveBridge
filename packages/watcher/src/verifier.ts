import { TransactionReceiptNotFoundError, getAbiItem, toEventSelector, type AbiEvent, type Address, type PublicClient } from "viem";
import type { WatcherConfig } from "./config.js";
import { DEPOSIT_REFUND, ORDER_STATUS, STATUS, bridgeAbiOf, computeEventKey, decodeLog } from "./events.js";
import type { Consensus, MultiRpc } from "./rpc.js";
import type { ChainName, CheckKind, DerivedState, PendingCheck } from "./types.js";

export type Verdict =
  | { kind: "match" }
  | { kind: "cancelled"; reason: string }
  | { kind: "no-target" }
  | { kind: "mismatch"; reason: string; observed: unknown }
  | { kind: "undecided"; reason: string; answers?: unknown };

/** The chain whose state proves (or disproves) a target event. */
export const SOURCE_CHAIN: Record<CheckKind, ChainName> = { w2b: "wantos", b2w: "bsc", refund: "bsc", depositRefund: "wantos" };

const NONCE_FIELD: Record<CheckKind, string> = { w2b: "srcEventNonce", b2w: "srcEventNonce", refund: "orderId", depositRefund: "nonce" };

type SourceAnswer = { ok: true } | { ok: false; reason: string; observed: unknown };

const sameAddr = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Re-checks a pending item independently on every configured RPC (DESIGN §9.1 condition ②):
 *  1. the target event really exists (receipt + log) — protects against a lying/stale primary RPC;
 *  2. the target is not already cancelled (benign);
 *  3. the source-chain fact holds, read at the watcher's own processed source block.
 * Any RPC disagreement → `undecided` (never pause on disagreement).
 */
export class Verifier {
  constructor(
    private readonly cfg: WatcherConfig,
    private readonly rpc: Record<ChainName, MultiRpc>,
    private readonly derived: () => DerivedState,
  ) {}

  async verdict(p: PendingCheck): Promise<Verdict> {
    const src = SOURCE_CHAIN[p.kind];
    const srcCursor = this.derived()[src].cursor;
    const tgtCursor = this.derived()[p.targetChain].cursor;
    if (!srcCursor || !tgtCursor) return { kind: "undecided", reason: "cursor missing" };

    const present = await this.rpc[p.targetChain].consensus((c) => this.targetPresent(c, p));
    if (!present.ok) return undecided("target event", present);
    if (!present.value) return { kind: "no-target" };

    const cancelled = await this.rpc[p.targetChain].consensus((c) => this.isCancelled(c, p, BigInt(tgtCursor.number)));
    if (!cancelled.ok) return undecided("cancellation state", cancelled);
    if (cancelled.value) return { kind: "cancelled", reason: "target voided/cancelled on chain" };

    const source = await this.rpc[src].consensus((c) => this.sourceHolds(c, p, BigInt(srcCursor.number)));
    if (!source.ok) return undecided(`source state on ${src}`, source);
    return source.value.ok ? { kind: "match" } : { kind: "mismatch", reason: source.value.reason, observed: source.value.observed };
  }

  private async targetPresent(c: PublicClient, p: PendingCheck): Promise<boolean> {
    let receipt;
    try {
      receipt = await c.getTransactionReceipt({ hash: p.txHash });
    } catch (e) {
      if (e instanceof TransactionReceiptNotFoundError) return false;
      throw e;
    }
    if (receipt.status !== "success") return false;
    const bridge = this.cfg.chains[p.targetChain].bridge;
    const abi = bridgeAbiOf(p.targetChain);
    const topic0 = toEventSelector(getAbiItem({ abi, name: p.eventName }) as AbiEvent);
    const log = receipt.logs.find((l) => l.logIndex === p.logIndex);
    if (!log || !sameAddr(log.address, bridge) || log.topics[0] !== topic0) return false;
    const d = decodeLog(abi, log);
    return d !== null && String(d.args["amount"]) === p.amount && String(d.args[NONCE_FIELD[p.kind]]) === p.nonce;
  }

  private async isCancelled(c: PublicClient, p: PendingCheck, at: bigint): Promise<boolean> {
    const t = this.cfg.chains[p.targetChain];
    const abi = bridgeAbiOf(p.targetChain);
    if (p.kind === "w2b" || p.kind === "b2w") {
      if (p.eventName !== "ReleaseQueued") return false; // a Released payout cannot be cancelled
      const r = (await c.readContract({ address: t.bridge, abi, functionName: "payouts", args: [p.eventKey], blockNumber: at })) as readonly [Address, bigint, bigint, number];
      return Number(r[3]) === STATUS.Voided;
    }
    if (p.kind === "refund") {
      const o = (await c.readContract({ address: t.bridge, abi, functionName: "orders", args: [BigInt(p.nonce)], blockNumber: at })) as readonly [Address, bigint, bigint, number, bigint];
      return Number(o[3]) !== ORDER_STATUS.Refunding;
    }
    const d = (await c.readContract({ address: t.bridge, abi, functionName: "deposits", args: [BigInt(p.nonce)], blockNumber: at })) as readonly [Address, bigint, bigint, number];
    return Number(d[3]) !== DEPOSIT_REFUND.Refunding;
  }

  private async sourceHolds(c: PublicClient, p: PendingCheck, at: bigint): Promise<SourceAnswer> {
    const { bsc, wantos } = this.cfg.chains;
    const nonce = BigInt(p.nonce);
    switch (p.kind) {
      case "w2b": {
        // BSC payout ↔ WANTOS BridgeOut(orderId = srcEventNonce): same user, same amount.
        const o = (await c.readContract({ address: wantos.bridge, abi: bridgeAbiOf("wantos"), functionName: "orders", args: [nonce], blockNumber: at })) as readonly [Address, bigint, bigint, number, bigint];
        if (Number(o[3]) === ORDER_STATUS.None) return { ok: false, reason: "no BridgeOut with this orderId on WANTOS", observed: { orderId: p.nonce } };
        if (!sameAddr(o[0], p.to) || o[1].toString() !== p.amount)
          return { ok: false, reason: "BridgeOut user/amount differ", observed: { user: o[0], amount: o[1].toString() } };
        return { ok: true };
      }
      case "b2w": {
        // WANTOS ReleaseQueued ↔ BSC finalized Deposited: nonce, recipient, amount all equal.
        const d = (await c.readContract({ address: bsc.bridge, abi: bridgeAbiOf("bsc"), functionName: "deposits", args: [nonce], blockNumber: at })) as readonly [Address, bigint, bigint, number];
        if (sameAddr(d[0], "0x0000000000000000000000000000000000000000")) return { ok: false, reason: "no finalized BSC Deposited with this nonce", observed: { nonce: p.nonce } };
        if (d[1].toString() !== p.amount) return { ok: false, reason: "deposit amount differs", observed: { amount: d[1].toString() } };
        const known = this.derived().depositBlocks[p.nonce];
        const fromBlock = known !== undefined ? BigInt(known) : bsc.startBlock;
        const depositedEvent = getAbiItem({ abi: bridgeAbiOf("bsc"), name: "Deposited" }) as AbiEvent;
        const logs = await c.getLogs({ address: bsc.bridge, event: depositedEvent, args: { nonce } as never, fromBlock, toBlock: known !== undefined ? BigInt(known) : at });
        const args = (logs[0] as unknown as { args?: Record<string, unknown> } | undefined)?.args;
        if (!args) return { ok: false, reason: "Deposited log not found", observed: { nonce: p.nonce } };
        if (!sameAddr(args["wantosRecipient"], p.to)) return { ok: false, reason: "deposit recipient differs", observed: { wantosRecipient: args["wantosRecipient"] } };
        return { ok: true };
      }
      case "refund": {
        // WANTOS RefundRequested(orderId) ↔ BSC payouts(key derived from orderId) finalized Voided.
        const key = computeEventKey(wantos.chainId, wantos.bridge, nonce);
        const r = (await c.readContract({ address: bsc.bridge, abi: bridgeAbiOf("bsc"), functionName: "payouts", args: [key], blockNumber: at })) as readonly [Address, bigint, bigint, number];
        if (Number(r[3]) !== STATUS.Voided) return { ok: false, reason: "BSC eventKey not finalized as Voided", observed: { eventKey: key, status: Number(r[3]) } };
        return { ok: true };
      }
      case "depositRefund": {
        // BSC DepositRefundRequested(nonce) ↔ WANTOS payouts(key derived from nonce) Voided.
        const key = computeEventKey(bsc.chainId, bsc.bridge, nonce);
        const r = (await c.readContract({ address: wantos.bridge, abi: bridgeAbiOf("wantos"), functionName: "payouts", args: [key], blockNumber: at })) as readonly [Address, bigint, bigint, number];
        if (Number(r[3]) !== STATUS.Voided) return { ok: false, reason: "WANTOS eventKey not Voided", observed: { eventKey: key, status: Number(r[3]) } };
        return { ok: true };
      }
    }
  }
}

function undecided(what: string, c: Consensus<unknown>): Verdict {
  return { kind: "undecided", reason: `RPCs ${c.ok ? "ok" : c.reason} on ${what}`, answers: c.ok ? undefined : c.answers };
}
