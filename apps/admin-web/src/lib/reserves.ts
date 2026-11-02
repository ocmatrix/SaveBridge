import { erc20Abi, type ChainCtx } from "./chain";
import { readParams, type Params } from "./params";

export interface Reserve {
  balance: bigint;
  decimals: number;
  params: Params;
  usedToday: bigint;
  cap: bigint;
  totalSupply?: bigint;
  supplyCeiling?: bigint;
}

/** Read-only: bridge token balance, today's global quota use, and (WANTOS) supply vs ceiling — all from chain. */
export async function readReserve(ctx: ChainCtx): Promise<Reserve> {
  const b = { address: ctx.cfg.bridge, abi: ctx.bridgeAbi } as const;
  const r = <T>(functionName: string, args: readonly unknown[] = []) => ctx.client.readContract({ ...b, functionName, args }) as Promise<T>;
  const token = await r<`0x${string}`>("token");
  const [{ params, decimals }, balance, day] = await Promise.all([
    readParams(ctx),
    ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [ctx.cfg.bridge] }),
    r<bigint>("currentDay"),
  ]);
  const usedToday = await r<bigint>("dailyUsed", [day]);
  const cap = ctx.cfg.side === "bsc" ? params.dailyCap! : params.b2wDailyCap!;
  if (ctx.cfg.side !== "wantos") return { balance, decimals, params, usedToday, cap };
  const [totalSupply, supplyCeiling] = await Promise.all([
    ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
    r<bigint>("supplyCeiling"),
  ]);
  return { balance, decimals, params, usedToday, cap, totalSupply, supplyCeiling };
}
