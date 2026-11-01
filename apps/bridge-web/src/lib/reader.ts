import { erc20Abi, type Address } from "viem";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import type { AppConfig } from "../config";
import type { Clients } from "./clients";
import { remaining, whitelistState, type WhitelistState } from "./quota";

export interface BridgeState {
  wl: WhitelistState;
  wantos: {
    whitelisted: boolean;
    paused: boolean;
    decimals: number;
    w2bMinAmount: bigint;
    w2bPerAddrDailyCap: bigint;
    b2wDailyCap: bigint;
    supplyCeiling: bigint;
    totalSupply: bigint;
    balance: bigint;
  };
  bsc: { whitelisted: boolean; paused: boolean; decimals: number; minDeposit: bigint; maxDepositPerTx: bigint; balance: bigint };
  /** WANTOS w2bPerAddrDailyCap − addrDailyUsed(today, user). */
  w2bRemaining: bigint;
  /** WANTOS b2wDailyCap − dailyUsed(today): inbound capacity (global). */
  b2wRemaining: bigint;
  /** totalSupply > supplyCeiling → bridgeOut reverts SupplyCeilingExceeded. */
  supplyCeilingHit: boolean;
}

/** Reads every value the page shows (views listed in PR1-NOTES §5.5–5.7). "Today" is the contract's UTC day. */
export async function readBridgeState(cfg: AppConfig, clients: Clients, user: Address | undefined): Promise<BridgeState> {
  const W = { address: cfg.wantos.bridge, abi: wantosBridgeV2Abi } as const;
  const B = { address: cfg.bsc.bridge, abi: bscVaultV2Abi } as const;
  const w = clients.wantos;
  const b = clients.bsc;
  const zero = Promise.resolve(false);

  const [wDay, wParams, ceiling, wPaused, wWl, wDec, wTs, wBal, bParams, bPaused, bWl, bDec, bBal] = await Promise.all([
    w.readContract({ ...W, functionName: "currentDay" }),
    w.readContract({ ...W, functionName: "params" }),
    w.readContract({ ...W, functionName: "supplyCeiling" }),
    w.readContract({ ...W, functionName: "paused" }),
    user ? w.readContract({ ...W, functionName: "whitelisted", args: [user] }) : zero,
    w.readContract({ address: cfg.wantos.usdt, abi: erc20Abi, functionName: "decimals" }),
    w.readContract({ address: cfg.wantos.usdt, abi: erc20Abi, functionName: "totalSupply" }),
    user ? w.readContract({ address: cfg.wantos.usdt, abi: erc20Abi, functionName: "balanceOf", args: [user] }) : Promise.resolve(0n),
    b.readContract({ ...B, functionName: "params" }),
    b.readContract({ ...B, functionName: "paused" }),
    user ? b.readContract({ ...B, functionName: "whitelisted", args: [user] }) : zero,
    b.readContract({ address: cfg.bsc.usdt, abi: erc20Abi, functionName: "decimals" }),
    user ? b.readContract({ address: cfg.bsc.usdt, abi: erc20Abi, functionName: "balanceOf", args: [user] }) : Promise.resolve(0n),
  ]);
  const [addrUsed, dayUsed] = await Promise.all([
    user ? w.readContract({ ...W, functionName: "addrDailyUsed", args: [wDay, user] }) : Promise.resolve(0n),
    w.readContract({ ...W, functionName: "dailyUsed", args: [wDay] }),
  ]);

  // amounts cross chains 1:1 in base units (B2W cap is compared with BSC amounts): decimals must match
  if (wDec !== bDec) throw new Error(`USDT decimals differ: WANTOS ${wDec} vs BSC ${bDec}`);
  return {
    wl: whitelistState(wWl, bWl),
    wantos: {
      whitelisted: wWl,
      paused: wPaused,
      decimals: wDec,
      w2bMinAmount: wParams.w2bMinAmount,
      w2bPerAddrDailyCap: wParams.w2bPerAddrDailyCap,
      b2wDailyCap: wParams.b2wDailyCap,
      supplyCeiling: ceiling,
      totalSupply: wTs,
      balance: wBal,
    },
    bsc: { whitelisted: bWl, paused: bPaused, decimals: bDec, minDeposit: bParams.minDeposit, maxDepositPerTx: bParams.maxDepositPerTx, balance: bBal },
    w2bRemaining: remaining(wParams.w2bPerAddrDailyCap, addrUsed),
    b2wRemaining: remaining(wParams.b2wDailyCap, dayUsed),
    supplyCeilingHit: wTs > ceiling,
  };
}
