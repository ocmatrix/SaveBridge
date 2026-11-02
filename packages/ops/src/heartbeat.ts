/**
 * External dead-man switch ping (healthchecks.io-style: an HTTPS URL that must be hit at least every
 * N minutes; the external service calls / texts the owner when pings stop). The URL is a secret
 * (anyone holding it can fake liveness) → it comes from a systemd credential, never from config/logs.
 */
import { redact } from "./redact.js";

export class HttpHeartbeat {
  private last = -Infinity;
  constructor(
    private readonly o: { url: string; minIntervalMs: number; fetch?: typeof fetch; now?: () => number; timeoutMs?: number },
  ) {
    let u: URL;
    try {
      u = new URL(o.url);
    } catch {
      throw new Error("heartbeat: URL is invalid (value not shown)");
    }
    if (u.protocol !== "https:") throw new Error("heartbeat: URL must be https");
  }

  /** Returns true when a ping was actually sent (throttled to one per `minIntervalMs`). Throws (redacted) on failure. */
  async ping(): Promise<boolean> {
    const t = (this.o.now ?? Date.now)();
    if (t - this.last < this.o.minIntervalMs) return false;
    let res: Response;
    try {
      res = await (this.o.fetch ?? fetch)(this.o.url, { method: "GET", signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000) });
    } catch (e) {
      throw new Error(`heartbeat ping failed: ${redact(e instanceof Error ? e.message : String(e), [this.o.url])}`);
    }
    if (!res.ok) throw new Error(`heartbeat ping failed: HTTP ${res.status}`);
    this.last = t;
    return true;
  }
}
