import { getAbiItem, getAddress, type AbiEvent, type Address, type Hex } from "viem";
import { send, type ChainCtx, type Signer } from "./chain";
import { scanLogs } from "./whitelist";

export const RELAYER_ROLE = "0xe2b7fb3b832174769106daebcfd6d1970523240dda11281102db9363b83b0dc4" as Hex;
export const PAUSER_ROLE = "0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a" as Hex;

const call = (ctx: ChainCtx, signer: Signer, functionName: string, args: readonly unknown[] = []) =>
  send(ctx, signer, { address: ctx.cfg.bridge, abi: ctx.bridgeAbi, functionName, args });

export const pause = (c: ChainCtx, s: Signer) => call(c, s, "pause");
export const unpause = (c: ChainCtx, s: Signer) => call(c, s, "unpause");
export const freeze = (c: ChainCtx, s: Signer) => call(c, s, "freezeWhitelist");
/** Admin veto of a pending whitelist-wallet handover (decision 10). */
export const vetoWlTransfer = (c: ChainCtx, s: Signer) => call(c, s, "cancelWhitelistManagerTransfer");
export const revokeKey = (c: ChainCtx, s: Signer, role: Hex, account: Address) => call(c, s, "revokeKey", [role, account]);

/**
 * Emergency removal (admin wallet). PR1-NOTES §5.11a-1 / DESIGN §11 note 1: `emergencyRemove` does not bump the batch
 * nonce, so a pre-signed "add" batch could put the addresses back — freeze first. If the chain is not frozen yet, this
 * sends `freezeWhitelist()` and only then `emergencyRemove(addrs)` (sorted, as the contract emits them in order).
 */
export async function emergencyRemove(ctx: ChainCtx, signer: Signer, addrs: readonly Address[]): Promise<Hex[]> {
  if (addrs.length === 0) throw new Error("没有要移除的地址");
  const frozen = (await ctx.client.readContract({ address: ctx.cfg.bridge, abi: ctx.bridgeAbi, functionName: "whitelistFrozen" })) as boolean;
  const txs: Hex[] = [];
  if (!frozen) txs.push(await freeze(ctx, signer));
  txs.push(await call(ctx, signer, "emergencyRemove", [[...addrs].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))]));
  return txs;
}

/** Current RELAYER / PAUSER holders, folded from RoleGranted / RoleRevoked (AccessControl does not enumerate). */
export async function keyHolders(ctx: ChainCtx): Promise<{ role: "RELAYER" | "PAUSER"; account: Address }[]> {
  const ev = (name: string) => getAbiItem({ abi: ctx.bridgeAbi, name }) as AbiEvent;
  const [g, r] = await Promise.all([scanLogs(ctx, ev("RoleGranted")), scanLogs(ctx, ev("RoleRevoked"))]);
  const logs = [...g.map((l) => ({ l, on: true })), ...r.map((l) => ({ l, on: false }))].sort((a, b) =>
    a.l.blockNumber === b.l.blockNumber ? (a.l.logIndex ?? 0) - (b.l.logIndex ?? 0) : Number(a.l.blockNumber! - b.l.blockNumber!),
  );
  const held = new Map<string, boolean>();
  for (const { l, on } of logs) {
    const a = l.args as { role: Hex; account: Address };
    if (a.role !== RELAYER_ROLE && a.role !== PAUSER_ROLE) continue;
    held.set(`${a.role}:${getAddress(a.account)}`, on);
  }
  return [...held]
    .filter(([, v]) => v)
    .map(([k]) => {
      const [role, account] = k.split(":") as [Hex, Address];
      return { role: role === RELAYER_ROLE ? ("RELAYER" as const) : ("PAUSER" as const), account };
    });
}
