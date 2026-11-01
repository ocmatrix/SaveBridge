import type { ChainName } from "./types.js";

export interface HeartbeatStatus {
  at: number;
  cursors: Record<ChainName, string | null>;
  pendingChecks: number;
}

/**
 * External dead-man switch (DESIGN §9): the watcher reports every 5 minutes; if reports stop, the
 * EXTERNAL service phones / texts the owner. PR-7 ships only the interface + test doubles.
 */
export interface Heartbeat {
  beat(status: HeartbeatStatus): Promise<void>;
}

export class MemoryHeartbeat implements Heartbeat {
  readonly beats: HeartbeatStatus[] = [];
  failNext = 0;
  async beat(status: HeartbeatStatus): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("heartbeat endpoint unreachable");
    }
    this.beats.push(status);
  }
}

/** DRAFT ONLY: shows the request a push-style heartbeat (healthchecks-like) would get; never sends. */
export class HttpHeartbeatDraft implements Heartbeat {
  constructor(private readonly opts: { pingUrlRef: string }) {}
  buildRequest(status: HeartbeatStatus): { method: "POST"; url: string; body: string } {
    return { method: "POST", url: `<${this.opts.pingUrlRef}>`, body: JSON.stringify(status) };
  }
  async beat(_status: HeartbeatStatus): Promise<void> {
    throw new Error("HttpHeartbeatDraft is a draft: sending is not wired in PR-7");
  }
}

/** Optional liveness probe for the relayer (server A), e.g. its health endpoint. Interface only. */
export interface RelayerProbe {
  isAlive(): Promise<boolean>;
}
