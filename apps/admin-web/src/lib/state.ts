import { getAddress, zeroAddress, type Address } from "viem";
import { chainNow, timelockAbi, type ChainCtx, type Chains } from "./chain";
import type { Side } from "./config";

/** Everything the page decides on — read from the contracts only (never from the server, DESIGN §8.2). */
export interface ChainState {
  side: Side;
  chainId: number;
  bridge: Address;
  timelock: Address;
  token: Address;
  admin: Address;
  wl: Address;
  paused: boolean;
  frozen: boolean;
  wlNonce: bigint;
  pendingWl: { candidate: Address; availableAt: bigint; expiresAt: bigint } | null;
  wlRecovery: { active: boolean; candidate: Address; readyAt: bigint; cooldownUntil: bigint };
  pendingAdmin: { candidate: Address; expiresAt: bigint } | null;
  adminRecovery: { active: boolean; candidate: Address; readyAt: bigint; cooldownUntil: bigint };
  anyRecovery: boolean;
  epoch: bigint;
  minDelay: bigint;
  now: bigint;
}

export async function readChainState(ctx: ChainCtx): Promise<ChainState> {
  const c = ctx.client;
  const b = { address: ctx.cfg.bridge, abi: ctx.bridgeAbi } as const;
  const rb = <T>(functionName: string, args: readonly unknown[] = []) => c.readContract({ ...b, functionName, args }) as Promise<T>;
  const timelock = getAddress(await rb<Address>("timelock"));
  const t = { address: timelock, abi: timelockAbi } as const;
  const rt = <T>(functionName: string) => c.readContract({ ...t, functionName }) as Promise<T>;
  const [token, admin, wl, paused, frozen, wlNonce, pwl, rec, pendingAdmin, paExp, arActive, arCand, arReady, arCool, epoch, minDelay, now] = await Promise.all([
    rb<Address>("token"),
    rt<Address>("adminWallet"),
    rb<Address>("whitelistManager"),
    rb<boolean>("paused"),
    rb<boolean>("whitelistFrozen"),
    rb<bigint>("whitelistNonce"),
    rb<readonly [Address, bigint, bigint]>("pendingWhitelistManager"),
    rb<readonly [boolean, Address, bigint, bigint]>("whitelistRecovery"),
    rt<Address>("pendingAdmin"),
    rt<bigint>("pendingAdminExpiresAt"),
    rt<boolean>("adminRecoveryActive"),
    rt<Address>("adminRecoveryCandidate"),
    rt<bigint>("adminRecoveryReadyAt"),
    rt<bigint>("adminRecoveryCooldownUntil"),
    rt<bigint>("epoch"),
    rt<bigint>("getMinDelay"),
    chainNow(ctx),
  ]);
  const wlRecovery = { active: rec[0], candidate: getAddress(rec[1]), readyAt: rec[2], cooldownUntil: rec[3] };
  const adminRecovery = { active: arActive, candidate: getAddress(arCand), readyAt: arReady, cooldownUntil: arCool };
  return {
    side: ctx.cfg.side,
    chainId: ctx.cfg.chainId,
    bridge: ctx.cfg.bridge,
    timelock,
    token: getAddress(token),
    admin: getAddress(admin),
    wl: getAddress(wl),
    paused,
    frozen,
    wlNonce,
    pendingWl: pwl[0] === zeroAddress ? null : { candidate: getAddress(pwl[0]), availableAt: pwl[1], expiresAt: pwl[2] },
    wlRecovery,
    pendingAdmin: pendingAdmin === zeroAddress ? null : { candidate: getAddress(pendingAdmin), expiresAt: paExp },
    adminRecovery,
    anyRecovery: wlRecovery.active || adminRecovery.active,
    epoch,
    minDelay,
    now,
  };
}

export type BothStates = Record<Side, ChainState>;

export async function readBoth(chains: Chains): Promise<BothStates> {
  const [bsc, wantos] = await Promise.all([readChainState(chains.bsc), readChainState(chains.wantos)]);
  return { bsc, wantos };
}
