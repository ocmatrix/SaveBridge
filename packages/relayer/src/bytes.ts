import { bytesToHex, getAddress, hexToBytes } from "viem";
import type { Address, Hex } from "./types";

export const toBytes = (h: Hex | string): Uint8Array => hexToBytes(h.toLowerCase() as Hex);
export const fromBytes = (b: Uint8Array | null | undefined): Hex | null => (b ? bytesToHex(new Uint8Array(b)) : null);
export const addrFromBytes = (b: Uint8Array): Address => getAddress(bytesToHex(new Uint8Array(b)));
export const toBig = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v)));
