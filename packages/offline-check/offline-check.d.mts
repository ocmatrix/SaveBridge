// Type declarations for offline-check.mjs (the tool itself is plain, dependency-free JavaScript).
export declare const RULES_VERSION: number;
export declare const MAX_BATCH: number;
export declare const DOMAIN_TYPEHASH: string;
export declare const BATCH_TYPEHASH: string;
export declare const CONTRACT_NAME: { bsc: string; wantos: string };
export declare const SELECTORS: Record<string, string>;
export declare const KNOWN_ROLES: Record<string, string>;
export declare function keccak256(bytes: Uint8Array): Uint8Array;
export declare function keccakHex(bytes: Uint8Array): string;
export declare function toHex(u8: Uint8Array): string;
export declare function fromHex(h: string): Uint8Array;
export declare function word(n: number | bigint): Uint8Array;
export declare function toChecksum(lowerAddr: string): string;
export declare function checkField(field: string): { address?: string; reason?: "format" | "checksum" | "zero" };
export interface ParseError { line: number; text: string; reason: string }
export interface Duplicate { line: number; address: string; firstLine: number }
export interface Parsed { addresses: string[]; errors: ParseError[]; duplicates: Duplicate[]; headerSkipped: boolean }
export declare function parseAddressList(text: string): Parsed;
export declare function chunk(addresses: string[], batchSize?: number): string[][];
export declare function listHash(sorted: string[]): string;
export declare function domainHash(d: { name: string; chainId: number | bigint; verifyingContract: string }): string;
export declare function messageHash(m: { listHash: string; count: number; allowed: boolean; nonce: number | bigint; deadline: number | bigint }): string;
export declare function digest(domain: string, message: string): string;
export interface ChainHashes { chainId: number; nonce?: string; domainHash: string; messageHash?: string; digest?: string }
export interface Batch { index: number; count: number; listHash: string; addresses: string[]; bsc: ChainHashes; wantos: ChainHashes }
export declare function computeBatches(
  text: string,
  opts: { allowed: boolean; contract: string; deadline?: bigint | number; bscNonce?: bigint | number; wantosNonce?: bigint | number; bscChainId?: number; wantosChainId?: number; batchSize?: number; batch?: number },
): Parsed & { ok: boolean; batches: Batch[] };
export interface Decoded { selector: string; signature: string | null; args: { type: string; value: unknown; label?: string; inner?: Decoded | (Decoded | null)[] }[] }
export declare function decodeCalldata(hex: string): Decoded;
export declare function runCli(argv: string[], readFile: (f: string) => string): { code: number; out: string };
