import { computeBatches } from "@bridge/offline-check";
import { encodeAbiParameters, getAddress, hashTypedData, keccak256, type Account, type Address, type Hex } from "viem";
import type { Ctx } from "./ctx";
import type { Side } from "./guard";

export const BATCH_TYPES = {
  WhitelistBatch: [
    { name: "listHash", type: "bytes32" },
    { name: "count", type: "uint32" },
    { name: "allowed", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const sortAddrs = (a: Address[]): Address[] => [...a].map((x) => getAddress(x)).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
export const listHashOf = (sorted: Address[]): Hex => keccak256(encodeAbiParameters([{ type: "address[]" }], [sorted]));

export interface SignedBatch {
  side: Side;
  sorted: Address[];
  allowed: boolean;
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
  digest: Hex;
}

export async function signBatch(ctx: Ctx, side: Side, addrs: Address[], allowed: boolean, o: { signer?: Account; nonce?: bigint; deadline?: bigint; chainId?: number } = {}): Promise<SignedBatch> {
  const sorted = sortAddrs(addrs);
  const nonce = o.nonce ?? (await ctx.view<bigint>(side, "whitelistNonce"));
  const deadline = o.deadline ?? BigInt((await ctx.syncClock()) + 300);
  const domain = { name: side === "bsc" ? "BscVaultV2" : "WantosBridgeV2", version: "1", chainId: o.chainId ?? ctx.chains[side].chainId, verifyingContract: ctx.d.proxy };
  const message = { listHash: listHashOf(sorted), count: sorted.length, allowed, nonce, deadline };
  const signer = o.signer ?? ctx.acct("wl");
  const signature = await (signer as Account & { signTypedData: (x: unknown) => Promise<Hex> }).signTypedData({ domain, types: BATCH_TYPES, primaryType: "WhitelistBatch", message });
  return { side, sorted, allowed, nonce, deadline, signature, digest: hashTypedData({ domain, types: BATCH_TYPES, primaryType: "WhitelistBatch", message }) };
}

/**
 * R3: the owner's offline tool (PR-6 offline-check) independently recomputes listHash / count / the
 * per-chain EIP-712 digest from the plain address list; the signature is only produced if they match
 * what is about to be signed AND what the contract itself computes (hashWhitelistBatch).
 */
export async function offlineCheckMatches(ctx: Ctx, addrs: Address[], allowed: boolean, nonces: Record<Side, bigint>, deadline: bigint): Promise<{ ok: boolean; detail: string }> {
  const r = computeBatches(addrs.join("\n"), {
    allowed,
    contract: ctx.d.proxy,
    deadline,
    bscNonce: nonces.bsc,
    wantosNonce: nonces.wantos,
    bscChainId: ctx.chains.bsc.chainId,
    wantosChainId: ctx.chains.wantos.chainId,
  });
  if (!r.ok || r.batches.length !== 1) return { ok: false, detail: `offline-check: ok=${r.ok} batches=${r.batches.length}` };
  const b = r.batches[0]!;
  const sorted = sortAddrs(addrs);
  const mism: string[] = [];
  if (b.listHash.toLowerCase() !== listHashOf(sorted).toLowerCase()) mism.push("listHash");
  if (b.count !== sorted.length) mism.push("count");
  for (const s of ["bsc", "wantos"] as Side[]) {
    const onchain = await ctx.view<Hex>(s, "hashWhitelistBatch", [sorted, allowed, nonces[s], deadline]);
    if (b[s].digest?.toLowerCase() !== onchain.toLowerCase()) mism.push(`${s} digest`);
  }
  return { ok: mism.length === 0, detail: mism.length ? `mismatch: ${mism.join(",")}` : `listHash ${b.listHash} count ${b.count}` };
}

/** Full R3 flow on both chains: offline check → WL signs → submission service submits (add: BSC first; remove: WANTON first). */
export async function applyBoth(ctx: Ctx, addrs: Address[], allowed: boolean): Promise<{ listHash: Hex; txs: Hex[] }> {
  const nonces = { bsc: await ctx.view<bigint>("bsc", "whitelistNonce"), wantos: await ctx.view<bigint>("wantos", "whitelistNonce") };
  const deadline = BigInt((await ctx.syncClock()) + 300);
  const oc = await offlineCheckMatches(ctx, addrs, allowed, nonces, deadline);
  if (!oc.ok) throw new Error(`offline check refused the batch: ${oc.detail}`);
  const order: Side[] = allowed ? ["bsc", "wantos"] : ["wantos", "bsc"];
  const txs: Hex[] = [];
  for (const s of order) {
    const sb = await signBatch(ctx, s, addrs, allowed, { nonce: nonces[s], deadline });
    txs.push(await submitBatch(ctx, sb));
  }
  return { listHash: listHashOf(sortAddrs(addrs)), txs };
}

export async function submitBatch(ctx: Ctx, b: SignedBatch, side: Side = b.side): Promise<Hex> {
  return ctx.call(side, ctx.keys.role("submitter"), "applyWhitelistBatch", [b.sorted, b.allowed, b.nonce, b.deadline, b.signature]);
}

export function batchReverts(ctx: Ctx, b: SignedBatch, side: Side = b.side): Promise<string> {
  return ctx.reverts(side, ctx.keys.role("submitter"), "applyWhitelistBatch", [b.sorted, b.allowed, b.nonce, b.deadline, b.signature]);
}
