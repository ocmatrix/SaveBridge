import { formatUnits } from "viem";
import type { I18nKey } from "../i18n/zh";

export interface Problem {
  key: I18nKey;
  params?: Record<string, string>;
}

export type ParseResult = { ok: true; value: bigint } | { ok: false; error: Problem };

/** Parses a plain decimal string ("12.5") into token base units; no exponents, signs or separators. */
export function parseAmountInput(input: string, decimals: number): ParseResult {
  const s = input.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return { ok: false, error: { key: "amount.invalid" } };
  const frac = m[2] ?? "";
  if (frac.length > decimals) return { ok: false, error: { key: "amount.tooManyDecimals", params: { decimals: String(decimals) } } };
  const value = BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (value === 0n) return { ok: false, error: { key: "amount.invalid" } };
  return { ok: true, value };
}

/** Grouped, truncated (never rounded up) to 6 fractional digits. */
export function formatAmount(v: bigint, decimals: number): string {
  if (v === 0n) return "0";
  const keep = Math.min(decimals, 6);
  const unit = 10n ** BigInt(decimals - keep);
  const truncated = (v / unit) * unit;
  if (truncated === 0n) return `<0.${"0".repeat(keep - 1)}1`;
  const [i, f = ""] = formatUnits(truncated, decimals).split(".");
  const grouped = i!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fr = f.slice(0, keep).replace(/0+$/, "");
  return fr ? `${grouped}.${fr}` : grouped;
}

export interface W2BCheck {
  amount: bigint;
  min: bigint;
  perAddrCap: bigint;
  addrRemaining: bigint;
  balance: bigint;
  decimals: number;
}

/** Mirrors bridgeOut's on-chain checks (DESIGN §5.3) so the user sees the reason before signing. */
export function validateW2B(c: W2BCheck): Problem | null {
  const f = (x: bigint) => formatAmount(x, c.decimals);
  if (c.addrRemaining < c.min) return { key: "quota.exhausted" };
  if (c.amount < c.min) return { key: "amount.belowMin", params: { min: f(c.min) } };
  if (c.amount > c.perAddrCap) return { key: "amount.aboveMax", params: { max: f(c.perAddrCap) } };
  if (c.amount > c.addrRemaining) return { key: "amount.aboveRemaining", params: { remaining: f(c.addrRemaining) } };
  if (c.amount > c.balance) return { key: "amount.aboveBalance" };
  return null;
}

export interface B2WCheck {
  amount: bigint;
  minDeposit: bigint;
  maxDepositPerTx: bigint;
  /** WANTOS b2wDailyCap - dailyUsed(today): a deposit above this is refunded instead of credited (§5.3). */
  b2wRemaining: bigint;
  balance: bigint;
  decimals: number;
}

export function validateB2W(c: B2WCheck): Problem | null {
  const f = (x: bigint) => formatAmount(x, c.decimals);
  if (c.b2wRemaining < c.minDeposit) return { key: "quota.exhausted" };
  if (c.amount < c.minDeposit) return { key: "amount.belowMin", params: { min: f(c.minDeposit) } };
  if (c.amount > c.maxDepositPerTx) return { key: "amount.aboveMax", params: { max: f(c.maxDepositPerTx) } };
  if (c.amount > c.b2wRemaining) return { key: "amount.aboveRemaining", params: { remaining: f(c.b2wRemaining) } };
  if (c.amount > c.balance) return { key: "amount.aboveBalance" };
  return null;
}
