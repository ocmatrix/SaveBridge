import { decodeEventLog, type Account, type Address, type Hex } from "viem";
import { b2wEventKey, w2bEventKey } from "@bridge/relayer/src/eventKey";
import { reviewMessage, type ReviewDecision } from "@bridge/relayer/src/review";
import type { Order } from "@bridge/relayer/src/orders";
import { tokenAbi } from "./chain";
import { abiOf, type Ctx } from "./ctx";
import type { RelayerSys } from "./services";

export interface Tracked {
  kind: string;
  dir: "W2B" | "B2W";
  nonce: bigint; // W2B orderId / B2W depositNonce
  key: Hex;
  user: Address;
  to: Address;
  amount: bigint;
  /** Expected terminal status. */
  expect: "RELEASED" | "REFUNDED";
  sentAt: number;
  doneAt?: number;
}

export async function bridgeOut(ctx: Ctx, u: Account, amount: bigint): Promise<bigint> {
  await ctx.chains.wantos.write(u, ctx.d.token.wantos, tokenAbi, "approve", [ctx.d.proxy, amount]); // exact amount, never MaxUint256
  const r = await ctx.chains.wantos.write(u, ctx.d.proxy, abiOf("wantos"), "bridgeOut", [amount]);
  for (const l of r.receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: abiOf("wantos"), data: l.data, topics: l.topics });
      if (ev.eventName === "BridgeOut") return (ev.args as unknown as { orderId: bigint }).orderId;
    } catch {
      /* other event */
    }
  }
  throw new Error("BridgeOut event not found");
}

export async function deposit(ctx: Ctx, u: Account, amount: bigint, recipient: Address): Promise<bigint> {
  await ctx.chains.bsc.write(u, ctx.d.token.bsc, tokenAbi, "approve", [ctx.d.proxy, amount]);
  const r = await ctx.chains.bsc.write(u, ctx.d.proxy, abiOf("bsc"), "deposit", [amount, recipient]);
  for (const l of r.receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: abiOf("bsc"), data: l.data, topics: l.topics });
      if (ev.eventName === "Deposited") return (ev.args as unknown as { nonce: bigint }).nonce;
    } catch {
      /* other event */
    }
  }
  throw new Error("Deposited event not found");
}

export const w2bKey = (ctx: Ctx, id: bigint): Hex => w2bEventKey({ wantosChainId: BigInt(ctx.chains.wantos.chainId), wantosBridge: ctx.d.proxy, orderId: id });
export const b2wKey = (ctx: Ctx, n: bigint): Hex => b2wEventKey({ bscChainId: BigInt(ctx.chains.bsc.chainId), bscVault: ctx.d.proxy, depositNonce: n });

/** Owner review decision, EIP-191 signed by the current admin wallet (PR-6 contract with PR-3). */
export async function decide(ctx: Ctx, r: RelayerSys, o: Order, decision: ReviewDecision): Promise<void> {
  const chainId = o.direction === "W2B" ? ctx.chains.bsc.chainId : ctx.chains.wantos.chainId;
  const expires = BigInt(ctx.clockSec + 3600);
  const admin = ctx.acct("admin") as Account & { signMessage: (x: { message: string }) => Promise<Hex> };
  const signature = await admin.signMessage({ message: reviewMessage({ chainId, eventKey: o.eventKey, decision, expires }) });
  await r.relayer.review.decide({ eventKey: o.eventKey, decision, expires, signature });
}

export interface ChainView {
  wantosOrder: number; // 0 none / 1 Locked / 2 Refunding / 3 Refunded
  bscPayout: number; // 0 none / 1 Queued / 2 Released / 3 Voided
  bscDeposit: number; // 0 / 1 Refunding / 2 Refunded
  wantosPayout: number;
}

export async function chainView(ctx: Ctx, t: Tracked): Promise<ChainView> {
  if (t.dir === "W2B") {
    const o = await ctx.view<readonly [Address, bigint, bigint, number, bigint]>("wantos", "orders", [t.nonce]);
    const p = await ctx.view<readonly [Address, bigint, bigint, number]>("bsc", "payouts", [t.key]);
    return { wantosOrder: Number(o[3]), bscPayout: Number(p[3]), bscDeposit: 0, wantosPayout: 0 };
  }
  const dp = await ctx.view<readonly [Address, bigint, bigint, number]>("bsc", "deposits", [t.nonce]);
  const p = await ctx.view<readonly [Address, bigint, bigint, number]>("wantos", "payouts", [t.key]);
  return { wantosOrder: 0, bscPayout: 0, bscDeposit: Number(dp[3]), wantosPayout: Number(p[3]) };
}

/** §6.3 / §8: order-by-order 3-way reconciliation (source chain, payout chain, relayer DB = what the user page reads). */
export function reconcileOne(t: Tracked, v: ChainView, db: string | undefined): string | null {
  if (t.dir === "W2B") {
    const released = v.bscPayout === 2;
    const refunded = v.wantosOrder === 3;
    if (released && refunded) return "BOTH released and refunded (cross-chain invariant broken)";
    if (db === "RELEASED" && !(released && v.wantosOrder === 1)) return `DB RELEASED but chain payout=${v.bscPayout} order=${v.wantosOrder}`;
    if (db === "REFUNDED" && !(refunded && v.bscPayout === 3)) return `DB REFUNDED but chain payout=${v.bscPayout} order=${v.wantosOrder}`;
  } else {
    const released = v.wantosPayout === 2;
    const refunded = v.bscDeposit === 2;
    if (released && refunded) return "BOTH released and refunded (cross-chain invariant broken)";
    if (db === "RELEASED" && !released) return `DB RELEASED but WANTON payout=${v.wantosPayout}`;
    if (db === "REFUNDED" && !(refunded && v.wantosPayout === 3)) return `DB REFUNDED but deposit=${v.bscDeposit} payout=${v.wantosPayout}`;
  }
  if (db !== t.expect) return `DB ${db ?? "missing"} ≠ expected ${t.expect}`;
  return null;
}

export function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export interface AlertLike {
  chain?: string;
  detail?: Record<string, unknown>;
}

/**
 * True unless the alert is about a chain event older than this stage. The watcher keeps catching up on
 * earlier stages' blocks (bounded ranges per tick in real time), so e.g. the role drills' KEY_CHANGE can
 * arrive during e2e. Alerts without a block (AUTO_PAUSE, state alerts…) always count — fail-closed.
 */
export function raisedForBlocksSince(a: AlertLike, start: Record<"bsc" | "wantos", bigint>): boolean {
  const b = a.detail?.["block"];
  const c = a.chain === "bsc" || a.chain === "wantos" ? a.chain : null;
  if (b === undefined || c === null) return true;
  try {
    return BigInt(String(b)) >= start[c];
  } catch {
    return true;
  }
}
