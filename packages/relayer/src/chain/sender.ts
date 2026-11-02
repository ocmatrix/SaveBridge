import { keccak256, parseTransaction, type PublicClient, type TransactionSerializableLegacy } from "viem";
import type { AlertSink } from "../alerts";
import type { Db } from "../db/types";
import type { SafetyState } from "../safety";
import type { TxSigner } from "../signer";
import type { Address, Hex } from "../types";
import { fromBytes, toBig, toBytes } from "../bytes";
import { decodeRevert, type RevertInfo } from "./revert";
import { errText } from "../redact";

export interface SenderConfig {
  /** Same-nonce fee bump replacement. PR-0 ⑥ not yet verified on WANTOS → configurable, default on. */
  replaceByFee: boolean;
  stuckAfterMs: number;
  feeBumpPercent: number;
  maxFeeBumps: number;
}

export interface SendRequest {
  eventKey: Hex | null;
  action: string;
  to: Address;
  data: Hex;
  gas?: bigint;
}

export type SendResult =
  | { kind: "sent"; txHash: Hex; nonce: number }
  | { kind: "busy" }
  | { kind: "blocked" }
  | { kind: "sim-revert"; revert: RevertInfo }
  /** Simulation failed WITHOUT revert data (transport / node trouble): nothing classified, retried later. */
  | { kind: "rpc-error"; message: string }
  | { kind: "signer-error"; message: string }
  | { kind: "broadcast-error"; txHash: Hex; nonce: number; message: string };

export interface Resolved {
  txHash: Hex;
  eventKey: Hex | null;
  action: string | null;
  success: boolean;
  blockNumber: bigint;
}

export interface TickResult {
  resolved?: Resolved;
  bumped?: boolean;
  rebroadcast?: number;
}

interface AttemptRow {
  id: string;
  event_key: Uint8Array | null;
  nonce: string;
  tx_hash: Uint8Array;
  gas_price: string;
  raw_tx: Uint8Array;
  state: string;
  action: string | null;
  created_at: string | Date;
}

/**
 * Pre-broadcast guard (Gate2 r2 A-1): re-checks the payout's source order right before a signed tx is
 * (re)broadcast or fee-bumped. "unknown" = could not read (RPC error) → do nothing this tick.
 */
export type BroadcastGuard = (eventKey: Hex) => Promise<"ok" | "mismatch" | "unknown">;

export interface TxSenderOpts {
  chainId: number;
  client: PublicClient;
  signer: TxSigner;
  db: Db;
  alerts: AlertSink;
  safety: SafetyState;
  cfg: SenderConfig;
  minBalanceWei?: bigint;
  now?: () => Date;
  /** Fault-injection hooks for tests only. */
  hooks?: { afterSign?: (txHash: Hex) => void | Promise<void> };
}

const OPEN_STATES = ["signed", "broadcast"];

/**
 * DESIGN §6.4 serial sender for one chain / one payout key:
 * - at most one in-flight nonce (strictly serial),
 * - every signed tx is persisted in `tx_attempts` (raw bytes) BEFORE broadcast,
 * - restart: align nonce with the chain, re-broadcast signed-but-unsent raw txs unchanged,
 * - stuck: same-nonce fee-bump replacement (configurable), all hashes recorded.
 */
export class TxSender {
  private nextNonce: number | null = null;
  private guard: BroadcastGuard | null = null;

  /** Installed by the relayer (Processor.broadcastGuard). Applies to every attempt that carries an eventKey. */
  setGuard(g: BroadcastGuard): void {
    this.guard = g;
  }
  private readonly now: () => Date;

  constructor(private readonly o: TxSenderOpts) {
    this.now = o.now ?? (() => new Date());
  }

  get address(): Address {
    return this.o.signer.address;
  }

  private async openAttempts(): Promise<AttemptRow[]> {
    const r = await this.o.db.query<AttemptRow>(
      "select * from tx_attempts where chain_id = $1 and from_addr = $2 and state = any($3::text[]) order by nonce, id",
      [this.o.chainId, toBytes(this.address), OPEN_STATES],
    );
    return r.rows;
  }

  private async setState(id: string, state: string): Promise<void> {
    await this.o.db.query("update tx_attempts set state = $2, updated_at = $3 where id = $1", [id, state, this.now()]);
  }

  private async broadcast(row: Pick<AttemptRow, "id" | "raw_tx" | "tx_hash">): Promise<{ ok: boolean; message?: string }> {
    const raw = fromBytes(row.raw_tx)!;
    try {
      await this.o.client.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) {
      const msg = ((e as Error).message ?? "").toLowerCase();
      // Already in the node's pool / already mined: broadcasting succeeded earlier.
      if (!/already known|known transaction|already imported|nonce too low/.test(msg)) {
        return { ok: false, message: errText(e) };
      }
    }
    await this.setState(row.id, "broadcast");
    return { ok: true };
  }

  /**
   * Startup recovery (§6.4): align the local nonce with the chain, resolve attempts whose nonce has
   * been consumed, and re-broadcast the latest signed raw tx of any still-open nonce as-is.
   */
  async recover(): Promise<void> {
    const addr = this.address;
    const latest = await this.o.client.getTransactionCount({ address: addr, blockTag: "latest" });
    const pending = await this.o.client.getTransactionCount({ address: addr, blockTag: "pending" });
    const mx = await this.o.db.query<{ m: string | null }>(
      "select max(nonce)::text as m from tx_attempts where chain_id = $1 and from_addr = $2",
      [this.o.chainId, toBytes(addr)],
    );
    const dbMax = mx.rows[0]?.m === null || mx.rows[0]?.m === undefined ? -1 : Number(mx.rows[0].m);
    if (dbMax + 1 < latest || pending > Math.max(dbMax + 1, latest)) {
      await this.o.alerts.emit({
        kind: "NONCE_MISMATCH",
        key: `${this.o.chainId}:${addr}`,
        message: `chain ${this.o.chainId}: payout key ${addr} nonce latest=${latest} pending=${pending} but DB knows up to ${dbMax}; key used outside the relayer?`,
        data: { latest, pending, dbMax },
      });
    }
    // Resolve consumed nonces and re-broadcast the rest.
    await this.tick({ rebroadcastAll: true });
    this.nextNonce = Math.max(pending, dbMax + 1, latest);
  }

  /** Resolve / re-broadcast / bump the in-flight attempt group. Call every loop iteration. */
  async tick(opts: { rebroadcastAll?: boolean } = {}): Promise<TickResult> {
    const open = await this.openAttempts();
    if (open.length === 0) return {};
    const nonce = Number(open[0]!.nonce);
    const group = open.filter((r) => Number(r.nonce) === nonce);
    // Abandoned payout attempts of this nonce may still be mined (if they reached a mempool before the
    // cancel); they take part in receipt resolution so the outcome is never lost.
    const abandoned = (
      await this.o.db.query<AttemptRow>(
        "select * from tx_attempts where chain_id = $1 and from_addr = $2 and nonce = $3 and state = 'abandoned' order by id",
        [this.o.chainId, toBytes(this.address), nonce],
      )
    ).rows;
    // 1. any attempt of this nonce mined?
    for (const row of [...abandoned, ...group]) {
      const h = fromBytes(row.tx_hash)!;
      let rc;
      try {
        rc = await this.o.client.getTransactionReceipt({ hash: h });
      } catch (e) {
        // Only a definite "not found" means not mined; any other read error aborts this tick (Gate2 B2),
        // so a flaky RPC can never make us conclude "dropped".
        if ((e as { name?: string }).name !== "TransactionReceiptNotFoundError") throw e;
        rc = null;
      }
      if (rc) {
        await this.o.db.tx(async (t) => {
          await t.query("update tx_attempts set state = $2, updated_at = $3 where id = $1", [row.id, rc.status === "success" ? "mined" : "reverted", this.now()]);
          await t.query(
            "update tx_attempts set state = 'replaced', updated_at = $3 where chain_id = $1 and nonce = $2 and state = any($4::text[]) and from_addr = $5 and id <> $6",
            [this.o.chainId, nonce, this.now(), OPEN_STATES, toBytes(this.address), row.id],
          );
        });
        return {
          resolved: {
            txHash: h,
            eventKey: fromBytes(row.event_key),
            action: row.action,
            success: rc.status === "success",
            blockNumber: rc.blockNumber,
          },
        };
      }
    }
    // 2. nonce consumed by something we did not sign → dropped + alert.
    const latest = await this.o.client.getTransactionCount({ address: this.address, blockTag: "latest" });
    if (latest > nonce) {
      for (const row of group) await this.setState(row.id, "dropped");
      await this.o.alerts.emit({
        kind: "NONCE_MISMATCH",
        key: `${this.o.chainId}:${nonce}`,
        message: `chain ${this.o.chainId}: nonce ${nonce} consumed by an unknown tx; our attempts dropped`,
      });
      return {};
    }
    // 3. (re)broadcast: signed-but-unsent attempts, or on startup the newest attempt as-is.
    let rebroadcast = 0;
    const newest = group[group.length - 1]!;
    const stuck = this.now().getTime() - new Date(newest.created_at).getTime() >= this.o.cfg.stuckAfterMs;
    const willBroadcast = group.some((row) => row.state === "signed" || (opts.rebroadcastAll && row.id === newest.id));
    if ((willBroadcast || (stuck && !opts.rebroadcastAll)) && newest.event_key && newest.action !== "cancel" && this.guard) {
      // Gate2 r2 A-1: §6.4 "replay as-is" still holds, but only after the source order is re-checked.
      const verdict = await this.guard(fromBytes(newest.event_key)!);
      if (verdict === "unknown") return {};
      if (verdict === "mismatch") {
        await this.cancelNonce(group, nonce);
        return {};
      }
    }
    for (const row of group) {
      if (row.state === "signed" || (opts.rebroadcastAll && row.id === newest.id)) {
        const r = await this.broadcast(row);
        if (r.ok) rebroadcast++;
      }
    }
    if (opts.rebroadcastAll) return { rebroadcast };
    // 4. stuck → same-nonce fee bump.
    const age = this.now().getTime() - new Date(newest.created_at).getTime();
    if (age < this.o.cfg.stuckAfterMs) return { rebroadcast };
    const bumps = group.length - 1;
    if (!this.o.cfg.replaceByFee || bumps >= this.o.cfg.maxFeeBumps) {
      await this.o.alerts.emit({
        kind: "TX_STUCK",
        key: `${this.o.chainId}:${nonce}`,
        message: `chain ${this.o.chainId}: nonce ${nonce} pending for ${Math.round(age / 1000)}s (${bumps} bumps, replaceByFee=${this.o.cfg.replaceByFee}); manual handling required`,
      });
      return { rebroadcast };
    }
    await this.bump(newest);
    return { bumped: true, rebroadcast };
  }

  /**
   * Abandon a payout nonce whose source order is no longer intact: mark its attempts `abandoned` and
   * occupy the same nonce with a 0-value self-transfer priced above every attempt (replaces it if it is
   * already in a mempool; otherwise simply uses the nonce). If replacement is not supported by the node,
   * the original may still be mined — the post-payout safety net then raises PAYOUT_ALREADY_RELEASED.
   */
  private async cancelNonce(group: AttemptRow[], nonce: number): Promise<void> {
    const top = group.reduce((m, r) => (toBig(r.gas_price) > m ? toBig(r.gas_price) : m), 0n);
    let price = (top * BigInt(100 + this.o.cfg.feeBumpPercent)) / 100n + 1n;
    const market = await this.o.client.getGasPrice();
    if (market > price) price = market;
    const raw = await this.sign({ type: "legacy", chainId: this.o.chainId, nonce, to: this.address, data: "0x", gas: 21_000n, gasPrice: price, value: 0n });
    if (!raw) return; // KMS alerted; the guard runs again next tick, nothing is broadcast meanwhile
    const hash = keccak256(raw);
    const id = await this.o.db.tx(async (t) => {
      await t.query("update tx_attempts set state = 'abandoned', updated_at = $2 where id = any($1::bigint[])", [group.map((r) => r.id), this.now()]);
      const r = await t.query<{ id: string }>(
        `insert into tx_attempts (event_key, chain_id, nonce, tx_hash, gas_price, raw_tx, state, action, created_at, updated_at, from_addr)
         values (null,$1,$2,$3,$4,$5,'signed','cancel',$6,$6,$7) returning id`,
        [this.o.chainId, nonce, toBytes(hash), price.toString(), toBytes(raw), this.now(), toBytes(this.address)],
      );
      return r.rows[0]!.id;
    });
    await this.broadcast({ id, raw_tx: toBytes(raw), tx_hash: toBytes(hash) });
  }

  private async bump(prev: AttemptRow): Promise<void> {
    const parsed = parseTransaction(fromBytes(prev.raw_tx)!);
    const oldPrice = toBig(prev.gas_price);
    let price = (oldPrice * BigInt(100 + this.o.cfg.feeBumpPercent)) / 100n + 1n;
    const market = await this.o.client.getGasPrice();
    if (market > price) price = market;
    const tx: TransactionSerializableLegacy = {
      type: "legacy",
      chainId: this.o.chainId,
      nonce: Number(prev.nonce),
      to: parsed.to!,
      data: parsed.data ?? "0x",
      gas: parsed.gas!,
      gasPrice: price,
      value: 0n,
    };
    const raw = await this.sign(tx);
    if (!raw) return;
    const hash = keccak256(raw);
    const ins = await this.o.db.query<{ id: string }>(
      `insert into tx_attempts (event_key, chain_id, nonce, tx_hash, gas_price, raw_tx, state, action, created_at, updated_at, from_addr)
       values ($1,$2,$3,$4,$5,$6,'signed',$7,$8,$8,$9) returning id`,
      [prev.event_key, this.o.chainId, prev.nonce, toBytes(hash), price.toString(), toBytes(raw), prev.action, this.now(), toBytes(this.address)],
    );
    await this.broadcast({ id: ins.rows[0]!.id, raw_tx: toBytes(raw), tx_hash: toBytes(hash) });
  }

  private async sign(tx: TransactionSerializableLegacy): Promise<Hex | null> {
    try {
      return await this.o.signer.signTransaction(tx);
    } catch (e) {
      await this.o.alerts.emit({
        kind: "KMS_FAILURE",
        key: `${this.o.chainId}`,
        message: `chain ${this.o.chainId}: signer failed: ${errText(e)}`,
      });
      return null;
    }
  }

  /**
   * Simulate → sign → persist (same DB tx as `onSigned`, which links the order) → broadcast.
   * Returns `busy` while a previous tx of this key is unresolved.
   */
  async send(req: SendRequest, onSigned?: (t: Db, txHash: Hex) => Promise<void>): Promise<SendResult> {
    if (this.o.safety.sendsBlocked()) return { kind: "blocked" };
    if ((await this.openAttempts()).length > 0) return { kind: "busy" };
    if (this.nextNonce === null) await this.recover();
    const nonce = this.nextNonce!;
    let gas: bigint;
    try {
      await this.o.client.call({ account: this.address, to: req.to, data: req.data });
      gas = req.gas ?? ((await this.o.client.estimateGas({ account: this.address, to: req.to, data: req.data })) * 12n) / 10n;
    } catch (e) {
      const revert = decodeRevert(e);
      if (revert.errorName || revert.raw) return { kind: "sim-revert", revert };
      // No revert data: RPC/transport trouble (or an empty revert) — never classify it (Gate2 B2).
      await this.o.alerts.emit({
        kind: "RPC_UNAVAILABLE",
        key: `${this.o.chainId}:simulate`,
        message: `chain ${this.o.chainId}: simulation failed without revert data: ${errText(e)}`,
      });
      return { kind: "rpc-error", message: errText(e) };
    }
    const gasPrice = await this.o.client.getGasPrice();
    const raw = await this.sign({ type: "legacy", chainId: this.o.chainId, nonce, to: req.to, data: req.data, gas, gasPrice, value: 0n });
    if (!raw) return { kind: "signer-error", message: "signer failed" };
    const txHash = keccak256(raw);
    const ins = await this.o.db.tx(async (t) => {
      const r = await t.query<{ id: string }>(
        `insert into tx_attempts (event_key, chain_id, nonce, tx_hash, gas_price, raw_tx, state, action, created_at, updated_at, from_addr)
         values ($1,$2,$3,$4,$5,$6,'signed',$7,$8,$8,$9) returning id`,
        [req.eventKey ? toBytes(req.eventKey) : null, this.o.chainId, nonce, toBytes(txHash), gasPrice.toString(), toBytes(raw), req.action, this.now(), toBytes(this.address)],
      );
      if (onSigned) await onSigned(t, txHash);
      return r.rows[0]!;
    });
    this.nextNonce = nonce + 1;
    if (this.o.hooks?.afterSign) await this.o.hooks.afterSign(txHash);
    const b = await this.broadcast({ id: ins.id, raw_tx: toBytes(raw), tx_hash: toBytes(txHash) });
    if (!b.ok) return { kind: "broadcast-error", txHash, nonce, message: b.message ?? "" };
    return { kind: "sent", txHash, nonce };
  }

  async checkGas(): Promise<void> {
    if (this.o.minBalanceWei === undefined) return;
    const bal = await this.o.client.getBalance({ address: this.address });
    if (bal < this.o.minBalanceWei) {
      await this.o.alerts.emit({
        kind: "GAS_LOW",
        key: `${this.o.chainId}:${this.address}`,
        message: `chain ${this.o.chainId}: payout key ${this.address} gas balance ${bal} < ${this.o.minBalanceWei}`,
        data: { balance: bal.toString(), min: this.o.minBalanceWei.toString() },
      });
    }
  }
}
