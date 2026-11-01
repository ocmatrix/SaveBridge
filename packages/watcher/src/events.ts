import { bridgeTimelockAbi, bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import {
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type Log,
} from "viem";
import type { ChainName } from "./types.js";

export const EVENT_KEY_TAG = "WANTOS-BSC-BRIDGE-V2";
export const PAUSER_ROLE = "0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a" as const;
export const STATUS = { None: 0, Queued: 1, Released: 2, Voided: 3 } as const;
export const ORDER_STATUS = { None: 0, Locked: 1, Refunding: 2, Refunded: 3 } as const;
export const DEPOSIT_REFUND = { None: 0, Refunding: 1, Refunded: 2 } as const;

export const erc20Abi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const bridgeAbiOf = (c: ChainName): Abi => (c === "bsc" ? (bscVaultV2Abi as Abi) : (wantosBridgeV2Abi as Abi));

/** PR1-NOTES §5.2, exactly: keccak256(abi.encode(string tag, uint256 srcChainId, address srcBridge, uint256 nonce)). */
export function computeEventKey(srcChainId: number | bigint, srcBridge: Address, srcEventNonce: bigint): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }], [EVENT_KEY_TAG, BigInt(srcChainId), srcBridge, srcEventNonce]),
  );
}

export interface DecodedLog {
  source: "bridge" | "timelock" | "token" | "legacy";
  name: string;
  args: Record<string, unknown>;
  address: Address;
  block: bigint;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
  timestamp: number;
}

export function decodeLog(abi: Abi, log: Log): { name: string; args: Record<string, unknown> } | null {
  try {
    const d = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    return { name: String(d.eventName), args: (d.args ?? {}) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Decode a timelock-scheduled call for the human-readable level-1 push. */
export function describeCall(target: Address, data: Hex, bridge: Address, timelock: Address, chain: ChainName): { fn: string; args: unknown[] } {
  const abi = target.toLowerCase() === bridge.toLowerCase() ? bridgeAbiOf(chain) : target.toLowerCase() === timelock.toLowerCase() ? (bridgeTimelockAbi as Abi) : null;
  if (abi) {
    try {
      const d = decodeFunctionData({ abi, data });
      return { fn: d.functionName, args: [...(d.args ?? [])] };
    } catch {
      /* fall through */
    }
  }
  return { fn: data.slice(0, 10), args: [data] };
}
