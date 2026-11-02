import { getAddress, isAddress, isAddressEqual, type Address, type Hex, type PublicClient } from "viem";
import { send, timelockAbi, type ChainCtx, type Signer } from "./chain";
import { SIDE_NAME, SIDES } from "./config";
import type { BothStates } from "./state";
import { encodeTimelock, propose } from "./timelock";

export type HandoverRole = "wl" | "admin";
const ROLE_TEXT: Record<HandoverRole, string> = { wl: "whitelist-wallet", admin: "admin-wallet" };

/** Text the NEW holder signs (personal_sign) to prove the address before the handover starts (DESIGN §4.5/§4.6 step 1). */
export function proofMessage(a: { role: HandoverRole; address: Address; bridge: Address; issuedAt: string }): string {
  return [
    "WANTOS-BSC-BRIDGE-V2 handover address proof",
    `role: ${ROLE_TEXT[a.role]}`,
    `address: ${getAddress(a.address)}`,
    `bridge: ${getAddress(a.bridge)}`,
    `issuedAt: ${a.issuedAt}`,
  ].join("\n");
}

export interface Proof {
  message: string;
  signature: Hex;
}

export async function makeProof(signer: Signer, role: HandoverRole, bridge: Address, now = new Date()): Promise<Proof> {
  const message = proofMessage({ role, address: signer.address, bridge, issuedAt: now.toISOString() });
  return { message, signature: await signer.signMessage(message) };
}

/**
 * Verifies a pasted proof: message format, bridge, and that the signature is from the address in the message
 * (EOA or, through `client.verifyMessage`, an ERC-1271 multisig). Returns the proven address.
 */
export async function verifyProof(raw: string, o: { role: HandoverRole; bridge: Address; client: PublicClient }): Promise<Address> {
  let p: Proof;
  try {
    p = JSON.parse(raw) as Proof;
  } catch {
    throw new Error("证明格式不对（应为页面生成的 JSON）");
  }
  if (typeof p?.message !== "string" || typeof p?.signature !== "string") throw new Error("证明格式不对");
  const lines = p.message.split("\n");
  const field = (k: string) => lines.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2);
  if (lines[0] !== "WANTOS-BSC-BRIDGE-V2 handover address proof" || field("role") !== ROLE_TEXT[o.role]) throw new Error("证明不是本角色的交接证明");
  const addr = field("address");
  const bridge = field("bridge");
  if (!addr || !isAddress(addr) || !bridge || !isAddress(bridge) || !isAddressEqual(bridge, o.bridge)) throw new Error("证明里的地址或桥合约不对");
  if (p.message !== proofMessage({ role: o.role, address: addr, bridge: o.bridge, issuedAt: field("issuedAt") ?? "" })) throw new Error("证明格式不对");
  const ok = await o.client.verifyMessage({ address: getAddress(addr), message: p.message, signature: p.signature as Hex }).catch(() => false);
  if (!ok) throw new Error("签名不是该地址签的");
  return getAddress(addr);
}

const bridgeCall = (ctx: ChainCtx, signer: Signer, functionName: string, args: readonly unknown[] = []) =>
  send(ctx, signer, { address: ctx.cfg.bridge, abi: ctx.bridgeAbi, functionName, args });
const tlCall = (ctx: ChainCtx, signer: Signer, timelock: Address, functionName: string, args: readonly unknown[] = []) =>
  send(ctx, signer, { address: timelock, abi: timelockAbi, functionName, args });

/** Each action is one transaction on one chain; the page offers it per chain (two chains → twice). */
export const actions = {
  // whitelist wallet handover (§4.5)
  beginWl: (c: ChainCtx, s: Signer, candidate: Address) => bridgeCall(c, s, "beginWhitelistManagerTransfer", [candidate]),
  cancelWl: (c: ChainCtx, s: Signer) => bridgeCall(c, s, "cancelWhitelistManagerTransfer"), // WL cancels or admin vetoes
  acceptWl: (c: ChainCtx, s: Signer) => bridgeCall(c, s, "acceptWhitelistManagerTransfer"),
  startWlRecovery: (c: ChainCtx, s: Signer, candidate: Address) => bridgeCall(c, s, "startWhitelistRecovery", [candidate]),
  cancelWlRecovery: (c: ChainCtx, s: Signer) => bridgeCall(c, s, "cancelWhitelistRecovery"),
  acceptWlRecovery: (c: ChainCtx, s: Signer) => bridgeCall(c, s, "acceptWhitelistRecovery"),
  // admin wallet handover (§4.6)
  proposeTransferAdmin: (c: ChainCtx, s: Signer, timelock: Address, candidate: Address) =>
    propose(c, s, timelock, [{ target: timelock, data: encodeTimelock("transferAdmin", [candidate]) }]),
  acceptAdmin: (c: ChainCtx, s: Signer, timelock: Address) => tlCall(c, s, timelock, "acceptAdmin"),
  startAdminRecovery: (c: ChainCtx, s: Signer, timelock: Address, candidate: Address) => tlCall(c, s, timelock, "startAdminRecovery", [candidate]),
  cancelAdminRecovery: (c: ChainCtx, s: Signer, timelock: Address) => tlCall(c, s, timelock, "cancelAdminRecovery"),
};

/**
 * "只完成一条链" detection (§8.2): anything about keys / handovers that differs between the two chains.
 * Each line says what to do on which chain.
 */
export function crossChainGaps(st: BothStates): string[] {
  const out: string[] = [];
  const [b, w] = [st.bsc, st.wantos];
  const eq = (x?: Address | null, y?: Address | null) => (!x && !y) || (!!x && !!y && isAddressEqual(x, y));
  if (!eq(b.wl, w.wl)) out.push(`两条链的白名单钱包不同（BSC ${b.wl} / WANTOS ${w.wl}）：请在未完成的链上补做接收`);
  if (!eq(b.admin, w.admin)) out.push(`两条链的管理钱包不同（BSC ${b.admin} / WANTOS ${w.admin}）：请在未完成的链上补做接收`);
  const one = (label: string, get: (s: BothStates["bsc"]) => Address | null) => {
    const [x, y] = [get(b), get(w)];
    if (eq(x, y)) return;
    if (x && !y) out.push(`${label}：只在 BSC 上发起，WANTOS 上还没有 —— 请在 WANTOS 上补签`);
    else if (!x && y) out.push(`${label}：只在 WANTOS 上发起，BSC 上还没有 —— 请在 BSC 上补签`);
    else out.push(`${label}：两条链指定的新地址不同（BSC ${x} / WANTOS ${y}）—— 请取消错的一边重新发起`);
  };
  one("白名单钱包交接", (s) => s.pendingWl?.candidate ?? null);
  one("白名单钱包恢复", (s) => (s.wlRecovery.active ? s.wlRecovery.candidate : null));
  one("管理钱包交接（待接收）", (s) => s.pendingAdmin?.candidate ?? null);
  one("管理钱包恢复", (s) => (s.adminRecovery.active ? s.adminRecovery.candidate : null));
  return out;
}

export function countdown(target: bigint, now: bigint): string {
  if (target <= now) return "已到";
  let s = Number(target - now);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  return `${d > 0 ? `${d} 天 ` : ""}${h} 小时 ${m} 分`;
}

export const chainsOf = () => SIDES.map((s) => ({ side: s, name: SIDE_NAME[s] }));
