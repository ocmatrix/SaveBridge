import { formatUnits, type Address, type PublicClient } from "viem";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import type { AppConfig } from "../config";

/**
 * The page may be published before the contracts are upgraded: an old bridge has no `quoteNativeFee`, so the call
 * reverts. That (and only that) means "no fee yet". A network or RPC error is not an answer and must propagate.
 */
function isQuoteMissing(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && typeof cur === "object" && i < 10; cur = (cur as { cause?: unknown }).cause, i++) {
    const n = (cur as { name?: string }).name;
    if (n === "ContractFunctionRevertedError" || n === "ContractFunctionZeroDataError") return true;
  }
  return false;
}

async function quoteOrZero(read: () => Promise<unknown>): Promise<bigint> {
  try {
    return (await read()) as bigint;
  } catch (e) {
    if (isQuoteMissing(e)) return 0n;
    throw e;
  }
}

/** WANT fee of a bridgeOut of `amount` (tiered by amount; 0 when the fee is switched off). The wallet must send exactly this. */
export async function quoteBridgeOutFee(pc: PublicClient, cfg: AppConfig, amount: bigint): Promise<bigint> {
  return quoteOrZero(() => pc.readContract({ address: cfg.wantos.bridge, abi: wantosBridgeV2Abi, functionName: "quoteNativeFee", args: [amount] }));
}

export interface DepositFeeQuote {
  /** BNB the contract will keep (at the quoted gas price). */
  fee: bigint;
  /**
   * BNB to attach. The contract charges `tx.gasprice`-based fee and refunds the excess, so attaching more than the fee
   * costs nothing and makes the deposit immune to a wallet that prices gas higher than we asked. 0 when the fee is off.
   */
  value: bigint;
  /** Gas price the quote was made at: the transaction should use exactly this price (legacy tx). */
  gasPrice: bigint | undefined;
}

/** Gas the deposit transaction may use at most, times 2 for slack: kept out of the attached value. */
const GAS_RESERVE_UNITS = 600_000n * 2n;

/**
 * Quote for a deposit by `owner`. Value rule (lowest failure rate):
 *  - normal wallet with enough balance: the contract's MAX_FEE (no gas price can push the fee above it);
 *  - modest balance: everything above a gas reserve, but never below the fee;
 *  - wallet with code (smart wallet / EIP-7702): exactly the fee, because it may be unable to receive the refund.
 */
export async function quoteDepositFee(pc: PublicClient, cfg: AppConfig, owner: Address): Promise<DepositFeeQuote> {
  const gasPrice = await pc.getGasPrice();
  const fee = await quoteOrZero(() => pc.readContract({ address: cfg.bsc.bridge, abi: bscVaultV2Abi, functionName: "quoteNativeFee", args: [gasPrice] }));
  if (fee === 0n) return { fee: 0n, value: 0n, gasPrice: undefined };
  const [maxFee, balance, code] = await Promise.all([
    pc.readContract({ address: cfg.bsc.bridge, abi: bscVaultV2Abi, functionName: "MAX_FEE" }) as Promise<bigint>,
    pc.getBalance({ address: owner }),
    pc.getCode({ address: owner }),
  ]);
  if (code && code !== "0x") return { fee, value: fee, gasPrice };
  const reserve = gasPrice * GAS_RESERVE_UNITS;
  const affordable = balance > reserve ? balance - reserve : 0n;
  const value = affordable < maxFee ? affordable : maxFee;
  return { fee, value: value > fee ? value : fee, gasPrice };
}

/** Native coin amount for display: up to 6 decimals, trailing zeros removed (0.0005, 12, 2.5). */
export function formatNative(v: bigint): string {
  const [i = "0", f = ""] = formatUnits(v, 18).split(".");
  const frac = f.slice(0, 6).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i;
}
