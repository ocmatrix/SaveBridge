import { getAddress, parseAbi } from "viem";
import type { Address } from "@bridge/relayer/src/types";
import type { PairInfo } from "./config";

const factoryAbi = parseAbi(["function allPairsLength() view returns (uint256)", "function allPairs(uint256) view returns (address)"]);
const pairAbi = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)"]);

/** Minimal read surface (a viem PublicClient satisfies it). */
export interface ContractReader {
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

/**
 * Reads every pair of the WANTOS factory (§6.2: 0x31580F9B…, 8 pairs) and which side is USDT, so the
 * pair list is never hand-typed. `expectCount` guards against a factory that has grown (new pairs must be
 * reviewed before they are traced).
 */
export async function loadPairsFromFactory(c: ContractReader, factory: Address, usdt: Address, expectCount?: number): Promise<PairInfo[]> {
  const n = Number((await c.readContract({ address: factory, abi: factoryAbi, functionName: "allPairsLength" })) as bigint);
  if (expectCount !== undefined && n !== expectCount) throw new Error(`factory has ${n} pairs, expected ${expectCount}`);
  const out: PairInfo[] = [];
  for (let i = 0; i < n; i++) {
    const pair = getAddress((await c.readContract({ address: factory, abi: factoryAbi, functionName: "allPairs", args: [BigInt(i)] })) as string);
    const t0 = getAddress((await c.readContract({ address: pair, abi: pairAbi, functionName: "token0" })) as string);
    const t1 = getAddress((await c.readContract({ address: pair, abi: pairAbi, functionName: "token1" })) as string);
    const u = getAddress(usdt);
    out.push({ address: pair, usdtIndex: t0 === u ? 0 : t1 === u ? 1 : null });
  }
  return out;
}
