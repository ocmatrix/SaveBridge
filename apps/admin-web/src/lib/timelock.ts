import { decodeFunctionData, encodeFunctionData, getAbiItem, isAddressEqual, type Abi, type AbiEvent, type Address, type Hex } from "viem";
import { describeError, send, timelockAbi, type ChainCtx, type Signer } from "./chain";
import { scanLogs } from "./whitelist";

export const ZERO32 = ("0x" + "0".repeat(64)) as Hex;
export const EXPIRY_PERIOD = 14n * 86400n;
export const ROLE_LABEL: Record<string, string> = {
  "0xe2b7fb3b832174769106daebcfd6d1970523240dda11281102db9363b83b0dc4": "RELAYER_ROLE（付款钥匙）",
  "0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a": "PAUSER_ROLE（暂停钥匙）",
};

/** What each A-class operation means (DESIGN §4.3 A). */
export const KIND: Record<string, string> = {
  upgradeToAndCall: "升级桥合约",
  withdraw: "提取储备",
  setParams: "参数调整",
  setSupplyCeiling: "提高发行上限",
  grantRole: "授予钥匙",
  revokeRole: "吊销钥匙",
  transferAdmin: "更换管理钱包",
  payLegacyBatch: "旧单补付",
  unfreezeWhitelist: "解除白名单冻结",
  updateDelay: "修改时间锁延迟",
};

export type TargetKind = "bridge" | "timelock" | "other";
export const TARGET_TEXT: Record<TargetKind, string> = { bridge: "桥", timelock: "时间锁", other: "其他（不是本链桥或时间锁）" };

export interface DecodedCall {
  target: Address;
  targetKind: TargetKind;
  value: bigint;
  data: Hex;
  fn: string | null;
  kind: string;
  text: string;
}

const fmt = (v: unknown): string => {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return ROLE_LABEL[v.toLowerCase()] ? `${v}（${ROLE_LABEL[v.toLowerCase()]}）` : v;
  if (Array.isArray(v)) return `[${v.map(fmt).join(", ")}]`;
  if (v && typeof v === "object") return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${fmt(x)}`).join(", ")} }`;
  return String(v);
};

/**
 * Decodes a call with the ABI of its TARGET: the bridge ABI only when the target is this chain's bridge, the timelock
 * ABI only when it is this chain's timelock. Any other target is not decoded at all and is flagged (DESIGN §11: the
 * whitelist wallet cancels malicious proposals from this list).
 */
export function decodeCall(bridgeAbi: Abi, target: Address, value: bigint, data: Hex, own: { bridge: Address; timelock: Address }): DecodedCall {
  const targetKind: TargetKind = isAddressEqual(target, own.bridge) ? "bridge" : isAddressEqual(target, own.timelock) ? "timelock" : "other";
  if (targetKind === "other") return { target, targetKind, value, data, fn: null, kind: "目标不是本系统合约（不要执行，先核对）", text: data };
  try {
    const d = decodeFunctionData({ abi: targetKind === "bridge" ? bridgeAbi : timelockAbi, data });
    return { target, targetKind, value, data, fn: d.functionName, kind: KIND[d.functionName] ?? "其他", text: `${d.functionName}(${(d.args ?? []).map(fmt).join(", ")})` };
  } catch {
    return { target, targetKind, value, data, fn: null, kind: "无法解码（不要执行，先核对）", text: data };
  }
}

export type ProposalState = "waiting" | "ready" | "done" | "cancelled" | "expired" | "stale";
export const STATE_TEXT: Record<ProposalState, string> = {
  waiting: "等待中",
  ready: "可执行",
  done: "已执行",
  cancelled: "已取消",
  expired: "已过期（14 天未执行）",
  stale: "已作废（管理钱包恢复后）",
};

export interface Proposal {
  id: Hex;
  calls: DecodedCall[];
  predecessor: Hex;
  salt: Hex;
  delay: bigint;
  readyAt: bigint;
  expiresAt: bigint;
  state: ProposalState;
  block: bigint;
}

const tev = (name: string) => getAbiItem({ abi: timelockAbi, name }) as AbiEvent;

/** All proposals of this chain's timelock (from CallScheduled / CallSalt), with live state from the contract. */
export async function listProposals(ctx: ChainCtx, timelock: Address): Promise<Proposal[]> {
  const [sched, salts] = await Promise.all([scanLogs(ctx, tev("CallScheduled"), timelock), scanLogs(ctx, tev("CallSalt"), timelock)]);
  const saltOf = new Map<string, Hex>();
  for (const l of salts) saltOf.set((l.args as { id: Hex }).id, (l.args as { salt: Hex }).salt);
  const byId = new Map<Hex, { calls: { index: bigint; c: DecodedCall }[]; predecessor: Hex; delay: bigint; block: bigint }>();
  for (const l of sched) {
    const a = l.args as { id: Hex; index: bigint; target: Address; value: bigint; data: Hex; predecessor: Hex; delay: bigint };
    const e = byId.get(a.id) ?? { calls: [], predecessor: a.predecessor, delay: a.delay, block: l.blockNumber! };
    e.calls.push({ index: a.index, c: decodeCall(ctx.bridgeAbi, a.target, a.value, a.data, { bridge: ctx.cfg.bridge, timelock }) });
    byId.set(a.id, e);
  }
  const rt = <T>(functionName: string, args: readonly unknown[] = []) => ctx.client.readContract({ address: timelock, abi: timelockAbi, functionName, args }) as Promise<T>;
  const epoch = await rt<bigint>("epoch");
  const out: Proposal[] = [];
  for (const [id, e] of byId) {
    const [opState, readyAt, expired, pEpoch] = await Promise.all([
      rt<number>("getOperationState", [id]),
      rt<bigint>("getTimestamp", [id]),
      rt<boolean>("isOperationExpired", [id]),
      rt<bigint>("proposalEpoch", [id]),
    ]);
    const state: ProposalState =
      opState === 0 ? "cancelled" : opState === 3 ? "done" : pEpoch !== epoch ? "stale" : expired ? "expired" : opState === 2 ? "ready" : "waiting";
    out.push({
      id,
      calls: e.calls.sort((x, y) => Number(x.index - y.index)).map((x) => x.c),
      predecessor: e.predecessor,
      salt: saltOf.get(id) ?? ZERO32,
      delay: e.delay,
      readyAt,
      expiresAt: readyAt + EXPIRY_PERIOD,
      state,
      block: e.block,
    });
  }
  return out.sort((a, b) => Number(b.block - a.block));
}

export function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")) as Hex;
}

/** Admin wallet proposes one or several calls (48h). Returns the operation id. */
export async function propose(ctx: ChainCtx, signer: Signer, timelock: Address, calls: { target: Address; data: Hex; value?: bigint }[], salt = randomSalt()): Promise<{ id: Hex; tx: Hex }> {
  const delay = (await ctx.client.readContract({ address: timelock, abi: timelockAbi, functionName: "getMinDelay" })) as bigint;
  const single = calls.length === 1;
  const c0 = calls[0]!;
  const id = (await ctx.client.readContract({
    address: timelock,
    abi: timelockAbi,
    functionName: single ? "hashOperation" : "hashOperationBatch",
    args: single ? [c0.target, c0.value ?? 0n, c0.data, ZERO32, salt] : [calls.map((c) => c.target), calls.map((c) => c.value ?? 0n), calls.map((c) => c.data), ZERO32, salt],
  })) as Hex;
  const tx = await send(ctx, signer, {
    address: timelock,
    abi: timelockAbi,
    functionName: single ? "schedule" : "scheduleBatch",
    args: single
      ? [c0.target, c0.value ?? 0n, c0.data, ZERO32, salt, delay]
      : [calls.map((c) => c.target), calls.map((c) => c.value ?? 0n), calls.map((c) => c.data), ZERO32, salt, delay],
  });
  return { id, tx };
}

/** Cancel (admin wallet or whitelist wallet, read live by the contract). */
export function cancelProposal(ctx: ChainCtx, signer: Signer, timelock: Address, id: Hex): Promise<Hex> {
  return send(ctx, signer, { address: timelock, abi: timelockAbi, functionName: "cancel", args: [id] });
}

/**
 * Execute a ready proposal (anyone). A post-execution self-check failure (`BridgeCheckFailed`), an empty revert or an
 * undecodable revert means the new implementation is unfit (PR1-NOTES §5.11a-4): do not retry.
 */
export async function executeProposal(ctx: ChainCtx, signer: Signer, timelock: Address, p: Proposal): Promise<Hex> {
  const single = p.calls.length === 1;
  const c0 = p.calls[0]!;
  try {
    return await send(ctx, signer, {
      address: timelock,
      abi: timelockAbi,
      functionName: single ? "execute" : "executeBatch",
      args: single ? [c0.target, c0.value, c0.data, p.predecessor, p.salt] : [p.calls.map((c) => c.target), p.calls.map((c) => c.value), p.calls.map((c) => c.data), p.predecessor, p.salt],
    });
  } catch (e) {
    throw new Error(executeErrorText(e));
  }
}

export function executeErrorText(e: unknown): string {
  const d = describeError(e);
  if (/BridgeCheckFailed|无原因数据|无法解码/.test(d))
    return `新实现不合格（执行后自检失败：${d}）。不要重试；请在到期前取消该提议，换正确的实现重新提议。`;
  return d;
}

export const encodeTimelock = (functionName: string, args: readonly unknown[]) => encodeFunctionData({ abi: timelockAbi, functionName, args });
