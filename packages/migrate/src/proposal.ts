import { bridgeTimelockAbi, bscVaultV2Abi } from "@bridge/abi";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, zeroHash, type Address, type Hex } from "viem";
import { formatAmount } from "./amount.js";
import type { Manifest, ManifestEntry } from "./types.js";

/** Contract constant `MAX_LEGACY_BATCH` (BscVaultV2). */
export const MAX_LEGACY_BATCH = 100;
/** Timelock `MIN_DELAY` (48h). */
export const MIN_DELAY = 48n * 3600n;
export const SALT_DOMAIN = "WANTOS-BRIDGE-V2-LEGACY";

export interface ProposalOptions {
  timelock: Address;
  /** ≤ 100 (default 100). */
  batchSize?: number;
  /** ≥ 48h (default 48h). */
  delay?: bigint;
}

export interface LegacyProposal {
  index: number;
  entries: ManifestEntry[];
  count: number;
  total: bigint;
  timelock: Address;
  target: Address;
  value: bigint;
  payCalldata: Hex;
  predecessor: Hex;
  salt: Hex;
  delay: bigint;
  operationId: Hex;
  /** `timelock.schedule(...)` calldata, sent by the admin wallet. */
  scheduleCalldata: Hex;
  /** `timelock.execute(...)` calldata, sent by anyone once ready. */
  executeCalldata: Hex;
}

/** Deterministic salt: one per (manifest, batch index). A re-proposal after expiry/cancel must use a new `round`. */
export function legacySalt(manifestHash: Hex, index: number, round = 0): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }], [SALT_DOMAIN, manifestHash, BigInt(index), BigInt(round)]));
}

/** OZ TimelockController.hashOperation. */
export function hashOperation(target: Address, value: bigint, data: Hex, predecessor: Hex, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "bytes32" }], [target, value, data, predecessor, salt]));
}

export function payLegacyCalldata(entries: ManifestEntry[]): Hex {
  if (entries.length === 0 || entries.length > MAX_LEGACY_BATCH) throw new Error(`batch size ${entries.length} outside 1..${MAX_LEGACY_BATCH}`);
  return encodeFunctionData({ abi: bscVaultV2Abi, functionName: "payLegacyBatch", args: [entries.map((e) => e.oldKey), entries.map((e) => e.to), entries.map((e) => e.amount)] });
}

/** Splits the manifest in its published order into batches of ≤ batchSize and builds one timelock operation per batch. */
export function buildProposals(m: Manifest, opts: ProposalOptions, round = 0): LegacyProposal[] {
  const size = opts.batchSize ?? MAX_LEGACY_BATCH;
  if (!Number.isInteger(size) || size < 1 || size > MAX_LEGACY_BATCH) throw new Error(`batchSize must be 1..${MAX_LEGACY_BATCH}`);
  const delay = opts.delay ?? MIN_DELAY;
  if (delay < MIN_DELAY) throw new Error("delay below 48h");
  const target = getAddress(m.header.vault);
  const timelock = getAddress(opts.timelock);
  const out: LegacyProposal[] = [];
  for (let i = 0, b = 0; i < m.entries.length; i += size, b++) {
    const entries = m.entries.slice(i, i + size);
    const payCalldata = payLegacyCalldata(entries);
    const salt = legacySalt(m.hash, b, round);
    out.push({
      index: b,
      entries,
      count: entries.length,
      total: entries.reduce((s, e) => s + e.amount, 0n),
      timelock,
      target,
      value: 0n,
      payCalldata,
      predecessor: zeroHash,
      salt,
      delay,
      operationId: hashOperation(target, 0n, payCalldata, zeroHash, salt),
      scheduleCalldata: encodeFunctionData({ abi: bridgeTimelockAbi, functionName: "schedule", args: [target, 0n, payCalldata, zeroHash, salt, delay] }),
      executeCalldata: encodeFunctionData({ abi: bridgeTimelockAbi, functionName: "execute", args: [target, 0n, payCalldata, zeroHash, salt] }),
    });
  }
  if (out.reduce((s, p) => s + p.total, 0n) !== m.total) throw new Error("batches do not add up to the manifest total");
  return out;
}

export interface ScheduledCall {
  target: Address;
  value: bigint;
  data: Hex;
  predecessor: Hex;
  delay: bigint;
}

export interface CallCheck {
  ok: boolean;
  errors: string[];
  count: number;
  total: bigint;
  entries: ManifestEntry[];
}

/**
 * What the whitelist wallet runs on every `CallScheduled` touching the vault: decode the calldata
 * and require every (oldKey, to, amount) to be a row of the published manifest. Anything else → cancel.
 */
export function verifyScheduledCall(call: ScheduledCall, m: Manifest): CallCheck {
  const errors: string[] = [];
  const entries: ManifestEntry[] = [];
  if (getAddress(call.target) !== getAddress(m.header.vault)) errors.push(`target ${call.target} is not the vault ${m.header.vault}`);
  if (call.value !== 0n) errors.push("value must be 0");
  if (call.predecessor !== zeroHash) errors.push("unexpected predecessor");
  if (call.delay < MIN_DELAY) errors.push("delay below 48h");
  let args: readonly [readonly Hex[], readonly Address[], readonly bigint[]];
  try {
    const d = decodeFunctionData({ abi: bscVaultV2Abi, data: call.data });
    if (d.functionName !== "payLegacyBatch") throw new Error(`function ${d.functionName} is not payLegacyBatch`);
    args = d.args as typeof args;
  } catch (e) {
    return { ok: false, errors: [...errors, `cannot decode payLegacyBatch: ${(e as Error).message.split("\n")[0]}`], count: 0, total: 0n, entries };
  }
  const [keys, tos, amounts] = args;
  if (keys.length !== tos.length || keys.length !== amounts.length) errors.push("array lengths differ");
  if (keys.length === 0 || keys.length > MAX_LEGACY_BATCH) errors.push(`batch size ${keys.length} outside 1..${MAX_LEGACY_BATCH}`);
  const byKey = new Map(m.entries.map((e) => [e.oldKey.toLowerCase(), e]));
  const seen = new Set<string>();
  let total = 0n;
  keys.forEach((k, i) => {
    const e = byKey.get(k.toLowerCase());
    if (seen.has(k.toLowerCase())) errors.push(`duplicate oldKey ${k} in call`);
    seen.add(k.toLowerCase());
    if (!e) return void errors.push(`oldKey ${k} is not in the published manifest`);
    if (tos[i] === undefined || getAddress(tos[i]!) !== e.to) errors.push(`oldKey ${k}: recipient ${String(tos[i])} != manifest ${e.to}`);
    if (amounts[i] !== e.amount) errors.push(`oldKey ${k}: amount ${String(amounts[i])} != manifest ${e.amount}`);
    total += amounts[i] ?? 0n;
    entries.push(e);
  });
  return { ok: errors.length === 0, errors, count: keys.length, total, entries };
}

/** Human-readable decoded view of all proposals (published next to the manifest). */
export function renderProposals(m: Manifest, ps: LegacyProposal[]): string {
  const lines = [
    `legacy payout proposals  manifest=${m.hash}`,
    `vault=${m.header.vault} bscChainId=${m.header.bscChainId} entries=${m.count} total=${formatAmount(m.total)} USDT batches=${ps.length}`,
  ];
  for (const p of ps) {
    lines.push("", `batch ${p.index}: ${p.count} entries, ${formatAmount(p.total)} USDT`, `  operationId=${p.operationId}`, `  salt=${p.salt}  delay=${p.delay}s  timelock=${p.timelock}`);
    for (const e of p.entries) lines.push(`  ${e.oldKey}  ${e.to}  ${formatAmount(e.amount).padStart(14)}  <- ${e.srcChainId}:${e.srcTxHash}#${e.srcLogIndex} ${e.direction}`);
  }
  return lines.join("\n") + "\n";
}
