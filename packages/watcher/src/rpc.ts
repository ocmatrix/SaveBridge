import type { PublicClient } from "viem";
import type { ChainName } from "./types.js";

export const stableStringify = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => {
    if (typeof x === "bigint") return `${x.toString()}n`;
    if (x !== null && typeof x === "object" && !Array.isArray(x)) {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return x;
  });

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

  async primary<T>(fn: (c: PublicClient) => Promise<T>): Promise<T> {
    const errors: string[] = [];
    for (const e of this.endpoints) {
      try {
        return await fn(e.client);
      } catch (err) {
        errors.push(`${e.label}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
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
      else failed.push({ label, error: s.reason instanceof Error ? s.reason.message.split("\n")[0]! : String(s.reason) });
    });
    return { ok, failed };
  }

  async consensus<T>(fn: (c: PublicClient, label: string) => Promise<T>): Promise<Consensus<T>> {
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
        const reason: unknown = s.reason;
        answers.push({ label, error: reason instanceof Error ? reason.message.split("\n")[0]! : String(reason) });
      }
    });
    if (groups.size > 1) return { ok: false, reason: "disagree", answers };
    const only = [...groups.values()][0];
    if (only && only.n >= this.minAgree) return { ok: true, value: only.value, agree: only.n };
    return { ok: false, reason: "insufficient", answers };
  }
}
