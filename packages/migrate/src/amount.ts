/** BSC-USDT (and the new vault) use 18 decimals. */
export const PAYOUT_DECIMALS = 18;

const DEC = /^(0|[1-9]\d*)(\.\d+)?$/;

/**
 * Strict decimal -> integer units. No rounding: more fractional digits than `decimals`
 * (other than trailing zeros) is an error, as are signs, exponents and blanks.
 */
export function parseAmount(s: string, decimals: number = PAYOUT_DECIMALS): bigint {
  if (typeof s !== "string" || !DEC.test(s)) throw new Error(`bad amount "${String(s)}"`);
  const [int, fracRaw = ""] = s.split(".");
  const frac = fracRaw.replace(/0+$/, "");
  if (frac.length > decimals) throw new Error(`amount "${s}" has more than ${decimals} decimals`);
  return BigInt(int!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Integer units -> plain decimal string without trailing zeros. */
export function formatAmount(v: bigint, decimals: number = PAYOUT_DECIMALS): string {
  if (v < 0n) throw new Error("negative amount");
  const base = 10n ** BigInt(decimals);
  const int = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int.toString();
}
