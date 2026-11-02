import { encodeAbiParameters, getAddress, hashDomain, hashStruct, hashTypedData, keccak256, type Address, type Hex, type TypedDataDefinition } from "viem";
import type { Side } from "./config";

/**
 * Whitelist list rules v1 — MUST stay identical to packages/offline-check (rules R1–R9 in its header).
 * Both implementations are tested against the same vectors (packages/offline-check/vectors.json).
 * This file is an independent implementation (viem keccak), the tool has its own keccak.
 */
export const RULES_VERSION = 1;
export const MAX_BATCH = 500;

export type ParseReason = "format" | "checksum" | "zero";
export interface ParseError {
  line: number;
  text: string;
  reason: ParseReason;
}
export interface Duplicate {
  line: number;
  address: string;
  firstLine: number;
}
export interface Parsed {
  addresses: string[]; // lowercase, unique, ascending
  errors: ParseError[];
  duplicates: Duplicate[];
  headerSkipped: boolean;
}

export const REASON_TEXT: Record<ParseReason, string> = {
  format: "格式错误（应为 0x + 40 位十六进制）",
  checksum: "大小写校验和（EIP-55）错误",
  zero: "零地址",
};

const ZERO = "0x" + "0".repeat(40);

function checkField(field: string): { address: string } | { reason: ParseReason } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(field)) return { reason: "format" };
  const lower = field.toLowerCase();
  const body = field.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && getAddress(lower) !== field) return { reason: "checksum" };
  if (lower === ZERO) return { reason: "zero" };
  return { address: lower };
}

export function parseAddressList(text: string): Parsed {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  const errors: ParseError[] = [];
  const duplicates: Duplicate[] = [];
  const seen = new Map<string, number>();
  let first = true;
  let headerSkipped = false;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    let field = line.split(/[,;\t ]/)[0]!.trim();
    const q = field[0];
    if (field.length >= 2 && (q === '"' || q === "'") && field[field.length - 1] === q) field = field.slice(1, -1).trim();
    if (first) {
      first = false;
      if (!/^0x/i.test(field)) {
        headerSkipped = true;
        return;
      }
    }
    const r = checkField(field);
    if ("reason" in r) {
      errors.push({ line: i + 1, text: field, reason: r.reason });
      return;
    }
    const prev = seen.get(r.address);
    if (prev !== undefined) duplicates.push({ line: i + 1, address: r.address, firstLine: prev });
    else seen.set(r.address, i + 1);
  });
  return { addresses: [...seen.keys()].sort(), errors, duplicates, headerSkipped };
}

export function chunk<T>(addresses: T[], batchSize = MAX_BATCH): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) throw new Error(`批大小必须在 1～${MAX_BATCH}`);
  const out: T[][] = [];
  for (let i = 0; i < addresses.length; i += batchSize) out.push(addresses.slice(i, i + batchSize));
  return out;
}

export function listHash(sorted: readonly string[]): Hex {
  return keccak256(encodeAbiParameters([{ type: "address[]" }], [sorted as Address[]]));
}

export const CONTRACT_NAME: Record<Side, string> = { bsc: "BscVaultV2", wantos: "WantosBridgeV2" };
const BATCH_TYPES = {
  WhitelistBatch: [
    { name: "listHash", type: "bytes32" },
    { name: "count", type: "uint32" },
    { name: "allowed", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
const DOMAIN_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
} as const;

export interface BatchInput {
  side: Side;
  chainId: number;
  bridge: Address;
  addresses: readonly string[];
  allowed: boolean;
  nonce: bigint;
  deadline: bigint;
}

/** EIP-712 typed data exactly as the contract verifies it (PR1-NOTES §5.4). */
export function batchTypedData(b: BatchInput): TypedDataDefinition<typeof BATCH_TYPES, "WhitelistBatch"> {
  return {
    domain: { name: CONTRACT_NAME[b.side], version: "1", chainId: b.chainId, verifyingContract: b.bridge },
    types: BATCH_TYPES,
    primaryType: "WhitelistBatch",
    message: { listHash: listHash(b.addresses), count: b.addresses.length, allowed: b.allowed, nonce: b.nonce, deadline: b.deadline },
  };
}

export interface BatchHashes {
  listHash: Hex;
  count: number;
  domainHash: Hex;
  messageHash: Hex;
  digest: Hex;
}

/** What the owner compares against the offline tool and the hardware wallet screen. */
export function batchHashes(b: BatchInput): BatchHashes {
  const td = batchTypedData(b);
  return {
    listHash: td.message.listHash,
    count: td.message.count,
    domainHash: hashDomain({ domain: td.domain!, types: DOMAIN_TYPES }),
    messageHash: hashStruct({ data: td.message, primaryType: "WhitelistBatch", types: BATCH_TYPES }),
    digest: hashTypedData(td),
  };
}
