import { encodeAbiParameters, keccak256, type Hex } from "viem";

/** Published encoding (PR1-NOTES Q2, fixed by PR-8). */
export const OLD_KEY_ENCODING = "keccak256(abi.encode(bytes32 srcTxHash, uint256 srcLogIndex))";

const TX = /^0x[0-9a-fA-F]{64}$/;

export function isTxHash(h: unknown): h is Hex {
  return typeof h === "string" && TX.test(h);
}

export function checkLogIndex(i: unknown): number {
  if (typeof i !== "number" || !Number.isSafeInteger(i) || i < 0) throw new Error(`bad logIndex ${String(i)}`);
  return i;
}

export function oldKey(txHash: Hex, logIndex: number): Hex {
  if (!isTxHash(txHash)) throw new Error(`bad txHash ${String(txHash)}`);
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [txHash.toLowerCase() as Hex, BigInt(checkLogIndex(logIndex))]));
}
