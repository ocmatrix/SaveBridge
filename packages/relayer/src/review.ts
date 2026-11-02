import { hashMessage, type PublicClient } from "viem";
import type { AlertSink } from "./alerts";
import type { BridgeView } from "./chain/bridges";
import type { Db } from "./db/types";
import { OrderRepo } from "./orders";
import { toBytes } from "./bytes";
import { PayoutStatus } from "./classify";
import type { Hex } from "./types";

export type ReviewDecision = "approve" | "reject";

/** A signed decision is only accepted if it expires within 24h (limits replay of a leaked signature). */
export const MAX_DECISION_TTL_S = 24n * 3600n;

/**
 * Message the owner signs (EIP-191 personal_sign) with the ADMIN wallet for an order review
 * (DESIGN §6.1: verified by the relayer, never by the Cloudflare Worker). `chainId` is the payout
 * chain (BSC for W2B, WANTOS for B2W). Contract with PR-6, see PR3-NOTES §接口约定.
 */
export function reviewMessage(a: { chainId: number; eventKey: Hex; decision: ReviewDecision; expires: bigint }): string {
  return [
    "WANTOS-BSC-BRIDGE-V2 review decision",
    `chainId: ${a.chainId}`,
    `eventKey: ${a.eventKey.toLowerCase()}`,
    `decision: ${a.decision}`,
    `expires: ${a.expires}`,
  ].join("\n");
}

export interface ReviewInput {
  eventKey: Hex;
  decision: ReviewDecision;
  expires: bigint;
  signature: Hex;
}

export class ReviewService {
  constructor(
    private readonly o: {
      db: Db;
      alerts: AlertSink;
      payoutView: (direction: "W2B" | "B2W") => { view: BridgeView; chainId: number; client: PublicClient };
      now: () => Date;
    },
  ) {}

  /** Verifies the admin-wallet signature (EOA or, via ERC-1271, a multisig) and applies the decision. */
  async decide(r: ReviewInput): Promise<void> {
    const repo = new OrderRepo(this.o.db, this.o.now);
    const order = await repo.get(r.eventKey);
    if (!order) throw new Error("unknown order");
    if (order.status !== "REVIEW") throw new Error(`order is ${order.status}, not REVIEW`);
    const nowSec = BigInt(Math.floor(this.o.now().getTime() / 1000));
    if (r.expires < nowSec) throw new Error("decision expired");
    if (r.expires > nowSec + MAX_DECISION_TTL_S) throw new Error("decision expires too far in the future (max 24h)");
    const { view, chainId, client } = this.o.payoutView(order.direction);
    if (r.decision === "reject") {
      // Gate2 B1: never mark REJECTED (→ refund path) an order whose payout already went out.
      const p = await view.payout(r.eventKey);
      if (p.status === PayoutStatus.Released) {
        await this.o.alerts.emit({
          kind: "PAYOUT_ALREADY_RELEASED",
          key: r.eventKey,
          message: `reject refused for ${r.eventKey}: payout is already Released on chain ${chainId}; a refund would pay twice`,
          data: { eventKey: r.eventKey },
        });
        throw new Error("payout already released; reject refused");
      }
    }
    const admin = await view.adminWallet();
    const message = reviewMessage({ chainId, eventKey: r.eventKey, decision: r.decision, expires: r.expires });
    const ok = await client.verifyMessage({ address: admin, message, signature: r.signature }).catch(() => false);
    if (!ok) {
      await this.o.alerts.emit({ kind: "REVIEW_SIGNATURE_INVALID", key: r.eventKey, message: `review ${r.decision} for ${r.eventKey}: signature is not from the admin wallet` });
      throw new Error("invalid review signature");
    }
    await this.o.db.tx(async (t) => {
      // Gate2 r2 A-2: each signed decision is single-use. Keyed on the signed MESSAGE hash, so a
      // re-encoded (e.g. high-s) signature of the same message is refused as well.
      const used = await t.query(
        "insert into review_signatures (msg_hash, event_key, decision, at) values ($1, $2, $3, $4) on conflict do nothing returning msg_hash",
        [toBytes(hashMessage(message)), toBytes(r.eventKey), r.decision, this.o.now()],
      );
      if (used.rows.length !== 1) throw new Error("review signature already used");
      const tr = new OrderRepo(t, this.o.now);
      if (r.decision === "reject") {
        if (!(await tr.move(order, "REJECTED", { reason: "review_rejected" }))) throw new Error("order changed concurrently");
      } else {
        // The approval is scoped to the REVIEW level+reason being approved; re-entering REVIEW with a
        // different level or reason clears it (OrderRepo.move).
        const upd = await t.query(
          `update orders set approved_at = $2, approved_by = $3, approved_level = $4, approved_reason = $5
            where event_key = $1 and status = 'REVIEW' and review_level is not distinct from $4 and reason is not distinct from $5
            returning event_key`,
          [toBytes(r.eventKey), this.o.now(), toBytes(admin), order.reviewLevel, order.reason],
        );
        if (upd.rows.length !== 1) throw new Error("order changed concurrently; approval not recorded");
      }
      await t.query("insert into audit_log (actor, action, payload, at) values ($1, $2, $3, $4)", [
        admin,
        `review.${r.decision}`,
        JSON.stringify({ eventKey: r.eventKey, expires: r.expires.toString(), signature: r.signature }),
        this.o.now(),
      ]);
    });
  }
}
