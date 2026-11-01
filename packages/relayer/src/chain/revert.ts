import { BaseError, decodeErrorResult, parseAbi, type Abi } from "viem";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import type { Hex } from "../types";

export interface RevertInfo {
  errorName?: string;
  args?: readonly unknown[];
  message?: string;
  raw?: Hex;
}

const EXTRA = parseAbi([
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
]);

const seen = new Set<string>();
/** Union of bridge errors (both chains) + token errors that bubble through SafeERC20. */
export const ERRORS_ABI: Abi = [...(bscVaultV2Abi as Abi), ...(wantosBridgeV2Abi as Abi), ...EXTRA].filter((x) => {
  if (x.type !== "error") return false;
  const sig = `${x.name}(${x.inputs.map((i) => i.type).join(",")})`;
  if (seen.has(sig)) return false;
  seen.add(sig);
  return true;
});

export function decodeRevertData(data: Hex): RevertInfo {
  try {
    const d = decodeErrorResult({ abi: ERRORS_ABI, data });
    const out: RevertInfo = { errorName: d.errorName, args: d.args ?? [] };
    if (d.errorName === "Error") out.message = String(d.args?.[0] ?? "");
    return out;
  } catch {
    return { raw: data };
  }
}

/** Extract the revert payload from a viem (or other) error. */
export function decodeRevert(e: unknown): RevertInfo {
  if (e instanceof BaseError) {
    const withData = e.walk((x) => {
      const d = (x as { data?: unknown }).data;
      return typeof d === "string" && d.startsWith("0x") && d.length >= 10;
    }) as { data?: Hex } | null;
    if (withData?.data) return decodeRevertData(withData.data);
    const named = e.walk((x) => !!(x as { data?: { errorName?: string } }).data?.errorName) as {
      data?: { errorName: string; args?: readonly unknown[] };
    } | null;
    if (named?.data) return { errorName: named.data.errorName, args: named.data.args ?? [] };
    return { message: e.shortMessage || e.message };
  }
  return { message: (e as Error)?.message ?? String(e) };
}
