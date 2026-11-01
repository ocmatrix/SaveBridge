import type { PublicClient } from "viem";
import type { AlertSink } from "./alerts";
import type { BridgeView } from "./chain/bridges";
import type { Db } from "./db/types";
import { OrderRepo } from "./orders";
import { toBytes } from "./bytes";
import type { Hex } from "./types";

export type ReviewDecision = "approve" | "reject";

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
    const { view, chainId, client } = this.o.payoutView(order.direction);
    const admin = await view.adminWallet();
    const message = reviewMessage({ chainId, eventKey: r.eventKey, decision: r.decision, expires: r.expires });
    const ok = await client.verifyMessage({ address: admin, message, signature: r.signature }).catch(() => false);
    if (!ok) {
      await this.o.alerts.emit({ kind: "REVIEW_SIGNATURE_INVALID", key: r.eventKey, message: `review ${r.decision} for ${r.eventKey}: signature is not from the admin wallet` });
      throw new Error("invalid review signature");
    }
    await this.o.db.tx(async (t) => {
      const tr = new OrderRepo(t, this.o.now);
      if (r.decision === "reject") {
        if (!(await tr.move(order, "REJECTED", { reason: "review_rejected" }))) throw new Error("order changed concurrently");
      } else {
        await t.query("update orders set approved_at = $2, approved_by = $3 where event_key = $1", [toBytes(r.eventKey), this.o.now(), toBytes(admin)]);
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
