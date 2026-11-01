import { encodeFunctionData } from "viem";
import type { AlertSink } from "./alerts";
import type { Db } from "./db/types";
import type { SafetyState } from "./safety";
import type { Hex } from "./types";
import type { BridgeView, PayoutView } from "./chain/bridges";
import { DepositRefundStatus, OrderStatusOnChain } from "./chain/bridges";
import type { TxSender } from "./chain/sender";
import { decodeRevert, type RevertInfo } from "./chain/revert";
import { classifyOutcome, PayoutStatus, type PayoutAction } from "./classify";
import { OrderRepo, type Order, type TransitionPatch } from "./orders";
import type { RiskEngine } from "./risk";
import { canTransition, type OrderStatus, type Timeouts } from "./stateMachine";
import { checkTimeouts } from "./timeouts";
import { fromBytes, toBytes } from "./bytes";

export interface PayoutSide {
  name: "bsc" | "wantos";
  chainId: number;
  view: BridgeView;
  sender: TxSender;
  /** Highest block considered final on this chain (BSC: agreed `finalized`; WANTOS: head - 6). null = unknown → wait. */
  finalBlock(): Promise<bigint | null>;
}

export interface ProcessorOpts {
  db: Db;
  alerts: AlertSink;
  safety: SafetyState;
  risk: RiskEngine;
  now: () => Date;
  bsc: PayoutSide;
  wantos: PayoutSide;
  timeouts?: Timeouts;
}

interface AttemptInfo {
  id: string;
  action: string | null;
  state: string;
  txHash: Hex;
  data?: Hex;
}

/**
 * DESIGN §6.3 order processing. Each `step()`:
 *   1. lets both senders resolve / re-broadcast / bump their in-flight tx,
 *   2. handles every non-terminal order once (snapshot at step start),
 *   3. raises per-state timeout alerts.
 * Terminal states (RELEASED, and QUEUED/REJECTED/REFUNDING transitions) are only recorded from
 * payout-chain state read at a FINAL block.
 */
export class Processor {
  private readonly repo: OrderRepo;
  private finals: Record<"bsc" | "wantos", bigint | null> = { bsc: null, wantos: null };

  constructor(private readonly o: ProcessorOpts) {
    this.repo = new OrderRepo(o.db, o.now);
  }

  private side(o: Pick<Order, "direction">): PayoutSide {
    return o.direction === "W2B" ? this.o.bsc : this.o.wantos;
  }

  async step(): Promise<void> {
    for (const side of [this.o.bsc, this.o.wantos]) {
      try {
        await side.sender.tick();
      } catch (e) {
        await this.o.alerts.emit({ kind: "RPC_UNAVAILABLE", key: `${side.name}:sender`, message: `${side.name} sender tick failed: ${(e as Error).message}` });
      }
    }
    this.finals = { bsc: await this.o.bsc.finalBlock(), wantos: await this.o.wantos.finalBlock() };
    for (const ord of await this.repo.listActive()) {
      try {
        await this.handle(ord);
      } catch (e) {
        // One order (or one flaky read) must never stall the others; it is retried next step.
        await this.o.alerts.emit({
          kind: "ORDER_PROCESSING_ERROR",
          key: `${ord.eventKey}:${ord.status}`,
          message: `${ord.direction} order ${ord.srcEventNonce} (${ord.status}): ${(e as Error).message}`,
        });
      }
    }
    await checkTimeouts({ repo: this.repo, alerts: this.o.alerts, now: this.o.now, timeouts: this.o.timeouts });
  }

  async handle(o: Order): Promise<void> {
    switch (o.status) {
      case "DETECTED":
      case "WAITING":
        return this.evaluateAndSubmit(o);
      case "REVIEW":
        if (o.approvedAt) return this.evaluateAndSubmit(o);
        return this.settleFromFinal(o); // e.g. owner voided it directly on-chain
      case "SUBMITTED":
        return this.settleSubmitted(o);
      case "QUEUED":
        return this.handleQueued(o);
      case "REJECTED":
        return this.handleRejected(o);
      case "REFUNDING":
        return this.handleRefunding(o);
      default:
        return; // FAILED: manual only (retry / reject)
    }
  }

  // ------------------------------------------------------------------ helpers
  private async moveIfChanged(o: Order, to: OrderStatus, patch: TransitionPatch = {}): Promise<boolean> {
    const reason = patch.reason ?? null;
    if (o.status === to && (o.reason ?? null) === reason && patch.executableAt === undefined) return false;
    if (o.status !== to && !canTransition(o.direction, o.status, to)) {
      await this.o.alerts.emit({ kind: "ORDER_FAILED", key: o.eventKey, message: `order ${o.eventKey}: unexpected ${o.status} -> ${to}` });
      if (canTransition(o.direction, o.status, "FAILED")) return this.repo.move(o, "FAILED", { lastError: `unexpected ${o.status}->${to}` });
      return false;
    }
    return this.repo.move(o, to, { reason, ...patch });
  }

  private async finalPayout(o: Order): Promise<PayoutView | null> {
    const side = this.side(o);
    const fin = this.finals[side.name];
    if (fin === null) return null;
    return side.view.payout(o.eventKey, { blockNumber: fin });
  }

  private async checkPayload(o: Order, p: PayoutView): Promise<void> {
    if (p.to.toLowerCase() !== o.toAddr.toLowerCase() || p.amount !== o.amountWei) {
      await this.o.alerts.emit({
        kind: "ORDER_ONCHAIN_MISMATCH",
        key: `payload:${o.eventKey}`,
        message: `payout ${o.eventKey} on-chain to/amount (${p.to}/${p.amount}) differ from the source event (${o.toAddr}/${o.amountWei})`,
      });
    }
  }

  /** Apply a FINAL payout status (§6.3 classification by payouts[eventKey].status). */
  private async applyFinal(o: Order, p: PayoutView): Promise<boolean> {
    if (p.status === PayoutStatus.None) return false;
    await this.checkPayload(o, p);
    if (p.status === PayoutStatus.Released) return this.moveIfChanged(o, "RELEASED");
    if (p.status === PayoutStatus.Voided) return this.moveIfChanged(o, "REJECTED", { reason: "voided" });
    const delay = await this.side(o).view.releaseDelay();
    return this.moveIfChanged(o, "QUEUED", { executableAt: new Date(Number(p.queuedAt + delay) * 1000) });
  }

  private async settleFromFinal(o: Order): Promise<void> {
    const pf = await this.finalPayout(o);
    if (pf && pf.status !== PayoutStatus.None) await this.applyFinal(o, pf);
  }

  private async outstanding(o: Order): Promise<bigint> {
    const r = await this.o.db.query<{ s: string | null }>(
      "select coalesce(sum(amount_wei), 0)::text as s from orders where direction = $1 and status in ('QUEUED','SUBMITTED') and event_key <> $2",
      [o.direction, toBytes(o.eventKey)],
    );
    return BigInt(r.rows[0]?.s ?? "0");
  }

  private async lastAttempt(eventKey: Hex): Promise<AttemptInfo | null> {
    const r = await this.o.db.query<{ id: string; action: string | null; state: string; tx_hash: Uint8Array }>(
      // A resolved (mined/reverted) row of the latest nonce wins over its "replaced" siblings: after a fee
      // bump the ORIGINAL tx may be the one that got mined (Gate2 A3).
      "select id, action, state, tx_hash from tx_attempts where event_key = $1 order by nonce desc, (state in ('mined','reverted')) desc, id desc limit 1",
      [toBytes(eventKey)],
    );
    const row = r.rows[0];
    return row ? { id: row.id, action: row.action, state: row.state, txHash: fromBytes(row.tx_hash)! } : null;
  }

  private async hasOpenAttempt(eventKey: Hex): Promise<boolean> {
    const r = await this.o.db.query("select 1 from tx_attempts where event_key = $1 and state in ('signed','broadcast') limit 1", [toBytes(eventKey)]);
    return r.rows.length > 0;
  }

  private calldata(side: PayoutSide, o: Order, action: PayoutAction): Hex {
    const args = action === "executeRelease" ? [o.srcEventNonce] : [o.srcEventNonce, o.toAddr, o.amountWei];
    return encodeFunctionData({ abi: side.view.abi, functionName: action, args });
  }

  /**
   * Hard precondition before ANY payout tx (Gate2 A1/A2; §5.3 third line of defence). Neither the risk
   * engine nor an owner approval can override it:
   *  W2B: WANTOS orders[id] is Locked with the event's user and amount (no refund requested/executed);
   *  B2W: BSC deposits(nonce) exists with the event's depositor and amount and no refund requested.
   * Returns a description of the mismatch, or null when intact.
   */
  async sourceMismatch(o: Order): Promise<string | null> {
    if (o.direction === "W2B") {
      const src = await this.o.wantos.view.order(o.srcEventNonce);
      if (src.status !== OrderStatusOnChain.Locked) return `WANTOS order status ${src.status} != Locked`;
      if (src.user.toLowerCase() !== o.userAddr.toLowerCase() || src.amount !== o.amountWei) return "WANTOS order user/amount differ from the event";
      return null;
    }
    const d = await this.o.bsc.view.deposit(o.srcEventNonce);
    if (d.from.toLowerCase() !== o.userAddr.toLowerCase() || d.amount !== o.amountWei) return "BSC deposit differs from the event";
    if (d.refundStatus !== DepositRefundStatus.None) return `BSC deposit refund status ${d.refundStatus}`;
    return null;
  }

  /** Returns true (and parks the order) when the source order is no longer intact. */
  private async blockedBySource(o: Order): Promise<boolean> {
    const why = await this.sourceMismatch(o);
    if (!why) return false;
    await this.o.alerts.emit({
      kind: "ORDER_ONCHAIN_MISMATCH",
      key: `source:${o.eventKey}`,
      message: `${o.direction} order ${o.srcEventNonce}: ${why}; not paying${o.status === "QUEUED" ? " (owner must cancelRelease)" : ", frozen for owner review"}`,
      data: { eventKey: o.eventKey },
    });
    if (o.status === "QUEUED") await this.moveIfChanged(o, "QUEUED", { reason: "onchain_mismatch" });
    else if (!(o.status === "REVIEW" && o.reviewLevel === "freeze" && o.reason === "onchain_mismatch")) {
      await this.repo.move(o, "REVIEW", { reason: "onchain_mismatch", reviewLevel: "freeze" });
    }
    return true;
  }

  private async submit(o: Order, action: PayoutAction): Promise<void> {
    if (await this.blockedBySource(o)) return;
    const side = this.side(o);
    const res = await side.sender.send(
      { eventKey: o.eventKey, action, to: side.view.address, data: this.calldata(side, o, action) },
      async (t, txHash) => {
        const ok = await new OrderRepo(t, this.o.now).move(o, "SUBMITTED", { lastTxHash: txHash, reason: null });
        if (!ok) throw new Error(`order ${o.eventKey} changed concurrently`);
      },
    );
    if (res.kind === "sim-revert") await this.applyRevert(o, action, res.revert);
  }

  private async applyRevert(o: Order, action: PayoutAction, rv: RevertInfo): Promise<void> {
    const side = this.side(o);
    const latest = await side.view.payout(o.eventKey);
    const out = classifyOutcome({
      direction: o.direction,
      action,
      payoutStatus: latest.status,
      errorName: rv.errorName,
      errorArgs: rv.args,
      errorMessage: rv.message,
    });
    if (out.alert) await this.o.alerts.emit({ kind: out.alert, key: `${side.name}:${out.alert}`, message: `${side.name}: ${rv.errorName} while ${action} for ${o.eventKey}` });
    const lastError = rv.errorName ?? rv.message ?? rv.raw ?? "revert";
    // RELEASED / REJECTED / QUEUED derived from a non-final read: wait for finality (settled by the final read).
    if (out.status === "RELEASED" || out.status === "REJECTED") return;
    if (out.status === "QUEUED") {
      if (o.status === "QUEUED" || o.status === "SUBMITTED") await this.moveIfChanged(o, "QUEUED", { reason: out.reason ?? null, lastError });
      return;
    }
    if (out.status === "WAITING" && out.reason === "amount_limit") {
      await this.moveIfChanged(o, "REVIEW", { reason: "amount_limit", reviewLevel: "audit", lastError });
      return;
    }
    await this.moveIfChanged(o, out.status, { reason: out.reason ?? null, reviewLevel: out.reviewLevel ?? null, lastError });
  }

  // ------------------------------------------------------------------ DETECTED / WAITING / approved REVIEW
  private async evaluateAndSubmit(o: Order): Promise<void> {
    if (this.o.safety.sendsBlocked()) return;
    const side = this.side(o);
    const pf = await this.finalPayout(o);
    if (pf && pf.status !== PayoutStatus.None) {
      await this.applyFinal(o, pf);
      return;
    }
    if (await this.hasOpenAttempt(o.eventKey)) return;
    const pl = await side.view.payout(o.eventKey);
    if (pl.status === PayoutStatus.Queued) {
      // Crash after queueRelease (state lost): replaying returns "already Queued" without charging quota (§5.6 #13).
      await this.checkPayload(o, pl);
      if (pl.to.toLowerCase() === o.toAddr.toLowerCase() && pl.amount === o.amountWei) await this.submit(o, "queueRelease");
      return;
    }
    if (pl.status !== PayoutStatus.None) return; // Released / Voided but not final yet → wait for the final read
    if (await this.blockedBySource(o)) return;
    const d = await this.o.risk.evaluate(o, { outstandingWei: await this.outstanding(o) });
    // An owner approval only covers the exact REVIEW level+reason it was given for (Gate2 A1).
    const approved = !!o.approvedAt && d.kind === "REVIEW" && d.level === o.approvedLevel && (d.reason ?? null) === o.approvedReason;
    const decision = approved ? ({ kind: "DELAY" } as const) : d;
    switch (decision.kind) {
      case "WAIT":
        if (decision.reason === "amount_limit") await this.moveIfChanged(o, "REVIEW", { reason: "amount_limit", reviewLevel: "audit" });
        else await this.moveIfChanged(o, "WAITING", { reason: decision.reason });
        return;
      case "REVIEW":
        if (o.status !== "REVIEW" || o.reviewLevel !== decision.level || (o.reason ?? null) !== (decision.reason ?? null)) {
          await this.repo.move(o, "REVIEW", { reason: decision.reason ?? null, reviewLevel: decision.level });
        }
        return;
      case "AUTO":
        return this.submit(o, o.direction === "W2B" ? "release" : "queueRelease"); // B2W always queues (§5.3)
      case "DELAY":
        return this.submit(o, "queueRelease");
    }
  }

  // ------------------------------------------------------------------ SUBMITTED
  private async settleSubmitted(o: Order): Promise<void> {
    const pf = await this.finalPayout(o);
    const att = await this.lastAttempt(o.eventKey);
    if (pf && pf.status !== PayoutStatus.None) {
      const executing = att?.action === "executeRelease" && pf.status === PayoutStatus.Queued;
      if (!executing) {
        await this.applyFinal(o, pf);
        return;
      }
      if (att.state !== "reverted" && att.state !== "dropped") return; // execute tx not final yet
    }
    if (!att) {
      await this.moveIfChanged(o, "FAILED", { lastError: "SUBMITTED without any tx attempt" });
      return;
    }
    if (att.state === "signed" || att.state === "broadcast" || att.state === "mined") return; // in flight / awaiting finality
    if (att.state === "reverted") {
      const rv = await this.revertReasonOf(o, att);
      await this.applyRevert(o, (att.action as PayoutAction) ?? "release", rv);
      return;
    }
    // dropped / replaced-only: the nonce was consumed by something else
    await this.moveIfChanged(o, "FAILED", { lastError: `tx ${att.txHash} ${att.state}` });
  }

  /**
   * Re-execute the reverted call against the state AFTER its block to recover a revert reason
   * (the parent-block state would not include a same-block pause/void that made it revert).
   */
  private async revertReasonOf(o: Order, att: AttemptInfo): Promise<RevertInfo> {
    const side = this.side(o);
    try {
      const rc = await side.view.client.getTransactionReceipt({ hash: att.txHash });
      await side.view.client.call({
        account: side.sender.address,
        to: side.view.address,
        data: this.calldata(side, o, (att.action as PayoutAction) ?? "release"),
        blockNumber: rc.blockNumber,
      });
      return { message: "revert reason unavailable" };
    } catch (e) {
      return decodeRevert(e);
    }
  }

  // ------------------------------------------------------------------ QUEUED
  private async handleQueued(o: Order): Promise<void> {
    const side = this.side(o);
    const pl = await side.view.payout(o.eventKey);
    if (pl.status === PayoutStatus.Released || pl.status === PayoutStatus.Voided) {
      await this.settleFromFinal(o);
      return;
    }
    if (pl.status !== PayoutStatus.Queued) {
      await this.o.alerts.emit({ kind: "ORDER_ONCHAIN_MISMATCH", key: `queued:${o.eventKey}`, message: `QUEUED order ${o.eventKey} has payout status ${pl.status} on-chain` });
      return;
    }
    if (this.o.safety.sendsBlocked() || (await this.hasOpenAttempt(o.eventKey))) return;
    const blk = await side.view.client.getBlock({ blockTag: "latest" });
    const delay = await side.view.releaseDelay();
    if (blk.timestamp < pl.queuedAt + delay) return; // not due
    await this.submit(o, "executeRelease");
  }

  // ------------------------------------------------------------------ REJECTED → REFUNDING → REFUNDED (tracking only)
  private async handleRejected(o: Order): Promise<void> {
    const pf = await this.finalPayout(o);
    if (pf?.status === PayoutStatus.Voided) await this.repo.move(o, "REFUNDING", { reason: null });
  }

  private async handleRefunding(o: Order): Promise<void> {
    if (o.direction === "W2B") {
      const fin = this.finals.wantos;
      if (fin === null) return;
      const ord = await this.o.wantos.view.order(o.srcEventNonce, { blockNumber: fin });
      if (ord.status === OrderStatusOnChain.Refunded) await this.repo.move(o, "REFUNDED");
    } else {
      const fin = this.finals.bsc;
      if (fin === null) return;
      const d = await this.o.bsc.view.deposit(o.srcEventNonce, { blockNumber: fin });
      if (d.refundStatus === DepositRefundStatus.Refunded) await this.repo.move(o, "REFUNDED");
    }
  }

  // ------------------------------------------------------------------ manual (ops / PR-6), FAILED only
  async retryFailed(eventKey: Hex): Promise<boolean> {
    const o = await this.repo.get(eventKey);
    if (!o || o.status !== "FAILED") return false;
    return this.repo.move(o, "DETECTED");
  }

  async rejectFailed(eventKey: Hex): Promise<boolean> {
    const o = await this.repo.get(eventKey);
    if (!o || o.status !== "FAILED") return false;
    return this.repo.move(o, "REJECTED", { reason: "manual" });
  }
}
