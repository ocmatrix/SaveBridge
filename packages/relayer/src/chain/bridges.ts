import { BaseError, erc20Abi, zeroAddress, type Abi, type PublicClient } from "viem";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import type { Address, Hex } from "../types";
import { PayoutStatus } from "../classify";

export type At = { blockNumber?: bigint };

export interface PayoutView {
  to: Address;
  amount: bigint;
  queuedAt: bigint;
  status: PayoutStatus;
}

/** Thin typed read helpers over a bridge proxy (one per chain). */
export class BridgeView {
  constructor(
    readonly side: "bsc" | "wantos",
    readonly client: PublicClient,
    readonly address: Address,
  ) {}

  get abi(): Abi {
    return (this.side === "bsc" ? bscVaultV2Abi : wantosBridgeV2Abi) as Abi;
  }

  async read<T>(functionName: string, args: unknown[] = [], at: At = {}): Promise<T> {
    return (await this.client.readContract({ address: this.address, abi: this.abi, functionName, args, ...at })) as T;
  }

  /**
   * Historical read that tolerates "no code at that block" (bridge deployed after the final block):
   * the record cannot exist there, so the zero value is returned.
   */
  private async readAt<T>(functionName: string, args: unknown[], at: At | undefined, zero: T): Promise<T> {
    try {
      return await this.read<T>(functionName, args, at);
    } catch (e) {
      const zeroData = e instanceof BaseError && !!e.walk((x) => (x as { name?: string }).name === "ContractFunctionZeroDataError");
      if (zeroData && at?.blockNumber !== undefined) return zero;
      throw e;
    }
  }

  paused(at?: At) {
    return this.read<boolean>("paused", [], at);
  }
  whitelisted(a: Address, at?: At) {
    return this.read<boolean>("whitelisted", [a], at);
  }
  adminWallet() {
    return this.read<Address>("adminWallet");
  }
  token() {
    return this.read<Address>("token");
  }
  currentDay(at?: At) {
    return this.read<bigint>("currentDay", [], at);
  }
  dailyUsed(day: bigint, at?: At) {
    return this.read<bigint>("dailyUsed", [day], at);
  }
  addrDailyUsed(day: bigint, a: Address, at?: At) {
    return this.read<bigint>("addrDailyUsed", [day, a], at);
  }
  async payout(eventKey: Hex, at?: At): Promise<PayoutView> {
    const [to, amount, queuedAt, status] = await this.readAt<[Address, bigint, bigint, number]>("payouts", [eventKey], at, [zeroAddress, 0n, 0n, 0]);
    return { to, amount: BigInt(amount), queuedAt: BigInt(queuedAt), status: Number(status) as PayoutStatus };
  }
  async tokenBalance(at?: At): Promise<bigint> {
    const t = await this.token();
    return (await this.client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [this.address], ...at })) as bigint;
  }
  async tokenDecimals(): Promise<number> {
    const t = await this.token();
    return Number(await this.client.readContract({ address: t, abi: erc20Abi, functionName: "decimals" }));
  }

  // ---- BSC
  async bscParams(at?: At) {
    const p = await this.read<{ dailyCap: bigint; perAddrDailyCap: bigint; largeThreshold: bigint; releaseDelay: bigint; minDeposit: bigint; maxDepositPerTx: bigint }>("params", [], at);
    return p;
  }
  async deposit(nonce: bigint, at?: At) {
    const [from, amount, refundRequestedAt, refundStatus] = await this.readAt<[Address, bigint, bigint, number]>("deposits", [nonce], at, [zeroAddress, 0n, 0n, 0]);
    return { from, amount: BigInt(amount), refundRequestedAt: BigInt(refundRequestedAt), refundStatus: Number(refundStatus) };
  }

  // ---- WANTOS
  async wantosParams(at?: At) {
    return this.read<{ w2bMinAmount: bigint; w2bPerAddrDailyCap: bigint; b2wDailyCap: bigint; b2wDelay: bigint }>("params", [], at);
  }
  async order(orderId: bigint, at?: At) {
    const [user, amount, createdAt, status, refundRequestedAt] = await this.readAt<[Address, bigint, bigint, number, bigint]>("orders", [orderId], at, [zeroAddress, 0n, 0n, 0, 0n]);
    return { user, amount: BigInt(amount), createdAt: BigInt(createdAt), status: Number(status), refundRequestedAt: BigInt(refundRequestedAt) };
  }

  /** Delay applied by `executeRelease` (current params, as the contract does). */
  async releaseDelay(at?: At): Promise<bigint> {
    return this.side === "bsc" ? (await this.bscParams(at)).releaseDelay : (await this.wantosParams(at)).b2wDelay;
  }
}

/** PR1-NOTES §5.3 */
export const OrderStatusOnChain = { None: 0, Locked: 1, Refunding: 2, Refunded: 3 } as const;
export const DepositRefundStatus = { None: 0, Refunding: 1, Refunded: 2 } as const;
