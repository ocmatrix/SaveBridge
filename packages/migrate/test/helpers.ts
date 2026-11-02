import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { parseSourceJson, type SourceFile } from "../src/io.js";
import type { SourceOrder } from "../src/types.js";

export const T = 1762000000;
export const VAULT: Address = getAddress("0x00000000000000000000000000000000000b5c01");
export const TIMELOCK: Address = getAddress("0x00000000000000000000000000000000000071e1");
export const tx = (c: string): Hex => `0x${c.repeat(64)}` as Hex;
export const R = (i: number): Address => getAddress(`0xabc${(0x1000 + i).toString(16).padStart(37, "0")}`);

export function fixture(name: string): SourceFile {
  return parseSourceJson(readFileSync(join(__dirname, "fixtures", name), "utf8"));
}

/** n distinct payable W2B orders: tx i, logIndex i % 3, amount (i+1).25 */
export function manyOrders(n: number): SourceOrder[] {
  return Array.from({ length: n }, (_, i) => ({
    srcChainId: 13555,
    txHash: `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex,
    logIndex: i % 3,
    timestamp: T - 10_000 + i,
    direction: "W2B" as const,
    from: R(5000 + i),
    recipient: R(1 + (i % 37)),
    amount: `${i + 1}.25`,
  }));
}
