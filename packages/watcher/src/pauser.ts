import { getAddress, isAddress, type Address, type Hex } from "viem";
import { redact } from "./redact.js";
import type { ChainName } from "./types.js";


/** `pause()` — the ONLY call the PAUSER key may ever make (DESIGN §4.1, §9). */
export const PAUSE_SELECTOR = "0x8456cb59" as const;
/** OZ `EnforcedPause()`: `pause()` on an already-paused bridge reverts with it (PR1-NOTES §5.11a-3). */
export const ENFORCED_PAUSE_SELECTOR = "0xd93c0665" as const;

export class PauseGuardError extends Error {
  constructor(msg: string) {
    super(`PAUSER guard: ${msg}`);
    this.name = "PauseGuardError";
  }
}

declare const pauseCallBrand: unique symbol;
/** A value of this type can only be produced by `pauseCall()`: `{ to: bridge, data: pause() }`, nothing else. */
export type PauseCall = { readonly to: Address; readonly data: typeof PAUSE_SELECTOR; readonly [pauseCallBrand]: true };

export function pauseCall(bridge: Address): PauseCall {
  if (!isAddress(bridge)) throw new PauseGuardError(`bad bridge address ${bridge}`);
  return Object.freeze({ to: getAddress(bridge), data: PAUSE_SELECTOR }) as PauseCall;
}

/** Runtime enforcement (defence in depth against casts): exact selector, no args, no value, configured target. */
export function assertPauseOnly(tx: { to: Address; data: Hex; value?: bigint }, allowedTargets: readonly Address[]): void {
  const keys = Object.keys(tx).filter((k) => k !== "to" && k !== "data");
  if (keys.length > 0) throw new PauseGuardError(`unexpected fields ${keys.join(",")}`);
  if (typeof tx.data !== "string" || tx.data.toLowerCase() !== PAUSE_SELECTOR)
    throw new PauseGuardError(`calldata ${String(tx.data)} is not exactly pause()`);
  if (!isAddress(tx.to) || !allowedTargets.some((a) => a.toLowerCase() === tx.to.toLowerCase()))
    throw new PauseGuardError(`target ${String(tx.to)} is not a configured bridge`);
}

/**
 * Adapter to whatever holds the PAUSER key (KMS / HSM / local key in tests). The watcher never sees
 * key material. Implementations must only be reachable through `PauseOnlySigner`.
 */
export interface RawTxSender {
  readonly address: Address;
  send(tx: { to: Address; data: Hex }): Promise<Hex>;
}

/** The only signer type the watcher holds. It can send `pause()` to the configured bridge(s) and nothing else. */
export class PauseOnlySigner {
  private readonly allowed: readonly Address[];
  constructor(
    private readonly inner: RawTxSender,
    allowedBridges: readonly Address[],
  ) {
    this.allowed = allowedBridges.map((a) => getAddress(a));
  }
  get address(): Address {
    return this.inner.address;
  }
  async sendPause(call: PauseCall): Promise<Hex> {
    assertPauseOnly(call, this.allowed);
    return this.inner.send({ to: call.to, data: PAUSE_SELECTOR });
  }
}

export interface PauseChainReader {
  /**
   * `paused()` as agreed by ≥ minRpcAgreement RPCs: `true` / `false`, or `null` when the RPCs do not
   * agree or not enough answered. Only an agreed `true` ever counts as "paused" (GATE2 A2).
   */
  paused(): Promise<boolean | null>;
  waitReceipt(hash: Hex): Promise<"success" | "reverted">;
}

export function isEnforcedPause(err: unknown, depth = 0): boolean {
  if (err === null || err === undefined || depth > 8) return false;
  if (typeof err === "string") return err.toLowerCase().includes(ENFORCED_PAUSE_SELECTOR.slice(2)) || err.includes("EnforcedPause");
  if (typeof err !== "object") return false;
  const o = err as Record<string, unknown>;
  for (const k of ["message", "shortMessage", "details", "data", "reason"]) {
    if (typeof o[k] === "string" && isEnforcedPause(o[k], depth + 1)) return true;
    if (k === "data" && typeof o[k] === "object" && isEnforcedPause(o[k], depth + 1)) return true;
  }
  if (typeof o["errorName"] === "string" && o["errorName"] === "EnforcedPause") return true;
  return isEnforcedPause(o["cause"], depth + 1);
}

export interface PauseOutcome {
  ok: boolean;
  status: "already-paused" | "paused" | "failed";
  attempts: number;
  txHash?: Hex;
  error?: string;
  /** B2: our own pause tx was mined; waiting for a second RPC to confirm paused()==true. */
  ownTxMined?: boolean;
}

export class PauseExecutor {
  constructor(
    private readonly signers: Record<ChainName, PauseOnlySigner>,
    private readonly readers: Record<ChainName, PauseChainReader>,
    private readonly bridges: Record<ChainName, Address>,
    private readonly opts: { attempts: number; backoffMs: number; sleep?: (ms: number) => Promise<void>; now?: () => number; minedCooldownMs?: number },
  ) {}

  /** B2: per chain, when our last pause tx was mined (in-memory; a restart re-sends at most once). */
  private readonly mined: Partial<Record<ChainName, { at: number; txHash: Hex }>> = {};

  /**
   * Idempotent. Every success path — already paused, our tx mined, or an `EnforcedPause` revert — is
   * accepted only after ≥2 RPCs agree `paused() == true`; otherwise retry and finally report failure.
   */
  async pause(chain: ChainName): Promise<PauseOutcome> {
    const reader = this.readers[chain];
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = this.opts.now ?? (() => Date.now());
    const cooldown = this.opts.minedCooldownMs ?? 60_000;
    let lastErr = "";
    let lastTx: Hex | undefined;
    for (let attempt = 1; attempt <= this.opts.attempts; attempt++) {
      let txHash: Hex | undefined;
      let mined = false;
      try {
        if ((await reader.paused()) === true) {
          delete this.mined[chain];
          return { ok: true, status: "already-paused", attempts: attempt };
        }
        const prev = this.mined[chain];
        if (prev && now() - prev.at < cooldown) {
          // B2: our pause is already on chain; only re-read, do not re-send while a second RPC catches up
          return { ok: false, status: "failed", attempts: attempt, txHash: prev.txHash, ownTxMined: true, error: "own pause tx mined; waiting for ≥2 RPCs to confirm paused()==true" };
        }
        try {
          txHash = await this.signers[chain].sendPause(pauseCall(this.bridges[chain]));
          lastTx = txHash;
          mined = (await reader.waitReceipt(txHash)) === "success";
        } catch (e) {
          if (e instanceof PauseGuardError) throw e;
          if (!isEnforcedPause(e)) throw e;
          // EnforcedPause claimed — only believed if the RPCs confirm below
        }
        if ((await reader.paused()) === true) {
          delete this.mined[chain];
          return { ok: true, status: mined ? "paused" : "already-paused", attempts: attempt, ...(txHash ? { txHash } : {}) };
        }
        if (mined) this.mined[chain] = { at: now(), txHash: txHash! };
        if (mined) return { ok: false, status: "failed", attempts: attempt, txHash: txHash!, ownTxMined: true, error: "own pause tx mined; waiting for ≥2 RPCs to confirm paused()==true" };
        lastErr = txHash ? `pause tx ${txHash} failed and paused()==true not confirmed by ≥2 RPCs` : "EnforcedPause reported but paused()==true not confirmed by ≥2 RPCs";
      } catch (e) {
        if (e instanceof PauseGuardError) throw e;
        lastErr = redact(e instanceof Error ? e.message : String(e));
      }
      if (attempt < this.opts.attempts) await sleep(this.opts.backoffMs * attempt);
    }
    return { ok: false, status: "failed", attempts: this.opts.attempts, error: lastErr, ...(lastTx ? { txHash: lastTx } : {}) };
  }
}
