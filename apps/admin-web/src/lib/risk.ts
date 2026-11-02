import type { AddressInfo } from "./api";

/**
 * Reference hints on the whitelist page (DESIGN §8.2, as narrowed by the v0.9.5 scope change: risk control relies on
 * the whitelist only — no controlled-source / source-hit flags). Hints never block or pre-select anything.
 * 🟡 not in the referral network (from the relayer's address-info; unknown → no flag); ⚪ contract address (getCode).
 */
export type Flag = "yellow" | "white";
export const FLAG_ICON: Record<Flag, string> = { yellow: "🟡", white: "⚪" };
export const FLAG_TEXT: Record<Flag, string> = { yellow: "不在网体内", white: "合约地址" };

export function flagsFor(o: { info?: AddressInfo; isContract: boolean }): Flag[] {
  const f: Flag[] = [];
  if (o.info?.inNetwork === false) f.push("yellow");
  if (o.isContract) f.push("white");
  return f;
}
