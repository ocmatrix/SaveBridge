import { decodeEventLog, toEventSelector, type Abi } from "viem";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import type { RawLog } from "./reader";
import type { NewOrder } from "../orders";
import type { Address } from "../types";
import { b2wEventKey, w2bEventKey } from "../eventKey";

export const BRIDGE_OUT_TOPIC = toEventSelector("BridgeOut(uint256,address,uint256)");
export const DEPOSITED_TOPIC = toEventSelector("Deposited(uint256,address,address,uint256)");

/** WANTOS `BridgeOut(orderId, user, amount)` → W2B order. Receiver is always `user` (§5.3). */
export function w2bFromLog(log: RawLog, wantosChainId: number, wantosBridge: Address): NewOrder {
  const ev = decodeEventLog({ abi: wantosBridgeV2Abi as Abi, data: log.data, topics: log.topics as [`0x${string}`], strict: true });
  if (ev.eventName !== "BridgeOut") throw new Error("not a BridgeOut log");
  const a = ev.args as unknown as { orderId: bigint; user: Address; amount: bigint };
  return {
    eventKey: w2bEventKey({ wantosChainId: BigInt(wantosChainId), wantosBridge, orderId: a.orderId }),
    direction: "W2B",
    srcChain: wantosChainId,
    srcEventNonce: a.orderId,
    srcTxHash: log.transactionHash,
    srcBlockNumber: log.blockNumber,
    srcBlockHash: log.blockHash,
    userAddr: a.user,
    toAddr: a.user,
    amountWei: a.amount,
  };
}

/** BSC `Deposited(nonce, from, wantosRecipient, amount)` → B2W order. */
export function b2wFromLog(log: RawLog, bscChainId: number, bscVault: Address): NewOrder {
  const ev = decodeEventLog({ abi: bscVaultV2Abi as Abi, data: log.data, topics: log.topics as [`0x${string}`], strict: true });
  if (ev.eventName !== "Deposited") throw new Error("not a Deposited log");
  const a = ev.args as unknown as { nonce: bigint; from: Address; wantosRecipient: Address; amount: bigint };
  return {
    eventKey: b2wEventKey({ bscChainId: BigInt(bscChainId), bscVault, depositNonce: a.nonce }),
    direction: "B2W",
    srcChain: bscChainId,
    srcEventNonce: a.nonce,
    srcTxHash: log.transactionHash,
    srcBlockNumber: log.blockNumber,
    srcBlockHash: log.blockHash,
    userAddr: a.from,
    toAddr: a.wantosRecipient,
    amountWei: a.amount,
  };
}

export function sortLogs(ls: RawLog[]): RawLog[] {
  return [...ls].sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
}
