import type { Address } from "viem";
import { type AppConfig, chainById } from "../config";

/** Thrown before any wallet request whose target is not one of the two bridges / two USDT tokens. */
export class TargetNotAllowedError extends Error {
  constructor(
    readonly chainId: number,
    readonly to: string | undefined,
  ) {
    super(`transaction target ${to ?? "(none)"} on chain ${chainId} is not an allowed bridge/USDT address`);
    this.name = "TargetNotAllowedError";
  }
}

export function allowedTargets(cfg: AppConfig): { chainId: number; address: Address }[] {
  return [cfg.wantos, cfg.bsc].flatMap((c) => [
    { chainId: c.id, address: c.bridge },
    { chainId: c.id, address: c.usdt },
  ]);
}

/** DESIGN §8.1: the only transaction targets are the bridge and USDT of the chain the transaction is sent on. */
export function assertAllowedTarget(cfg: AppConfig, chainId: number, to: string | undefined | null): asserts to is Address {
  const c = chainById(cfg, chainId);
  const t = to?.toLowerCase();
  if (!c || !t || (t !== c.bridge.toLowerCase() && t !== c.usdt.toLowerCase())) {
    throw new TargetNotAllowedError(chainId, to ?? undefined);
  }
}

/**
 * Function-level allow-list on top of the target check: USDT → only `approve(bridge, amount)`;
 * WANTOS bridge → only `bridgeOut`; BSC bridge → only `deposit`. A non-zero `value` (the native fee) is allowed only on the bridges.
 */
export function assertAllowedCall(cfg: AppConfig, chainId: number, to: string | undefined | null, functionName: string, args: readonly unknown[], value?: bigint): void {
  assertAllowedTarget(cfg, chainId, to);
  const c = chainById(cfg, chainId)!;
  const t = to!.toLowerCase();
  const ok =
    t === c.usdt.toLowerCase()
      ? functionName === "approve" && typeof args[0] === "string" && args[0].toLowerCase() === c.bridge.toLowerCase()
      : chainId === cfg.wantos.id
        ? functionName === "bridgeOut"
        : functionName === "deposit";
  // native coin only goes to the bridge entry points (the fee), never to a token contract
  if (!ok || (value !== undefined && value > 0n && t === c.usdt.toLowerCase())) throw new TargetNotAllowedError(chainId, to ?? undefined);
}
