import { formatUnits, type PublicClient } from "viem";
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

/**
 * BNB fee to attach to a deposit (0 = off, or an old contract without the function). The contract keeps whatever value
 * lies in [MIN_FEE, MAX_FEE] and never looks at tx.gasprice, so the wallet's own gas pricing cannot make this fail:
 * we quote at the node's current gas price (the same formula the contract exposes) and attach exactly that.
 */
export async function quoteDepositFee(pc: PublicClient, cfg: AppConfig): Promise<bigint> {
  const gasPrice = await pc.getGasPrice();
  return quoteOrZero(() => pc.readContract({ address: cfg.bsc.bridge, abi: bscVaultV2Abi, functionName: "quoteNativeFee", args: [gasPrice] }));
}

/** Native coin amount for display: up to 6 decimals, trailing zeros removed (0.0005, 12, 2.5). */
export function formatNative(v: bigint): string {
  const [i = "0", f = ""] = formatUnits(v, 18).split(".");
  const frac = f.slice(0, 6).replace(/0+$/, "");
  return frac ? `${i}.${frac}` : i;
}
