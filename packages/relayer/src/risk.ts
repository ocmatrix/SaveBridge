import type { BridgeView } from "./chain/bridges";
import { OrderStatusOnChain } from "./chain/bridges";
import type { AlertSink } from "./alerts";
import type { Order } from "./orders";
import type { ReviewLevel, WaitReason } from "./stateMachine";

/**
 * Risk hook (DESIGN §7; full fund-source tracing engine is PR-4 and will replace DefaultRiskEngine).
 * AUTO = pay now (release); DELAY = queueRelease; REVIEW = owner decision; WAIT = retry later.
 */
export type RiskDecision =
  | { kind: "AUTO" }
  | { kind: "DELAY" }
  | { kind: "REVIEW"; level: ReviewLevel; reason?: string }
  | { kind: "WAIT"; reason: WaitReason };

export interface RiskContext {
  /** Sum of amounts this payout chain still owes for already-queued / in-flight payouts (excl. this order). */
  outstandingWei: bigint;
}

export interface RiskEngine {
  evaluate(order: Order, ctx: RiskContext): Promise<RiskDecision>;
}

/**
 * Default engine using only on-chain information (no fund-source tracing):
 * W2B: WANTOS order re-read (must be Locked, same user/amount) → BSC paused → both-chain whitelist →
 *      per-address cap (amount limit → REVIEW) → remaining daily/address quota → reserve →
 *      largeThreshold (AUTO vs DELAY).
 * B2W: BSC deposit re-read → WANTOS paused → b2wDailyCap remaining → reserve → always DELAY.
 */
export class DefaultRiskEngine implements RiskEngine {
  constructor(
    private readonly wantos: BridgeView,
    private readonly bsc: BridgeView,
    private readonly alerts: AlertSink,
  ) {}

  async evaluate(o: Order, ctx: RiskContext): Promise<RiskDecision> {
    return o.direction === "W2B" ? this.w2b(o, ctx) : this.b2w(o, ctx);
  }

  private async mismatch(o: Order, what: string): Promise<RiskDecision> {
    await this.alerts.emit({
      kind: "ORDER_ONCHAIN_MISMATCH",
      key: o.eventKey,
      message: `${o.direction} order ${o.srcEventNonce}: ${what}; not paying, frozen for owner review`,
      data: { eventKey: o.eventKey },
    });
    return { kind: "REVIEW", level: "freeze", reason: "onchain_mismatch" };
  }

  private async w2b(o: Order, ctx: RiskContext): Promise<RiskDecision> {
    // §5.3 third line of defence: re-read WANTOS orders[id].status == Locked before any BSC payout.
    const src = await this.wantos.order(o.srcEventNonce);
    if (src.status !== OrderStatusOnChain.Locked) return this.mismatch(o, `WANTOS order status ${src.status} != Locked`);
    if (src.user.toLowerCase() !== o.userAddr.toLowerCase() || src.amount !== o.amountWei) {
      return this.mismatch(o, "WANTOS order user/amount differ from the event");
    }
    if (await this.bsc.paused()) return { kind: "WAIT", reason: "paused" };
    const [wlW, wlB] = await Promise.all([this.wantos.whitelisted(o.userAddr), this.bsc.whitelisted(o.toAddr)]);
    // bridgeOut required the WANTOS whitelist at creation, so "not whitelisted on WANTOS now" means it was
    // removed afterwards (removals go WANTOS first, §4.4) → owner decides (REJECTED per §4.4; see PR3-NOTES).
    if (!wlW) return { kind: "REVIEW", level: "audit", reason: "whitelist_removed" };
    if (!wlB) return { kind: "WAIT", reason: "whitelist" };
    const p = await this.bsc.bscParams();
    if (o.amountWei > p.perAddrDailyCap) return { kind: "REVIEW", level: "audit", reason: "amount_limit" };
    const day = await this.bsc.currentDay();
    const [used, addrUsed] = await Promise.all([this.bsc.dailyUsed(day), this.bsc.addrDailyUsed(day, o.toAddr)]);
    if (p.dailyCap - used < o.amountWei || p.perAddrDailyCap - addrUsed < o.amountWei) return { kind: "WAIT", reason: "quota" };
    if ((await this.bsc.tokenBalance()) < o.amountWei + ctx.outstandingWei) return { kind: "WAIT", reason: "reserve" };
    return o.amountWei > p.largeThreshold ? { kind: "DELAY" } : { kind: "AUTO" };
  }

  private async b2w(o: Order, ctx: RiskContext): Promise<RiskDecision> {
    const d = await this.bsc.deposit(o.srcEventNonce);
    if (d.from.toLowerCase() !== o.userAddr.toLowerCase() || d.amount !== o.amountWei) return this.mismatch(o, "BSC deposit differs from the event");
    if (d.refundStatus !== 0) return this.mismatch(o, `BSC deposit refund status ${d.refundStatus}`);
    if (await this.wantos.paused()) return { kind: "WAIT", reason: "paused" };
    const p = await this.wantos.wantosParams();
    const used = await this.wantos.dailyUsed(await this.wantos.currentDay());
    if (p.b2wDailyCap - used < o.amountWei) return { kind: "WAIT", reason: "quota" };
    if ((await this.wantos.tokenBalance()) < o.amountWei + ctx.outstandingWei) return { kind: "WAIT", reason: "reserve" };
    return { kind: "DELAY" };
  }
}
