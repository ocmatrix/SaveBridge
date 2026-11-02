import type { Address, Hex } from "viem";

/** Old-bridge direction of a stuck order. W2B = user locked on WANTOS, BSC never paid; B2W = user deposited on BSC, WANTOS never credited. */
export type Direction = "W2B" | "B2W";

/** One "user initiated" event of the old bridge, normalised (offline JSON fixture or RPC loader output). */
export interface SourceOrder {
  srcChainId: number;
  txHash: Hex;
  logIndex: number;
  /** Unix seconds of the block that contains the event. */
  timestamp: number;
  direction: Direction;
  /** Address that initiated the order on the old bridge. */
  from: Address;
  /** Address the old bridge was asked to pay (W2B: BSC recipient). Ignored for B2W, which refunds `from` on BSC. */
  recipient?: Address;
  /** Decimal string in token units, e.g. "12.5". */
  amount: string;
}

/** One payout (release / credit) the old bridge made. `srcTxHash/srcLogIndex` link it to its order when the old bridge records it. */
export interface OldPayout {
  chainId: number;
  txHash: Hex;
  logIndex: number;
  to: Address;
  amount: string;
  srcTxHash?: Hex;
  srcLogIndex?: number;
}

export interface LegacySourceData {
  orders: SourceOrder[];
  payouts: OldPayout[];
}

export type ScanStatus =
  | "PAYABLE"
  | "INVALID_ZERO_ADDRESS"
  | "INVALID_ZERO_AMOUNT"
  | "INVALID_AMOUNT"
  | "NEW_PAID" // legacyPaid[oldKey] already true on the new vault
  | "OLD_PAID" // a linked old-bridge payout covers the full amount
  | "OLD_PARTIAL" // a linked old-bridge payout covers part of it -> manual review
  | "SUSPECT_PAID" // an unlinked old payout to the same payee with the same amount exists -> manual review
  | "AFTER_T"; // initiated at or after the cut-over time T -> separate T+14d procedure

export interface ScanEntry {
  oldKey: Hex;
  srcChainId: number;
  srcTxHash: Hex;
  srcLogIndex: number;
  direction: Direction;
  timestamp: number;
  payee: Address;
  /** Payout amount in BSC-USDT wei (18 decimals); 0n when the amount is invalid. */
  amount: bigint;
  status: ScanStatus;
  note?: string;
}

/** A row of the published manifest (only PAYABLE entries). */
export interface ManifestEntry {
  oldKey: Hex;
  srcChainId: number;
  srcTxHash: Hex;
  srcLogIndex: number;
  direction: Direction;
  to: Address;
  amount: bigint;
}

export interface ManifestHeader {
  bscChainId: number;
  vault: Address;
  cutoverT: number;
}

export interface Manifest {
  header: ManifestHeader;
  entries: ManifestEntry[];
  count: number;
  total: bigint;
  /** keccak256 of the UTF-8 CSV text. */
  hash: Hex;
  csv: string;
}

/** A `LegacyPaid(oldKey, to, amount)` event read from the new vault. */
export interface LegacyPaidEvent {
  oldKey: Hex;
  to: Address;
  amount: bigint;
  txHash?: Hex;
}
