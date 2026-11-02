import { getAddress, isAddress } from "viem";
import type { Address } from "@bridge/relayer/src/types";

/** A UniswapV2-style pair under the WANTOS factory. `usdtIndex` = which side is USDT (null: no USDT side). */
export interface PairInfo {
  address: Address;
  usdtIndex: 0 | 1 | null;
}

/**
 * DESIGN §7 thresholds. Defaults are the spec targets; they are to be calibrated with the October
 * replay before PR-9 (PR4-NOTES §6). Amounts are token base units.
 */
export interface RiskParams {
  /** Look-back window for inflows (§7: 30 days). */
  lookbackMs: number;
  /** Ratio thresholds in basis points: ≥ freezeBps → REVIEW(freeze); ≥ auditBps → REVIEW(audit). */
  freezeBps: number;
  auditBps: number;
  /** Fresh-funds rule: bridging out ≥ freshMinAmount within freshWindowMs of the first receipt → REVIEW(audit). */
  freshWindowMs: number;
  freshMinAmount: bigint;
  /** Common-funder rule: one source funded ≥ funderMinAddrs addresses that bridge out within funderWindowMs. */
  funderWindowMs: number;
  funderMinAddrs: number;
  /**
   * Minimum amount (base units, per asset symbol: "USDT", "NATIVE", "MG", …) for a movement to count as
   * "funding" in the common-funder rule and as a "receipt" in the fresh-funds rule. Assets without an
   * entry never count. Stops 0-amount / dust griefing (anyone can transferFrom(x, u, 0)).
   */
  funderMinAmount: Record<string, bigint>;
  /** Index health: stale after this long without a successful indexer tick, or this many blocks behind head. */
  indexStaleMs: number;
  indexMaxLagBlocks: number;
}

export interface RiskConfig {
  usdt: Address;
  /** Other tokens whose Transfer events are indexed (MG, TIDE). */
  otherTokens: { symbol: string; address: Address }[];
  pairs: PairInfo[];
  /** WANTOS bridge (B2W payouts come from it; bridge-outs go to it). */
  bridge: Address;
  /** Sources never traced through (hop 2) and never counted as a "common funder": exchanges, distributors… */
  exempt: Address[];
  params: RiskParams;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export function defaultParams(usdtDecimals = 18): RiskParams {
  return {
    lookbackMs: 30 * DAY,
    freezeBps: 2000,
    auditBps: 500,
    freshWindowMs: 10 * MIN,
    freshMinAmount: 500n * 10n ** BigInt(usdtDecimals),
    funderWindowMs: DAY,
    funderMinAddrs: 3,
    // 1 USDT; 1 native coin (conservative placeholder). Calibrate with the October replay (PR4-NOTES §6).
    funderMinAmount: { USDT: 10n ** BigInt(usdtDecimals), NATIVE: 10n ** 18n },
    indexStaleMs: 2 * MIN,
    indexMaxLagBlocks: 600,
  };
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/** Validates and normalises a config; throws on anything ambiguous. */
export function parseRiskConfig(c: RiskConfig): RiskConfig {
  const a = (x: string, what: string): Address => {
    if (!isAddress(x, { strict: false })) throw new Error(`risk config: ${what} is not an address`);
    return getAddress(x);
  };
  const p = c.params;
  if (!(p.auditBps > 0 && p.auditBps <= p.freezeBps && p.freezeBps <= 10_000)) throw new Error("risk config: need 0 < auditBps ≤ freezeBps ≤ 10000");
  if (p.lookbackMs <= 0 || p.freshWindowMs < 0 || p.funderWindowMs <= 0) throw new Error("risk config: windows must be positive");
  if (p.funderMinAddrs < 2) throw new Error("risk config: funderMinAddrs must be ≥ 2");
  if (p.freshMinAmount < 0n) throw new Error("risk config: freshMinAmount must be ≥ 0");
  for (const [k, v] of Object.entries(p.funderMinAmount)) if (!(v > 0n)) throw new Error(`risk config: funderMinAmount.${k} must be > 0`);
  if (p.indexStaleMs <= 0 || p.indexMaxLagBlocks <= 0) throw new Error("risk config: index health limits must be positive");
  if (c.pairs.length === 0) throw new Error("risk config: pairs must not be empty");
  const pairs = c.pairs.map((x) => ({ address: a(x.address, "pair"), usdtIndex: x.usdtIndex }));
  if (new Set(pairs.map((x) => x.address)).size !== pairs.length) throw new Error("risk config: duplicate pair");
  return {
    usdt: a(c.usdt, "usdt"),
    otherTokens: c.otherTokens.map((t) => ({ symbol: t.symbol, address: a(t.address, t.symbol) })),
    pairs,
    bridge: a(c.bridge, "bridge"),
    exempt: c.exempt.map((x) => a(x, "exempt")),
    params: { ...p, funderMinAmount: { ...p.funderMinAmount } },
  };
}
