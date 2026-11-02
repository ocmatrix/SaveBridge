import type { AlertSink } from "./alerts";
import type { ChainSide } from "./types";

export interface ReorgInfo {
  block: bigint;
  storedHash: string;
  observedHash: string;
}
export type ReorgListener = (side: ChainSide, info: ReorgInfo) => void;

/**
 * Process-wide safety switches. A detected reorg halts ingestion of that chain and blocks every
 * transaction submission (both chains) until an operator clears it. The relayer holds no PAUSER
 * key: it only exposes `onReorg` so the monitor (PR-7) / ops tooling can pause the bridge
 * (DESIGN §6.2 / §9.1 "WANTOS 区块 hash 变化 → 暂停两条链").
 */
export class SafetyState {
  private readonly halts = new Map<ChainSide, string>();
  private readonly listeners: ReorgListener[] = [];

  constructor(private readonly alerts: AlertSink) {}

  onReorg(l: ReorgListener): void {
    this.listeners.push(l);
  }

  async reportReorg(side: ChainSide, info: ReorgInfo): Promise<void> {
    if (this.halts.has(side)) return;
    this.halts.set(side, `reorg at ${info.block}`);
    await this.alerts.emit({
      kind: side === "wantos" ? "WANTOS_REORG" : "BSC_REORG",
      key: `${side}:${info.block}`,
      message: `${side} block ${info.block} hash changed (${info.storedHash} -> ${info.observedHash}); relayer halted, pause recommended`,
      data: { block: info.block.toString(), storedHash: info.storedHash, observedHash: info.observedHash },
    });
    for (const l of this.listeners) {
      try {
        l(side, info);
      } catch {
        /* listener failures must not break the halt */
      }
    }
  }

  halt(side: ChainSide, why: string): void {
    this.halts.set(side, why);
  }

  isHalted(side: ChainSide): boolean {
    return this.halts.has(side);
  }

  /** True when any chain is halted: the sender refuses to submit anything. */
  sendsBlocked(): boolean {
    return this.halts.size > 0;
  }

  /** Operator action, after the cursor has been rewound with CursorRepo.rewind. */
  clear(side: ChainSide): void {
    this.halts.delete(side);
  }
}
