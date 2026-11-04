import { getAbiItem, getAddress, type AbiEvent, type Address, type Hex } from "viem";
import { describeError, send, chainNow, type ChainCtx, type Chains, type Signer } from "./chain";
import { SIDE_NAME, type Side } from "./config";
import { batchHashes, batchTypedData, type BatchHashes } from "./normalize";

class PrepareAgain extends Error {}

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
  /** set when the batch must be prepared again (nonce moved or deadline too close) — retry is not allowed */
  needsPrepare?: boolean;
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

/**
 * Prepare a batch: read each chain's current nonce and fix the hashes the owner checks offline and on the hardware
 * wallet. Signing later uses exactly these nonces; if a chain's nonce moves, the run stops and asks to prepare again
 * (never re-signs silently with hashes nobody checked).
 */
export async function prepareJob(chains: Chains, addresses: string[], allowed: boolean, deadline: bigint): Promise<BatchJob> {
  const job = newJob(addresses, allowed, deadline);
  for (const side of ["bsc", "wantos"] as Side[]) {
    const pv = await preview(chains[side], job);
    const { nonce, ...hashes } = pv;
    job.runs[side] = { status: "pending", nonce, hashes };
  }
  return job;
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
export async function runJob(
  job: BatchJob,
  o: { chains: Chains; signer: Signer; onProgress?: (j: BatchJob) => void; /** checked before every chain, signature and submission */ shouldStop?: () => boolean },
): Promise<BatchJob> {
  const stop = () => o.shouldStop?.() === true;
  let cur: BatchJob = { ...job, runs: { bsc: { ...job.runs.bsc }, wantos: { ...job.runs.wantos } } };
  const set = (side: Side, r: Partial<ChainRun>) => {
    cur = { ...cur, runs: { ...cur.runs, [side]: { ...cur.runs[side], ...r } } };
    o.onProgress?.(cur);
  };
  for (const side of writeOrder(job.allowed)) {
    const run = cur.runs[side];
    if (run.status === "done" || run.status === "skipped") continue;
    if (stop()) return cur;
    const ctx = o.chains[side];
    try {
      const states = await readWhitelisted(ctx, cur.addresses);
      if (states.every((w) => w === cur.allowed)) {
        set(side, { status: run.txHash ? "done" : "skipped", error: undefined, note: "链上已是目标状态" });
        continue;
      }
      const now = await chainNow(ctx);
      if (cur.deadline <= now + DEADLINE_MARGIN_S) throw new PrepareAgain("签名有效期快到或已过");
      if (run.nonce === undefined || !run.hashes) throw new PrepareAgain("本批未准备（没有核对过的 nonce 与哈希）");
      const nonce = await readNonce(ctx);
      if (nonce !== run.nonce) throw new PrepareAgain(`链上批次 nonce 已从 ${run.nonce} 变为 ${nonce}，已核对的哈希作废`);
      const input = { side, chainId: ctx.cfg.chainId, bridge: ctx.cfg.bridge, addresses: cur.addresses, allowed: cur.allowed, nonce, deadline: cur.deadline };
      const hashes = batchHashes(input);
      if (hashes.digest !== run.hashes.digest) throw new PrepareAgain("待签内容与准备时显示的哈希不一致");
      let signature = run.signature;
      if (!signature) {
        if (stop()) return cur;
        set(side, { status: "signing", error: undefined });
        signature = await o.signer.signTypedData(ctx.cfg.chainId, batchTypedData(input));
      }
      if (stop()) return cur; // the form changed while the wallet was open: never submit a batch no longer on screen
      set(side, { status: "submitting", nonce, hashes, signature, error: undefined });
      const txHash = await send(ctx, o.signer, {
        address: ctx.cfg.bridge,
        abi: ctx.bridgeAbi,
        functionName: "applyWhitelistBatch",
        args: [cur.addresses as Address[], cur.allowed, nonce, cur.deadline, signature],
      });
      set(side, { status: "done", txHash, note: undefined });
    } catch (e) {
      if (e instanceof PrepareAgain) {
        set(side, { status: "failed", needsPrepare: true, signature: undefined, error: `${SIDE_NAME[side]}：${e.message}。请重新「准备本批」并重新离线核对后再签` });
        return cur;
      }
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

/** Default log-scan step; public RPCs limit getLogs ranges. A chain overrides it with `cfg.logStep` (rpc3's node allows 100 blocks). */
export const LOG_STEP = 50_000n;
/**
 * getLogs calls in flight per RPC endpoint, across ALL scans on the page. The batching transport merges them into one
 * HTTP request (batchSize 20), so this is about one request at a time. rpc3 allows a client only 8 concurrent heavy reads
 * and ~10 per second (nginx limit_conn / limit_req, answered with 429); several scans started together used to exceed that.
 */
export const LOG_PARALLEL = 20;

const gates = new Map<string, { active: number; waiting: Array<() => void> }>();
async function gated<T>(key: string, limit: number, fn: () => Promise<T>): Promise<T> {
  let g = gates.get(key);
  if (!g) gates.set(key, (g = { active: 0, waiting: [] }));
  if (g.active >= limit) await new Promise<void>((resolve) => g.waiting.push(resolve));
  g.active++;
  try {
    return await fn();
  } finally {
    g.active--;
    g.waiting.shift()?.();
  }
}

/**
 * The node can answer eth_getLogs with "failed to fetch header by number (latest) … failed to get receipts from comet
 * block: tx not found" while its indexer is still one block behind (it resolves `latest` internally, whatever the range).
 * It clears within a block or two, so these errors are retried instead of being shown to the admin.
 */
export const LOG_RETRIES = 4;
export const LOG_RETRY_MS = 600;
const isIndexLag = (e: unknown): boolean => /tx not found|failed to fetch header by number|failed to get receipts from comet block/i.test(e instanceof Error ? e.message : String(e));

async function withIndexRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= LOG_RETRIES || !isIndexLag(e)) throw e;
      await new Promise((resolve) => setTimeout(resolve, LOG_RETRY_MS * (attempt + 1)));
    }
  }
}

export async function scanLogs(ctx: ChainCtx, event: AbiEvent, address: Address = ctx.cfg.bridge, step = ctx.cfg.logStep ?? LOG_STEP) {
  const latest = await ctx.client.getBlockNumber({ cacheTime: 0 });
  const ranges: Array<[bigint, bigint]> = [];
  for (let from = ctx.cfg.fromBlock; from <= latest; from += step) ranges.push([from, from + step - 1n > latest ? latest : from + step - 1n]);
  const key = String(ctx.cfg.rpcUrl);
  const parts = await Promise.all(ranges.map(([fromBlock, toBlock]) => gated(key, LOG_PARALLEL, () => withIndexRetry(() => ctx.client.getLogs({ address, event, fromBlock, toBlock })))));
  return parts.flat();
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

// ------------------------------------------------------------------ one-signature flow (REDEPLOY-PLAN D3/D4)

export interface SharedRunOpts {
  chains: Chains;
  signer: Signer;
  /** Same-origin endpoint of the submission service (functions/api/whitelist.ts). */
  submitApi: string;
  onProgress?: (j: BatchJob) => void;
  shouldStop?: () => boolean;
  /** Injected in tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
}

interface ServiceRun {
  status: "done" | "skipped" | "failed" | "pending";
  txHash?: Hex;
  error?: string;
  note?: string;
}

/**
 * Whitelist write with ONE wallet signature and no network switch: the batch (chainless EIP-712 domain) is signed once
 * and the service submits the same signature to both chains in the §4.4 order. Resumable: a stored signature is sent
 * again after a failure, and a chain that already has the batch is skipped by the service.
 */
export async function runJobShared(job: BatchJob, o: SharedRunOpts): Promise<BatchJob> {
  const stop = () => o.shouldStop?.() === true;
  let cur: BatchJob = { ...job, runs: { bsc: { ...job.runs.bsc }, wantos: { ...job.runs.wantos } } };
  const setBoth = (r: Partial<ChainRun>) => {
    cur = { ...cur, runs: { bsc: { ...cur.runs.bsc, ...r }, wantos: { ...cur.runs.wantos, ...r } } };
    o.onProgress?.(cur);
  };
  const setSide = (side: Side, r: Partial<ChainRun>) => {
    cur = { ...cur, runs: { ...cur.runs, [side]: { ...cur.runs[side], ...r } } };
    o.onProgress?.(cur);
  };
  const needPrepare = (msg: string) => {
    setBoth({ status: "failed", needsPrepare: true, signature: undefined, error: `${msg}。请重新「准备本批」并重新离线核对后再签` });
    return cur;
  };
  if (isComplete(cur) || stop()) return cur;
  const { bsc, wantos } = cur.runs;
  if (bsc.nonce === undefined || wantos.nonce === undefined || !bsc.hashes || !wantos.hashes) return needPrepare("本批未准备（没有核对过的 nonce 与哈希）");
  if (bsc.nonce !== wantos.nonce) return needPrepare(`两条链的白名单 nonce 不一致（BSC ${bsc.nonce} / WANTOS ${wantos.nonce}），不能共用一份签名`);
  if (bsc.hashes.digest !== wantos.hashes.digest) return needPrepare("两条链待签内容不一致");
  try {
    const now = await chainNow(o.chains.wantos);
    if (cur.deadline <= now + DEADLINE_MARGIN_S) return needPrepare("签名有效期快到或已过");
    const input = { side: "wantos" as Side, chainId: o.chains.wantos.cfg.chainId, bridge: o.chains.wantos.cfg.bridge, addresses: cur.addresses, allowed: cur.allowed, nonce: bsc.nonce, deadline: cur.deadline };
    if (batchHashes(input).digest !== wantos.hashes.digest) return needPrepare("待签内容与准备时显示的哈希不一致");
    let signature = bsc.signature ?? wantos.signature;
    if (!signature) {
      if (stop()) return cur;
      setBoth({ status: "signing", error: undefined });
      signature = await o.signer.signTypedData(o.chains.wantos.cfg.chainId, batchTypedData(input));
    }
    if (stop()) return cur; // the form changed while the wallet was open: never submit a batch no longer on screen
    setBoth({ status: "submitting", signature, error: undefined });
    const res = await (o.fetchFn ?? fetch)(o.submitApi, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addresses: cur.addresses, allowed: cur.allowed, nonce: String(bsc.nonce), deadline: String(cur.deadline), signature }),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; runs?: Record<Side, ServiceRun> } | null;
    for (const side of ["bsc", "wantos"] as Side[]) {
      const r = body?.runs?.[side];
      if (r?.status === "done") setSide(side, { status: "done", txHash: r.txHash, error: undefined, note: undefined });
      else if (r?.status === "skipped") setSide(side, { status: "skipped", error: undefined, note: r.note ?? "链上已是目标状态" });
      else setSide(side, { status: r?.status === "failed" ? "failed" : "pending", error: r?.error ? `${SIDE_NAME[side]}：${r.error}` : undefined });
    }
    if (res.status === 409) {
      // nonce moved / signature about to expire: the stored signature is stale for every chain that is not done
      for (const side of ["bsc", "wantos"] as Side[]) if (cur.runs[side].status !== "done" && cur.runs[side].status !== "skipped") setSide(side, { needsPrepare: true, signature: undefined });
    }
    if (!isComplete(cur) && !body?.runs) setBoth({ status: "failed", error: body?.error ?? `提交服务返回 ${res.status}` });
  } catch (e) {
    setBoth({ status: "failed", error: describeError(e) });
  }
  return cur;
}
