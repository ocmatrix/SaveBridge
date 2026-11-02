import { getAddress, isAddress, keccak256, stringToBytes, zeroAddress, type Address, type Hex } from "viem";
import { formatAmount } from "./amount.js";
import { OLD_KEY_ENCODING, isTxHash, oldKey } from "./oldkey.js";
import { compareSrc } from "./scan.js";
import type { Direction, Manifest, ManifestEntry, ManifestHeader, ScanEntry } from "./types.js";

export const MANIFEST_TITLE = "# wantos-bridge-v2 legacy payout manifest v1";
export const CSV_COLUMNS = "oldKey,srcChainId,srcTxHash,srcLogIndex,direction,to,amountWei,amount";

export function manifestHash(csv: string): Hex {
  return keccak256(stringToBytes(csv));
}

function renderCsv(h: ManifestHeader, entries: ManifestEntry[]): string {
  const total = entries.reduce((s, e) => s + e.amount, 0n);
  const lines = [
    MANIFEST_TITLE,
    `# bscChainId=${h.bscChainId}`,
    `# vault=${getAddress(h.vault)}`,
    `# cutoverT=${h.cutoverT}`,
    `# oldKey=${OLD_KEY_ENCODING}`,
    `# amountUnit=wei (18 decimals)`,
    CSV_COLUMNS,
    ...entries.map((e) => [e.oldKey, e.srcChainId, e.srcTxHash, e.srcLogIndex, e.direction, e.to, e.amount.toString(), formatAmount(e.amount)].join(",")),
    `# count=${entries.length}`,
    `# total=${total}`,
  ];
  return lines.join("\n") + "\n";
}

/** Builds the publishable manifest from the scanner's PAYABLE entries; deterministic (sorted) and self-validated. */
export function buildManifest(payable: ScanEntry[], header: ManifestHeader): Manifest {
  const bad = payable.find((e) => e.status !== "PAYABLE");
  if (bad) throw new Error(`entry ${bad.srcTxHash}#${bad.srcLogIndex} is ${bad.status}, not PAYABLE`);
  const entries: ManifestEntry[] = payable
    .map((e) => ({ oldKey: e.oldKey, srcChainId: e.srcChainId, srcTxHash: e.srcTxHash.toLowerCase() as Hex, srcLogIndex: e.srcLogIndex, direction: e.direction, to: getAddress(e.payee), amount: e.amount }))
    .sort(compareSrc);
  const csv = renderCsv(header, entries);
  const v = parseAndCheck(csv);
  if (v.errors.length > 0) throw new Error(`manifest invalid: ${v.errors.join("; ")}`);
  return { header: { ...header, vault: getAddress(header.vault) }, entries, count: entries.length, total: v.total, hash: manifestHash(csv), csv };
}

export interface ValidateOptions {
  /** Hash published with the announcement; a mismatch is an error. */
  expectedHash?: Hex;
  /** Optional on-chain check of the recipient (getCode != 0x) -> warning. */
  isContract?: (a: Address) => Promise<boolean>;
  /** Controlled-source addresses (DESIGN Appendix A) -> warning. */
  controlled?: Iterable<string>;
}

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  header: Partial<ManifestHeader>;
  entries: ManifestEntry[];
  count: number;
  total: bigint;
  hash: Hex;
}

function parseAndCheck(csv: string): Omit<ValidationReport, "ok" | "warnings"> {
  const errors: string[] = [];
  const header: Partial<ManifestHeader> = {};
  const entries: ManifestEntry[] = [];
  let footerCount: number | undefined;
  let footerTotal: bigint | undefined;
  let sawColumns = false;
  let sawTitle = false;
  if (!csv.endsWith("\n") || csv.includes("\r")) errors.push("manifest must use LF line endings and end with a newline");
  const lines = csv.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [i, line] of lines.entries()) {
    const ln = i + 1;
    if (line.startsWith("#")) {
      if (line === MANIFEST_TITLE && i === 0) sawTitle = true;
      const m = /^# (\w+)=(.*)$/.exec(line);
      if (!m) continue;
      const [, k, v] = m as unknown as [string, string, string];
      if (k === "bscChainId") header.bscChainId = Number(v);
      else if (k === "vault") header.vault = v as Address;
      else if (k === "cutoverT") header.cutoverT = Number(v);
      else if (k === "oldKey" && v !== OLD_KEY_ENCODING) errors.push(`line ${ln}: unexpected oldKey encoding`);
      else if (k === "count") footerCount = Number(v);
      else if (k === "total") footerTotal = /^\d+$/.test(v) ? BigInt(v) : -1n;
      continue;
    }
    if (line === CSV_COLUMNS) {
      sawColumns = true;
      continue;
    }
    const f = line.split(",");
    if (!sawColumns || f.length !== 8) {
      errors.push(`line ${ln}: malformed row`);
      continue;
    }
    const [k, chain, tx, li, dir, to, wei, disp] = f as [string, string, string, string, string, string, string, string];
    if (!isTxHash(tx) || tx !== tx.toLowerCase()) {
      errors.push(`line ${ln}: bad srcTxHash`);
      continue;
    }
    if (!/^(0|[1-9]\d*)$/.test(li) || !/^[1-9]\d*$/.test(chain) || !Number.isSafeInteger(Number(li)) || !Number.isSafeInteger(Number(chain))) {
      errors.push(`line ${ln}: bad srcLogIndex/srcChainId`);
      continue;
    }
    if (dir !== "W2B" && dir !== "B2W") errors.push(`line ${ln}: bad direction`);
    if (!/^(0|[1-9]\d*)$/.test(wei)) {
      errors.push(`line ${ln}: bad amountWei`);
      continue;
    }
    if (!isAddress(to, { strict: true }) || to !== getAddress(to)) {
      errors.push(`line ${ln}: recipient must be a checksummed address`);
      continue;
    }
    const e: ManifestEntry = { oldKey: k as Hex, srcChainId: Number(chain), srcTxHash: tx, srcLogIndex: Number(li), direction: dir as Direction, to, amount: BigInt(wei) };
    if (oldKey(tx, e.srcLogIndex) !== k) errors.push(`line ${ln}: oldKey does not match srcTxHash/srcLogIndex`);
    if (formatAmount(e.amount) !== disp) errors.push(`line ${ln}: amount column does not match amountWei`);
    if (e.to === zeroAddress) errors.push(`line ${ln}: zero recipient`);
    if (e.amount === 0n) errors.push(`line ${ln}: zero amount`);
    entries.push(e);
  }
  if (!sawTitle) errors.push("missing manifest title line");
  if (!sawColumns) errors.push("missing column header");
  if (!header.bscChainId || !Number.isSafeInteger(header.bscChainId)) errors.push("missing/bad bscChainId");
  if (!header.vault || !isAddress(header.vault, { strict: true })) errors.push("missing/bad vault");
  if (!header.cutoverT || !Number.isSafeInteger(header.cutoverT)) errors.push("missing/bad cutoverT");
  const keys = new Set<string>();
  for (const [i, e] of entries.entries()) {
    if (keys.has(e.oldKey)) errors.push(`duplicate oldKey ${e.oldKey}`);
    keys.add(e.oldKey);
    if (i > 0 && compareSrc(entries[i - 1]!, e) >= 0) errors.push(`rows not strictly sorted at ${e.srcTxHash}#${e.srcLogIndex}`);
  }
  const total = entries.reduce((s, e) => s + e.amount, 0n);
  if (footerCount !== entries.length) errors.push(`footer count ${String(footerCount)} != ${entries.length} rows`);
  if (footerTotal !== total) errors.push(`footer total ${String(footerTotal)} != ${total}`);
  if (entries.length === 0) errors.push("manifest has no rows");
  return { errors, header, entries, count: entries.length, total, hash: manifestHash(csv) };
}

/** Independent check of a published manifest CSV (what the whitelist wallet runs during the 48h). */
export async function validateManifest(csv: string, opts: ValidateOptions = {}): Promise<ValidationReport> {
  const r = parseAndCheck(csv);
  const warnings: string[] = [];
  if (opts.expectedHash && opts.expectedHash.toLowerCase() !== r.hash) r.errors.push(`manifest hash ${r.hash} != published ${opts.expectedHash}`);
  const controlled = new Set([...(opts.controlled ?? [])].map((a) => a.toLowerCase()));
  const tos = [...new Set(r.entries.map((e) => e.to))];
  for (const to of tos) {
    if (controlled.has(to.toLowerCase())) warnings.push(`recipient ${to} is in the controlled set`);
    if (opts.isContract && (await opts.isContract(to))) warnings.push(`recipient ${to} has contract code`);
  }
  return { ok: r.errors.length === 0, warnings, ...r };
}

/** Reads a validated manifest back into the in-memory form (throws on any error). */
export async function loadManifest(csv: string, expectedHash?: Hex): Promise<Manifest> {
  const r = await validateManifest(csv, expectedHash ? { expectedHash } : {});
  if (!r.ok) throw new Error(`manifest invalid: ${r.errors.join("; ")}`);
  return { header: r.header as ManifestHeader, entries: r.entries, count: r.count, total: r.total, hash: r.hash, csv };
}

/** JSON view of the manifest (same content; the CSV + its hash is the authoritative publication). */
export function manifestJson(m: Manifest): string {
  return JSON.stringify(
    { title: MANIFEST_TITLE.slice(2), hash: m.hash, oldKeyEncoding: OLD_KEY_ENCODING, ...m.header, count: m.count, total: m.total.toString(), totalDisplay: formatAmount(m.total), entries: m.entries.map((e) => ({ ...e, amount: e.amount.toString(), amountDisplay: formatAmount(e.amount) })) },
    null,
    2,
  ) + "\n";
}
