import type { Hex } from "viem";
import { send, type ChainCtx, type Chains, type Signer } from "./chain";

export type ReviewDecision = "approve" | "reject";
export const MAX_DECISION_TTL_S = 24n * 3600n;
/** Default validity of a signed decision (well inside the relayer's 24h limit). */
export const DECISION_TTL_S = 3600n;

/**
 * EXACT text the relayer verifies (packages/relayer/src/review.ts `reviewMessage`, PR3-NOTES §4.2) — re-implemented here
 * (independent project) and pinned by a test against the relayer's own function. EIP-191 personal_sign by the ADMIN wallet.
 * `chainId` = payout chain (W2B → BSC, B2W → WANTOS).
 */
export function reviewMessage(a: { chainId: number; eventKey: Hex; decision: ReviewDecision; expires: bigint }): string {
  return [
    "WANTOS-BSC-BRIDGE-V2 review decision",
    `chainId: ${a.chainId}`,
    `eventKey: ${a.eventKey.toLowerCase()}`,
    `decision: ${a.decision}`,
    `expires: ${a.expires}`,
  ].join("\n");
}

export const payoutSide = (direction: "W2B" | "B2W"): "bsc" | "wantos" => (direction === "W2B" ? "bsc" : "wantos");

export async function signDecision(
  chains: Chains,
  signer: Signer,
  o: { direction: "W2B" | "B2W"; eventKey: Hex; decision: ReviewDecision; nowSec: bigint; ttl?: bigint },
): Promise<{ eventKey: Hex; decision: ReviewDecision; expires: bigint; signature: Hex; message: string }> {
  const ttl = o.ttl ?? DECISION_TTL_S;
  if (ttl <= 0n || ttl > MAX_DECISION_TTL_S) throw new Error("有效期必须在 24 小时内");
  const chainId = chains[payoutSide(o.direction)].cfg.chainId;
  const expires = o.nowSec + ttl;
  const message = reviewMessage({ chainId, eventKey: o.eventKey, decision: o.decision, expires });
  return { eventKey: o.eventKey, decision: o.decision, expires, signature: await signer.signMessage(message), message };
}

/** Batch void on BSC (admin or WL; §12 "批量作废 1 次"). */
export function voidSourceBatch(bsc: ChainCtx, signer: Signer, orderIds: bigint[]): Promise<Hex> {
  return send(bsc, signer, { address: bsc.cfg.bridge, abi: bsc.bridgeAbi, functionName: "voidSourceBatch", args: [orderIds] });
}

/** Batch refund request on WANTOS (admin; executable by anyone 24h later). */
export function requestRefundBatch(wantos: ChainCtx, signer: Signer, orderIds: bigint[]): Promise<Hex> {
  return send(wantos, signer, { address: wantos.cfg.bridge, abi: wantos.bridgeAbi, functionName: "requestRefundBatch", args: [orderIds] });
}

/** "1, 2, 5-7" → [1n,2n,5n,6n,7n]; rejects junk and ranges over 500. */
export function parseIds(text: string): bigint[] {
  const out = new Set<bigint>();
  for (const part of text.split(/[\s,，]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`无法识别：${part}`);
    const a = BigInt(m[1]!);
    const b = m[2] ? BigInt(m[2]) : a;
    if (a === 0n || b < a || b - a > 500n) throw new Error(`范围无效：${part}`);
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => (x < y ? -1 : 1));
}
