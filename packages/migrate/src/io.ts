import type { LegacySourceData, OldPayout, SourceOrder } from "./types.js";

export interface SourceFile extends LegacySourceData {
  cutoverT?: number;
}

/** Parses an offline source JSON ({ cutoverT?, orders[], payouts[] }); field-level checks happen in the scanner. */
export function parseSourceJson(text: string): SourceFile {
  const j = JSON.parse(text) as Record<string, unknown>;
  if (typeof j !== "object" || j === null || !Array.isArray(j["orders"]) || !Array.isArray(j["payouts"])) throw new Error("source JSON needs orders[] and payouts[]");
  const out: SourceFile = { orders: j["orders"] as SourceOrder[], payouts: j["payouts"] as OldPayout[] };
  if (j["cutoverT"] !== undefined) out.cutoverT = Number(j["cutoverT"]);
  return out;
}
