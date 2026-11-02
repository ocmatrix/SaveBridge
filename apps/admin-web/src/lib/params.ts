import { encodeFunctionData, type Address, type Hex } from "viem";
import { erc20Abi, send, type ChainCtx, type Signer } from "./chain";
import type { Side } from "./config";
import { propose } from "./timelock";

/** "down" = decreasing tightens; "up" = increasing tightens (PR1-NOTES D13). Ranges in whole tokens / seconds (PR1-NOTES §5.6/5.7). */
export interface FieldSpec {
  key: string;
  label: string;
  kind: "amount" | "seconds";
  tighten: "down" | "up";
  min?: bigint; // inclusive
  minExclusive?: bigint;
  max?: bigint;
}

const H = 3600n;
export const FIELDS: Record<Side, FieldSpec[]> = {
  bsc: [
    { key: "dailyCap", label: "全局日额度", kind: "amount", tighten: "down", min: 1_000n, max: 500_000n },
    { key: "perAddrDailyCap", label: "每地址日额度（单笔上限）", kind: "amount", tighten: "down", min: 100n, max: 20_000n },
    { key: "largeThreshold", label: "大额阈值（超过走排队）", kind: "amount", tighten: "down" },
    { key: "releaseDelay", label: "排队延迟", kind: "seconds", tighten: "up", min: 6n * H, max: 7n * 24n * H },
    { key: "minDeposit", label: "最小存入", kind: "amount", tighten: "up", minExclusive: 0n, max: 20_000n },
    { key: "maxDepositPerTx", label: "单笔最大存入", kind: "amount", tighten: "down", minExclusive: 0n, max: 10_000_000n },
  ],
  wantos: [
    { key: "w2bMinAmount", label: "最小跨出", kind: "amount", tighten: "up", min: 10n, max: 20_000n },
    { key: "w2bPerAddrDailyCap", label: "每地址日额度（单笔上限）", kind: "amount", tighten: "down", min: 10n, max: 20_000n },
    { key: "b2wDailyCap", label: "B2W 日额度", kind: "amount", tighten: "down", min: 500n, max: 100_000_000n },
    { key: "b2wDelay", label: "B2W 排队延迟", kind: "seconds", tighten: "up", min: 0n, max: 24n * H },
  ],
};

export type Params = Record<string, bigint>;
export type Change = "same" | "tighten" | "loosen";

export async function readParams(ctx: ChainCtx): Promise<{ params: Params; decimals: number }> {
  const raw = (await ctx.client.readContract({ address: ctx.cfg.bridge, abi: ctx.bridgeAbi, functionName: "params" })) as Params | readonly bigint[];
  const fields = FIELDS[ctx.cfg.side];
  const params: Params = Array.isArray(raw) ? Object.fromEntries(fields.map((f, i) => [f.key, (raw as readonly bigint[])[i]!])) : { ...(raw as Params) };
  const token = (await ctx.client.readContract({ address: ctx.cfg.bridge, abi: ctx.bridgeAbi, functionName: "token" })) as Address;
  const decimals = Number(await ctx.client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
  return { params, decimals };
}

export function classify(side: Side, cur: Params, next: Params): Record<string, Change> {
  return Object.fromEntries(
    FIELDS[side].map((f) => {
      const a = cur[f.key]!;
      const b = next[f.key]!;
      if (a === b) return [f.key, "same"];
      const tighter = f.tighten === "down" ? b < a : b > a;
      return [f.key, tighter ? "tighten" : "loosen"];
    }),
  );
}

/** Same checks the contract makes (it stays the authority); returns problems in Chinese. */
export function validate(side: Side, p: Params, decimals: number): string[] {
  const unit = 10n ** BigInt(decimals);
  const errs: string[] = [];
  for (const f of FIELDS[side]) {
    const v = p[f.key];
    if (v === undefined || v < 0n) {
      errs.push(`${f.label} 无效`);
      continue;
    }
    const u = f.kind === "amount" ? unit : 1n;
    if (f.min !== undefined && v < f.min * u) errs.push(`${f.label} 不得低于 ${f.min}`);
    if (f.minExclusive !== undefined && v <= f.minExclusive * u) errs.push(`${f.label} 必须大于 ${f.minExclusive}`);
    if (f.max !== undefined && v > f.max * u) errs.push(`${f.label} 不得高于 ${f.max}`);
  }
  if (side === "bsc" && !(p.largeThreshold! <= p.perAddrDailyCap! && p.perAddrDailyCap! <= p.dailyCap!)) errs.push("必须满足 大额阈值 ≤ 每地址日额度 ≤ 全局日额度");
  if (side === "wantos" && !(p.w2bMinAmount! <= p.w2bPerAddrDailyCap!)) errs.push("必须满足 最小跨出 ≤ 每地址日额度");
  return errs;
}

/** Tightening only → admin wallet, one tx, immediate. Any loosening → timelock proposal (48h). */
export function planKind(changes: Record<string, Change>): "none" | "direct" | "timelock" {
  const v = Object.values(changes);
  if (v.includes("loosen")) return "timelock";
  if (v.includes("tighten")) return "direct";
  return "none";
}

/** Cross-chain consistency the watcher alerts on (DESIGN §5.5). */
export function crossWarnings(bsc: Params, wantos: Params): string[] {
  const w: string[] = [];
  if (bsc.perAddrDailyCap! < wantos.w2bPerAddrDailyCap!) w.push("BSC 每地址日额度 应 ≥ WANTOS 每地址日额度");
  if (bsc.maxDepositPerTx! > wantos.b2wDailyCap!) w.push("BSC 单笔最大存入 应 ≤ WANTOS B2W 日额度");
  return w;
}

export const tuple = (side: Side, p: Params) => Object.fromEntries(FIELDS[side].map((f) => [f.key, p[f.key]!]));

export async function applyParams(ctx: ChainCtx, signer: Signer, timelock: Address, cur: Params, next: Params): Promise<{ kind: "direct" | "timelock"; tx: Hex; id?: Hex }> {
  const kind = planKind(classify(ctx.cfg.side, cur, next));
  if (kind === "none") throw new Error("参数没有变化");
  const args = [tuple(ctx.cfg.side, next)];
  if (kind === "direct") return { kind, tx: await send(ctx, signer, { address: ctx.cfg.bridge, abi: ctx.bridgeAbi, functionName: "setParams", args }) };
  const data = encodeFunctionData({ abi: ctx.bridgeAbi, functionName: "setParams", args });
  const r = await propose(ctx, signer, timelock, [{ target: ctx.cfg.bridge, data }]);
  return { kind, tx: r.tx, id: r.id };
}

/** WANTOS supplyCeiling: lowering is immediate (admin), raising is a timelock proposal. */
export async function setSupplyCeiling(ctx: ChainCtx, signer: Signer, timelock: Address, cur: bigint, next: bigint): Promise<{ kind: "direct" | "timelock"; tx: Hex }> {
  if (ctx.cfg.side !== "wantos") throw new Error("supplyCeiling 只在 WANTOS");
  if (next === cur) throw new Error("没有变化");
  if (next < cur) return { kind: "direct", tx: await send(ctx, signer, { address: ctx.cfg.bridge, abi: ctx.bridgeAbi, functionName: "setSupplyCeiling", args: [next] }) };
  const data = encodeFunctionData({ abi: ctx.bridgeAbi, functionName: "setSupplyCeiling", args: [next] });
  return { kind: "timelock", tx: (await propose(ctx, signer, timelock, [{ target: ctx.cfg.bridge, data }])).tx };
}
