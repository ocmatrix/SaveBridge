import { formatUnits, type PublicClient } from "viem";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import type { AppConfig } from "../config";

/** BSC fee follows tx.gasprice, so the wallet cannot know it to the wei: send 20% more, the contract refunds the excess. */
const BSC_VALUE_NUM = 12n;
const BSC_VALUE_DEN = 10n;

/** WANT fee of a bridgeOut of `amount` (tiered by amount; 0 when the fee is switched off). The wallet must send exactly this. */
export async function quoteBridgeOutFee(pc: PublicClient, cfg: AppConfig, amount: bigint): Promise<bigint> {
  return (await pc.readContract({ address: cfg.wantos.bridge, abi: wantosBridgeV2Abi, functionName: "quoteNativeFee", args: [amount] })) as bigint;
}

export interface DepositFeeQuote {
  /** BNB the contract will keep. */
  fee: bigint;
  /** BNB to attach (fee + 20%); the excess is refunded. 0 when the fee is off. */
  value: bigint;
  /** Gas price the quote was made at. The transaction must use exactly this price (legacy tx), or the contract sees another one. */
  gasPrice: bigint | undefined;
}

export async function quoteDepositFee(pc: PublicClient, cfg: AppConfig): Promise<DepositFeeQuote> {
  const gasPrice = await pc.getGasPrice();
  const fee = (await pc.readContract({ address: cfg.bsc.bridge, abi: bscVaultV2Abi, functionName: "quoteNativeFee", args: [gasPrice] })) as bigint;
  if (fee === 0n) return { fee: 0n, value: 0n, gasPrice: undefined };
  return { fee, value: (fee * BSC_VALUE_NUM) / BSC_VALUE_DEN, gasPrice };
}

/** Native coin amount for display: up to 6 decimals, trailing zeros removed (0.0005, 12, 2.5). */
export function formatNative(v: bigint): string {
  const [i = "0", f = ""] = formatUnits(v, 18).split(".");
  const frac = f.slice(0, 6).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i;
}
