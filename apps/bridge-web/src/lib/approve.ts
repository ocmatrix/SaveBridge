import { erc20Abi, type Address } from "viem";
import { type AppConfig, chainById } from "../config";

export class InvalidApproveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidApproveError";
  }
}

/** Amounts are stored as uint128 on chain; anything at or above this is never a real transfer amount. */
const APPROVE_CEILING = 1n << 128n;

/**
 * Builds `usdt.approve(bridge, amount)` for the given chain with exactly the transfer amount
 * (DESIGN §8.1: never an unlimited approval).
 */
export function buildExactApprove(cfg: AppConfig, chainId: number, amount: bigint) {
  const c = chainById(cfg, chainId);
  if (!c) throw new InvalidApproveError(`unknown chain ${chainId}`);
  if (amount <= 0n || amount >= APPROVE_CEILING) throw new InvalidApproveError("approve amount must equal a real transfer amount");
  return {
    chainId: c.id,
    address: c.usdt,
    abi: erc20Abi,
    functionName: "approve" as const,
    args: [c.bridge, amount] as readonly [Address, bigint],
  };
}
