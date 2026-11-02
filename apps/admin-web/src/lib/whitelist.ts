import { getAbiItem, getAddress, type AbiEvent, type Address, type Hex } from "viem";
import { describeError, send, chainNow, type ChainCtx, type Chains, type Signer } from "./chain";
import { SIDE_NAME, type Side } from "./config";
import { batchHashes, batchTypedData, type BatchHashes } from "./normalize";

/** DESIGN §4.4: add → BSC first then WANTOS; remove → WANTOS first then BSC. */
export function writeOrder(allowed: boolean): Side[] {
  return allowed ? ["bsc", "wantos"] : ["wantos", "bsc"];
}

export type RunStatus = "pending" | "signing" | "submitting" | "done" | "skipped" | "failed";
export interface ChainRun {
  status: RunStatus;
  nonce?: bigint;
  signature?: Hex;
  hashes?: BatchHashes;
  txHash?: Hex;
  error?: string;
  note?: string;
}

/** One batch (≤ 500 addresses) written to both chains, resumable after a partial failure. */
export interface BatchJob {
  addresses: string[]; // lowercase, ascending
  allowed: boolean;
  deadline: bigint; // unix seconds; one value for both chains so the offline check takes a single --deadline
  runs: Record<Side, ChainRun>;
}

/** Margin kept before the deadline when (re)submitting. */
export const DEADLINE_MARGIN_S = 300n;
/** Deadline chosen when preparing a batch: 23h ahead (contract maximum is 24h at submission). */
export const DEADLINE_AHEAD_S = 23n * 3600n;

export function newJob(addresses: string[], allowed: boolean, deadline: bigint): BatchJob {
  return { addresses, allowed, deadline, runs: { bsc: { status: "pending" }, wantos: { status: "pending" } } };
}

export const isComplete = (j: BatchJob) => (["bsc", "wantos"] as Side[]).every((s) => j.runs[s].status === "done" || j.runs[s].status === "skipped");

export async function readWhitelisted(ctx: ChainCtx, addrs: readonly string[]): Promise<boolean[]> {
  const out: boolean[] = [];
  const step = 50;
  for (let i = 0; i < addrs.length; i += step) {
    const part = await Promise.all(
      addrs.slice(i, i + step).map((a) => ctx.client.readContract({ address: ctx.cfg.bridge, abi: ctx.bridgeAbi, functionName: "whitelisted", args: [a] }) as Promise<boolean>),
    );
    out.push(...part);
  }
  return out;
}

export async function readNonce(ctx: ChainCtx): Promise<bigint> {
  return (await ctx.client.readContract({ address: ctx.cfg.bridge, abi: ctx.bridgeAbi, functionName: "whitelistNonce" })) as bigint;
}

/** Hashes for a side with the nonce the contract expects right now (shown before signing). */
export async function preview(ctx: ChainCtx, job: BatchJob): Promise<BatchHashes & { nonce: bigint }> {
  const nonce = await readNonce(ctx);
  return { nonce, ...batchHashes({ side: ctx.cfg.side, chainId: ctx.cfg.chainId, bridge: ctx.cfg.bridge, addresses: job.addresses, allowed: job.allowed, nonce, deadline: job.deadline }) };
}

/**
 * Runs (or resumes) a batch: per chain in the §4.4 order — skip if the chain already has every address in the
 * target state; otherwise sign (reusing a still-valid signature for the current nonce) and submit. Stops at the
 * first failure so the order is never violated; calling it again retries only what is not done.
 */
export async function runJob(job: BatchJob, o: { chains: Chains; signer: Signer; onProgress?: (j: BatchJob) => void }): Promise<BatchJob> {
  let cur: BatchJob = { ...job, runs: { bsc: { ...job.runs.bsc }, wantos: { ...job.runs.wantos } } };
  const set = (side: Side, r: Partial<ChainRun>) => {
    cur = { ...cur, runs: { ...cur.runs, [side]: { ...cur.runs[side], ...r } } };
    o.onProgress?.(cur);
  };
  for (const side of writeOrder(job.allowed)) {
    const run = cur.runs[side];
    if (run.status === "done" || run.status === "skipped") continue;
    const ctx = o.chains[side];
    try {
      const states = await readWhitelisted(ctx, cur.addresses);
      if (states.every((w) => w === cur.allowed)) {
        set(side, { status: run.txHash ? "done" : "skipped", error: undefined, note: "链上已是目标状态" });
        continue;
      }
      const now = await chainNow(ctx);
      if (cur.deadline <= now + DEADLINE_MARGIN_S) throw new Error("签名有效期已到，请重新准备这一批（新的 deadline 需要重新离线核对）");
      const nonce = await readNonce(ctx);
      let signature = run.signature;
      let hashes = run.hashes;
      if (!signature || run.nonce !== nonce) {
        const input = { side, chainId: ctx.cfg.chainId, bridge: ctx.cfg.bridge, addresses: cur.addresses, allowed: cur.allowed, nonce, deadline: cur.deadline };
        hashes = batchHashes(input);
        set(side, { status: "signing", nonce, hashes, signature: undefined, error: undefined });
        signature = await o.signer.signTypedData(ctx.cfg.chainId, batchTypedData(input));
      }
      set(side, { status: "submitting", nonce, hashes, signature, error: undefined });
      const txHash = await send(ctx, o.signer, {
        address: ctx.cfg.bridge,
        abi: ctx.bridgeAbi,
        functionName: "applyWhitelistBatch",
        args: [cur.addresses as Address[], cur.allowed, nonce, cur.deadline, signature],
      });
      set(side, { status: "done", txHash, note: undefined });
    } catch (e) {
      set(side, { status: "failed", error: `${SIDE_NAME[side]}：${describeError(e)}` });
      return cur;
    }
  }
  return cur;
}

/** `invalidateWhitelistNonce()` — voids a signed but unsubmitted batch (whitelist wallet only). */
export async function invalidateNonce(ctx: ChainCtx, signer: Signer): Promise<Hex> {
  return send(ctx, signer, { address: ctx.cfg.bridge, abi: ctx.bridgeAbi, functionName: "invalidateWhitelistNonce" });
}

export interface WhitelistHistory {
  current: Address[];
  batches: { listHash: Hex; allowed: boolean; nonce: bigint; count: bigint; block: bigint; tx: Hex }[];
  emergency: { by: Address; listHash: Hex; count: bigint; block: bigint; tx: Hex }[];
}

/** Log-scan step; public RPCs limit getLogs ranges. */
export const LOG_STEP = 50_000n;

export async function scanLogs(ctx: ChainCtx, event: AbiEvent, address: Address = ctx.cfg.bridge, step = LOG_STEP) {
  const latest = await ctx.client.getBlockNumber({ cacheTime: 0 });
  const out = [];
  for (let from = ctx.cfg.fromBlock; from <= latest; from += step) {
    const to = from + step - 1n > latest ? latest : from + step - 1n;
    out.push(...(await ctx.client.getLogs({ address, event, fromBlock: from, toBlock: to })));
  }
  return out;
}

const ev = (ctx: ChainCtx, name: string) => getAbiItem({ abi: ctx.bridgeAbi, name }) as AbiEvent;

/** Current whitelist (folded from WhitelistUpdated), batch records, and emergency removals. */
export async function whitelistHistory(ctx: ChainCtx): Promise<WhitelistHistory> {
  const [upd, applied, emerg] = await Promise.all([
    scanLogs(ctx, ev(ctx, "WhitelistUpdated")),
    scanLogs(ctx, ev(ctx, "WhitelistBatchApplied")),
    scanLogs(ctx, ev(ctx, "WhitelistEmergencyRemoval")),
  ]);
  const cur = new Map<string, boolean>();
  for (const l of upd) {
    const a = l.args as { addr: Address; allowed: boolean };
    cur.set(getAddress(a.addr), a.allowed);
  }
  return {
    current: [...cur].filter(([, v]) => v).map(([k]) => k as Address).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1)),
    batches: applied.map((l) => {
      const a = l.args as { listHash: Hex; allowed: boolean; nonce: bigint; count: bigint };
      return { ...a, block: l.blockNumber!, tx: l.transactionHash! };
    }),
    emergency: emerg.map((l) => {
      const a = l.args as { by: Address; listHash: Hex; count: bigint };
      return { ...a, block: l.blockNumber!, tx: l.transactionHash! };
    }),
  };
}

/** Addresses whitelisted on exactly one chain (§8.2 "两链不一致补齐"). */
export function diffChains(bsc: readonly Address[], wantos: readonly Address[]): { onlyBsc: Address[]; onlyWantos: Address[] } {
  const b = new Set(bsc);
  const w = new Set(wantos);
  return { onlyBsc: bsc.filter((a) => !w.has(a)), onlyWantos: wantos.filter((a) => !b.has(a)) };
}
