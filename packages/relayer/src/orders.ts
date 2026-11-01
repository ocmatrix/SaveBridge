import type { Db } from "./db/types";
import type { Address, Direction, Hex } from "./types";
import { addrFromBytes, fromBytes, toBig, toBytes } from "./bytes";
import { assertTransition, isTerminal, type OrderStatus, type ReviewLevel, type WaitReason } from "./stateMachine";

export interface Order {
  eventKey: Hex;
  direction: Direction;
  srcChain: number;
  srcEventNonce: bigint;
  srcTxHash: Hex;
  srcBlockNumber: bigint | null;
  userAddr: Address;
  toAddr: Address;
  amountWei: bigint;
  status: OrderStatus;
  reason: string | null;
  reviewLevel: ReviewLevel | null;
  stateSince: Date;
  executableAt: Date | null;
  lastTxHash: Hex | null;
  lastError: string | null;
  timeoutAlertedFor: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

export interface NewOrder {
  eventKey: Hex;
  direction: Direction;
  srcChain: number;
  srcEventNonce: bigint;
  srcTxHash: Hex;
  srcBlockNumber: bigint;
  srcBlockHash: Hex;
  userAddr: Address;
  toAddr: Address;
  amountWei: bigint;
}

export interface TransitionPatch {
  reason?: WaitReason | string | null;
  reviewLevel?: ReviewLevel | null;
  executableAt?: Date | null;
  lastTxHash?: Hex | null;
  lastError?: string | null;
}

type Row = Record<string, unknown>;

function rowToOrder(r: Row): Order {
  return {
    eventKey: fromBytes(r.event_key as Uint8Array)!,
    direction: r.direction as Direction,
    srcChain: Number(r.src_chain),
    srcEventNonce: toBig(r.src_event_nonce),
    srcTxHash: fromBytes(r.src_tx_hash as Uint8Array)!,
    srcBlockNumber: r.src_block_number === null || r.src_block_number === undefined ? null : toBig(r.src_block_number),
    userAddr: addrFromBytes(r.user_addr as Uint8Array),
    toAddr: addrFromBytes(r.to_addr as Uint8Array),
    amountWei: toBig(r.amount_wei),
    status: r.status as OrderStatus,
    reason: (r.reason as string | null) ?? null,
    reviewLevel: (r.review_level as ReviewLevel | null) ?? null,
    stateSince: new Date(r.state_since as string | Date),
    executableAt: r.executable_at ? new Date(r.executable_at as string | Date) : null,
    lastTxHash: fromBytes(r.last_tx_hash as Uint8Array | null),
    lastError: (r.last_error as string | null) ?? null,
    timeoutAlertedFor: (r.timeout_alerted_for as string | null) ?? null,
    approvedAt: r.approved_at ? new Date(r.approved_at as string | Date) : null,
    createdAt: new Date(r.created_at as string | Date),
  };
}

export class OrderRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Idempotent: the unique event_key makes duplicate events a no-op. Returns true when inserted. */
  async insertDetected(o: NewOrder): Promise<boolean> {
    const t = this.now();
    const r = await this.db.query(
      `insert into orders (event_key, direction, src_chain, src_event_nonce, src_tx_hash, user_addr, to_addr, amount_wei,
         status, src_block_number, src_block_hash, state_since, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'DETECTED',$9,$10,$11,$11,$11)
       on conflict (event_key) do nothing returning event_key`,
      [
        toBytes(o.eventKey),
        o.direction,
        o.srcChain,
        o.srcEventNonce.toString(),
        toBytes(o.srcTxHash),
        toBytes(o.userAddr),
        toBytes(o.toAddr),
        o.amountWei.toString(),
        o.srcBlockNumber.toString(),
        toBytes(o.srcBlockHash),
        t,
      ],
    );
    return r.rows.length === 1;
  }

  async get(eventKey: Hex): Promise<Order | null> {
    const r = await this.db.query<Row>("select * from orders where event_key = $1", [toBytes(eventKey)]);
    return r.rows[0] ? rowToOrder(r.rows[0]) : null;
  }

  async count(): Promise<number> {
    const r = await this.db.query<{ n: number }>("select count(*)::int as n from orders");
    return r.rows[0]!.n;
  }

  async listByStatus(statuses: OrderStatus[], direction?: Direction): Promise<Order[]> {
    const r = await this.db.query<Row>(
      `select * from orders where status = any($1::text[]) ${direction ? "and direction = $2" : ""} order by created_at, src_event_nonce`,
      direction ? [statuses, direction] : [statuses],
    );
    return r.rows.map(rowToOrder);
  }

  async listActive(): Promise<Order[]> {
    const r = await this.db.query<Row>(
      "select * from orders where status not in ('RELEASED','REFUNDED') order by created_at, src_event_nonce",
    );
    return r.rows.map(rowToOrder);
  }

  async listByAddress(addr: Address, limit = 100): Promise<Order[]> {
    const b = toBytes(addr);
    const r = await this.db.query<Row>(
      "select * from orders where user_addr = $1 or to_addr = $1 order by created_at desc limit $2",
      [b, limit],
    );
    return r.rows.map(rowToOrder);
  }

  /**
   * Compare-and-set transition validated against the §6.3 table (direction-aware reason rules).
   * Returns false if the row was no longer in `o.status` (stale read). Same-state updates (e.g. a
   * WAITING reason change) keep `state_since` unless the reason changes.
   */
  async move(o: Pick<Order, "eventKey" | "direction" | "status">, to: OrderStatus, patch: TransitionPatch = {}): Promise<boolean> {
    if (isTerminal(o.status)) throw new Error(`order ${o.eventKey} is terminal (${o.status})`);
    if (o.status !== to || to === "WAITING") assertTransition(o.direction, o.status, to, (patch.reason as WaitReason) ?? null);
    const t = this.now();
    const r = await this.db.query(
      `update orders set
         status = $3,
         reason = $4,
         review_level = $5,
         state_since = case when status <> $3 or reason is distinct from $4 then $6::timestamptz else state_since end,
         timeout_alerted_for = case when status <> $3 or reason is distinct from $4 then null else timeout_alerted_for end,
         executable_at = case when $7::boolean then $8::timestamptz else executable_at end,
         last_tx_hash = coalesce($9, last_tx_hash),
         last_error = $10,
         reasons = coalesce(reasons, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('from', $2::text, 'to', $3::text, 'reason', $4::text, 'at', $6::timestamptz)),
         updated_at = $6
       where event_key = $1 and status = $2 returning event_key`,
      [
        toBytes(o.eventKey),
        o.status,
        to,
        patch.reason ?? null,
        to === "REVIEW" ? (patch.reviewLevel ?? "audit") : null,
        t,
        patch.executableAt !== undefined,
        patch.executableAt ?? null,
        patch.lastTxHash ? toBytes(patch.lastTxHash) : null,
        patch.lastError ?? null,
      ],
    );
    return r.rows.length === 1;
  }

  async markTimeoutAlerted(eventKey: Hex, tag: string): Promise<void> {
    await this.db.query("update orders set timeout_alerted_for = $2 where event_key = $1", [toBytes(eventKey), tag]);
  }
}
