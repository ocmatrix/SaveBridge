import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  decodeErrorResult,
  defineChain,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TypedDataDefinition,
} from "viem";
import { bridgeTimelockAbi, bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import { SIDE_NAME, type AppConfig, type ChainCfg, type Side } from "./config";

export interface ChainCtx {
  cfg: ChainCfg;
  chain: Chain;
  client: PublicClient;
  bridgeAbi: Abi;
}
export type Chains = Record<Side, ChainCtx>;

export const timelockAbi = bridgeTimelockAbi as Abi;
export const bridgeAbiOf = (side: Side): Abi => (side === "bsc" ? bscVaultV2Abi : wantosBridgeV2Abi) as Abi;
export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;

export function toViemChain(c: ChainCfg): Chain {
  return defineChain({
    id: c.chainId,
    name: SIDE_NAME[c.side],
    nativeCurrency: { name: c.side === "bsc" ? "BNB" : "WANT", symbol: c.side === "bsc" ? "BNB" : "WANT", decimals: 18 },
    rpcUrls: { default: { http: [c.rpcUrl] } },
  });
}

export function makeChains(cfg: AppConfig, clientFor?: (c: ChainCfg, chain: Chain) => PublicClient): Chains {
  const one = (c: ChainCfg): ChainCtx => {
    const chain = toViemChain(c);
    const client = clientFor ? clientFor(c, chain) : (createPublicClient({ chain, transport: http(c.rpcUrl, { retryCount: 1 }) }) as PublicClient);
    return { cfg: c, chain, client, bridgeAbi: bridgeAbiOf(c.side) };
  };
  return { bsc: one(cfg.bsc), wantos: one(cfg.wantos) };
}

export interface WriteRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/**
 * The connected wallet. Every method asks the wallet; nothing is signed in the page.
 * `write` switches the wallet to `chainId` first and returns the tx hash once the wallet broadcast it.
 */
export interface Signer {
  address: Address;
  write(chainId: number, req: WriteRequest): Promise<Hex>;
  signTypedData(chainId: number, td: TypedDataDefinition): Promise<Hex>;
  signMessage(message: string): Promise<Hex>;
}

const ALL_ERRORS = [...(bscVaultV2Abi as Abi), ...(wantosBridgeV2Abi as Abi), ...(bridgeTimelockAbi as Abi)].filter((x) => x.type === "error");

/** Decoded custom error name (+args) from revert data, or null when there is no / unknown data. */
export function decodeRevert(data: Hex | undefined): { name: string; args: readonly unknown[] } | null {
  if (!data || data === "0x") return null;
  try {
    const r = decodeErrorResult({ abi: ALL_ERRORS as Abi, data });
    return { name: r.errorName, args: (r.args ?? []) as readonly unknown[] };
  } catch {
    return null;
  }
}

/** Human-readable error (Chinese) for anything thrown by viem / the wallet. */
const isRejection = (x: unknown) => (x as { code?: number })?.code === 4001 || /User (rejected|denied)/i.test((x as Error)?.message ?? "");

export function describeError(e: unknown): string {
  if (isRejection(e)) return "钱包里拒绝了";
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev) {
      const name = rev.data?.errorName ?? decodeRevert(rev.raw)?.name;
      if (name) return `合约拒绝：${name}${rev.data?.args?.length ? `(${rev.data.args.map(String).join(", ")})` : ""}`;
      return rev.raw && rev.raw !== "0x" ? `合约拒绝（无法解码的原因 ${rev.raw.slice(0, 10)}）` : "合约拒绝（无原因数据）";
    }
    if (e.walk(isRejection)) return "钱包里拒绝了";
    return e.shortMessage || e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Waits for a receipt; throws when the tx reverted. */
export async function confirm(ctx: ChainCtx, hash: Hex): Promise<void> {
  const r = await ctx.client.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`交易在 ${SIDE_NAME[ctx.cfg.side]} 上回滚：${hash}`);
}

/** Simulates (as the signer) then sends and confirms. Simulation surfaces the decoded revert reason before the wallet prompt. */
export async function send(ctx: ChainCtx, signer: Signer, req: WriteRequest): Promise<Hex> {
  await ctx.client.simulateContract({ ...req, args: req.args ?? [], account: signer.address });
  const hash = await signer.write(ctx.cfg.chainId, req);
  await confirm(ctx, hash);
  return hash;
}

export async function chainNow(ctx: ChainCtx): Promise<bigint> {
  return (await ctx.client.getBlock({ blockTag: "latest" })).timestamp;
}
