import type { PublicClient } from "viem";
import { errText } from "./redact.js";
import type { ChainName } from "./types.js";

export const stableStringify = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => {
    if (typeof x === "bigint") return `${x.toString()}n`;
    if (x !== null && typeof x === "object" && !Array.isArray(x)) {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return x;
  });

const DISSENT_WINDOW = 20;

export interface RpcEndpoint {
  label: string;
  client: PublicClient;
}

export type Consensus<T> =
  | { ok: true; value: T; agree: number }
  | { ok: false; reason: "disagree" | "insufficient"; answers: Array<{ label: string; value?: string; error?: string }> };

/**
 * A set of independent RPC endpoints for one chain.
 * `consensus` implements DESIGN §9.1 condition ②: a result is usable only if at least `minAgree`
 * endpoints returned the same value AND no endpoint returned a different value (errors are ignored).
 */
export class MultiRpc {
  constructor(
    readonly chain: ChainName,
    readonly endpoints: RpcEndpoint[],
    readonly minAgree: number,
  ) {}

  /**
   * r3 compromise / r4: per-RPC dissent tracked over a sliding window of the last DISSENT_WINDOW
   * recorded outcomes (no automatic eviction). Errors, null / empty answers are NEUTRAL (not recorded),
   * so a stalled node that keeps "agreeing" on nothing cannot hide its dissent. `count` = dissents in window.
   */
  readonly dissent = new Map<string, { count: number; last: string }>();
  private readonly history = new Map<string, boolean[]>();

  private record(label: string, dissent: boolean, what?: string): void {
    const h = this.history.get(label) ?? [];
    h.push(dissent);
    if (h.length > DISSENT_WINDOW) h.splice(0, h.length - DISSENT_WINDOW);
    this.history.set(label, h);
    const prev = this.dissent.get(label);
    this.dissent.set(label, { count: h.filter(Boolean).length, last: dissent && what ? what : (prev?.last ?? "") });
  }

  noteDissent(label: string, what: string): void {
    this.record(label, true, what);
  }

  noteAgree(label: string): void {
    this.record(label, false);
  }

  /** B5: remove a misconfigured endpoint (wrong chain / disagreeing static data). */
  drop(label: string): void {
    const i = this.endpoints.findIndex((e) => e.label === label);
    if (i >= 0) this.endpoints.splice(i, 1);
  }

  async primary<T>(fn: (c: PublicClient) => Promise<T>): Promise<T> {
    const errors: string[] = [];
    for (const e of this.endpoints) {
      try {
        return await fn(e.client);
      } catch (err) {
        errors.push(`${e.label}: ${errText(err)}`);
      }
    }
    throw new Error(`${this.chain}: all ${this.endpoints.length} RPCs failed: ${errors.join("; ")}`);
  }

  /** Run on every endpoint; returns successes (with labels) and failures. */
  async all<T>(fn: (c: PublicClient, label: string) => Promise<T>): Promise<{ ok: Array<{ label: string; value: T }>; failed: Array<{ label: string; error: string }> }> {
    const settled = await Promise.allSettled(this.endpoints.map((e) => fn(e.client, e.label)));
    const ok: Array<{ label: string; value: T }> = [];
    const failed: Array<{ label: string; error: string }> = [];
    settled.forEach((s, i) => {
      const label = this.endpoints[i]!.label;
      if (s.status === "fulfilled") ok.push({ label, value: s.value });
      else failed.push({ label, error: errText(s.reason) });
    });
    return { ok, failed };
  }

  async consensus<T>(fn: (c: PublicClient, label: string) => Promise<T>, what = "consensus read"): Promise<Consensus<T>> {
    const settled = await Promise.allSettled(this.endpoints.map((e) => fn(e.client, e.label)));
    const groups = new Map<string, { value: T; n: number }>();
    const answers: Array<{ label: string; value?: string; error?: string }> = [];
    settled.forEach((s, i) => {
      const label = this.endpoints[i]!.label;
      if (s.status === "fulfilled") {
        const k = stableStringify(s.value);
        const g = groups.get(k);
        if (g) g.n++;
        else groups.set(k, { value: s.value, n: 1 });
        answers.push({ label, value: k });
      } else {
        answers.push({ label, error: errText(s.reason) });
      }
    });
    if (groups.size > 1) {
      const top = Math.max(...[...groups.values()].map((g) => g.n));
      const winners = [...groups.entries()].filter(([, g]) => g.n === top);
      const majority = winners.length === 1 ? winners[0]![0] : null; // a tie has no majority: everyone dissents
      for (const a of answers) {
        if (a.value === undefined) continue; // errors are neutral
        if (a.value !== majority) this.noteDissent(a.label, what);
        else if (a.value !== "null") this.noteAgree(a.label);
      }
      return { ok: false, reason: "disagree", answers };
    }
    for (const a of answers) if (a.value !== undefined && a.value !== "null") this.noteAgree(a.label);
    const only = [...groups.values()][0];
    if (only && only.n >= this.minAgree) return { ok: true, value: only.value, agree: only.n };
    return { ok: false, reason: "insufficient", answers };
  }
}
