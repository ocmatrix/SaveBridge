import type { AlertSink } from "./alerts";

/** External heartbeat endpoint (e.g. a dead-man's-switch service). Interface only in PR-3. */
export interface HeartbeatSink {
  ping(info: { at: Date; detail?: Record<string, unknown> }): Promise<void>;
}

export class MemoryHeartbeatSink implements HeartbeatSink {
  readonly pings: Date[] = [];
  async ping(info: { at: Date }): Promise<void> {
    this.pings.push(info.at);
  }
}

/**
 * Relayer liveness (§6.5 / §9.3 "心跳中断"): the main loop calls `beat()` every tick; `watch()`
 * (run on an independent timer) alerts when the loop has not beaten for `staleAfterMs`. The
 * external sink covers the case where the whole process is gone (the outside service alerts).
 */
export class Heartbeat {
  private last: number;
  private alerted = false;
  constructor(
    private readonly o: { alerts: AlertSink; sink?: HeartbeatSink; staleAfterMs: number; now: () => Date },
  ) {
    this.last = o.now().getTime();
  }

  async beat(detail?: Record<string, unknown>): Promise<void> {
    this.last = this.o.now().getTime();
    this.alerted = false;
    if (this.o.sink) {
      try {
        await this.o.sink.ping({ at: this.o.now(), detail });
      } catch {
        /* the external service alerts on missing pings by itself */
      }
    }
  }

  async watch(): Promise<boolean> {
    const age = this.o.now().getTime() - this.last;
    if (age < this.o.staleAfterMs || this.alerted) return false;
    this.alerted = true;
    await this.o.alerts.emit({ kind: "HEARTBEAT_MISSED", message: `relayer main loop silent for ${Math.round(age / 1000)}s` });
    return true;
  }
}
