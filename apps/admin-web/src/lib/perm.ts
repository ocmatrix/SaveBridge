import { isAddressEqual, type Address } from "viem";
import { SIDE_NAME } from "./config";
import type { ChainState } from "./state";

/** Who may press a button, per the contract (PR1-NOTES §5.5 / §5.9). Decided from on-chain reads only. */
export type Who =
  | "admin"
  | "wl"
  | "adminOrWl"
  | "anyone"
  | "pendingWl" // candidate of a WL handover
  | "wlRecoveryCandidate"
  | "pendingAdmin" // candidate of an executed transferAdmin
  | "adminRecoveryCandidate";

export interface Gate {
  ok: boolean;
  reason?: string;
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const same = (a: Address | undefined, b: Address | undefined) => !!a && !!b && isAddressEqual(a, b);

/** Role check for `who` on one chain. `me` = connected wallet (undefined = not connected). */
export function gate(who: Who, me: Address | undefined, st: ChainState): Gate {
  if (!me) return { ok: false, reason: "未连接钱包" };
  const chain = SIDE_NAME[st.side];
  const isAdmin = same(me, st.admin);
  const isWl = same(me, st.wl);
  switch (who) {
    case "anyone":
      return { ok: true };
    case "admin":
      return isAdmin ? { ok: true } : { ok: false, reason: `当前钱包不是 ${chain} 的管理钱包（链上为 ${short(st.admin)}）` };
    case "wl":
      return isWl ? { ok: true } : { ok: false, reason: `当前钱包不是 ${chain} 的白名单钱包（链上为 ${short(st.wl)}）` };
    case "adminOrWl":
      return isAdmin || isWl ? { ok: true } : { ok: false, reason: `当前钱包既不是 ${chain} 的管理钱包也不是白名单钱包` };
    case "pendingWl":
      if (!st.pendingWl) return { ok: false, reason: `${chain} 上没有待接收的白名单钱包交接` };
      if (!same(me, st.pendingWl.candidate)) return { ok: false, reason: `当前钱包不是被指定的新地址（${short(st.pendingWl.candidate)}）` };
      if (st.now < st.pendingWl.availableAt) return { ok: false, reason: `${chain} 等待期未满` };
      if (st.now > st.pendingWl.expiresAt) return { ok: false, reason: `${chain} 交接已过期` };
      if (st.anyRecovery) return { ok: false, reason: `${chain} 恢复进行中，不能接收交接` };
      return { ok: true };
    case "wlRecoveryCandidate":
      if (!st.wlRecovery.active) return { ok: false, reason: `${chain} 上没有进行中的白名单钱包恢复` };
      if (!same(me, st.wlRecovery.candidate)) return { ok: false, reason: `当前钱包不是恢复指定的新地址（${short(st.wlRecovery.candidate)}）` };
      if (st.now < st.wlRecovery.readyAt) return { ok: false, reason: `${chain} 恢复等待期（7 天）未满` };
      return { ok: true };
    case "pendingAdmin":
      if (!st.pendingAdmin) return { ok: false, reason: `${chain} 上没有待接收的管理钱包交接（时间锁提议须先执行）` };
      if (!same(me, st.pendingAdmin.candidate)) return { ok: false, reason: `当前钱包不是被指定的新地址（${short(st.pendingAdmin.candidate)}）` };
      if (st.now > st.pendingAdmin.expiresAt) return { ok: false, reason: `${chain} 交接已过期` };
      if (st.anyRecovery) return { ok: false, reason: `${chain} 恢复进行中，不能接收交接` };
      return { ok: true };
    case "adminRecoveryCandidate":
      if (!st.adminRecovery.active) return { ok: false, reason: `${chain} 上没有进行中的管理钱包恢复` };
      if (!same(me, st.adminRecovery.candidate)) return { ok: false, reason: `当前钱包不是恢复指定的新地址（${short(st.adminRecovery.candidate)}）` };
      if (st.now < st.adminRecovery.readyAt) return { ok: false, reason: `${chain} 恢复等待期（14 天）未满` };
      return { ok: true };
  }
}

/** Combines a role gate with extra state conditions ([condition, reason when false]). */
export function gateWith(g: Gate, ...conds: [boolean, string][]): Gate {
  if (!g.ok) return g;
  for (const [ok, reason] of conds) if (!ok) return { ok: false, reason };
  return g;
}
