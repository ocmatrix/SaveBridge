/**
 * One-signature whitelist submission (REDEPLOY-PLAN D3/D4): the whitelist wallet signs ONE chainless EIP-712 batch;
 * this service checks it and submits the same signature to BOTH chains with a gas-only key.
 *
 * Why this is safe to expose without a login: `applyWhitelistBatch` is permissionless and the contracts only accept a
 * signature from `whitelistManager()` for the exact next nonce. Before any gas is spent we (1) recover the signer
 * locally and require it to be the on-chain whitelist manager, (2) require the on-chain nonce, (3) simulate the call.
 * The gas key holds no contract role; a leaked key can only burn its own gas balance.
 */
import { createPublicClient, createWalletClient, fallback, getAddress, hashTypedData, http, isAddress, parseAbi, recoverAddress, type Address, type Hex, type PublicClient, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { batchTypedData } from "../../src/lib/normalize";

export interface SubmitEnv {
  /** Bridge proxy: the same address on both chains. */
  BRIDGE: string;
  BSC_CHAIN_ID: string;
  BSC_RPC_URL: string;
  WANTOS_CHAIN_ID: string;
  WANTOS_RPC_URL: string;
  /** Optional, comma-separated: tried in order when the primary BSC_RPC_URL fails (e.g. answers 429 to Cloudflare's shared IPs). */
  BSC_RPC_FALLBACKS?: string;
  /**
   * Optional SECRET: a keyed BSC endpoint from a dedicated provider account (the key is in the URL). When present it is
   * tried first, ahead of BSC_RPC_URL and the fallbacks. Never put it in wrangler.toml; set it with
   * `wrangler pages secret put BSC_RPC_KEYED --project-name safebridge-admin`.
   */
  BSC_RPC_KEYED?: string;
  /** Secret: private key of the gas-only submitter (0x…). */
  SUBMITTER_KEY: string;
}

export interface SubmitBody {
  addresses: string[];
  allowed: boolean;
  nonce: string;
  deadline: string;
  signature: string;
}

export type ChainStatus = "done" | "skipped" | "failed" | "pending";
export interface ChainResult {
  status: ChainStatus;
  txHash?: Hex;
  error?: string;
  note?: string;
}
export interface SubmitResult {
  status: number;
  json: { ok: boolean; error?: string; runs?: Record<"bsc" | "wantos", ChainResult> };
}

const ABI = parseAbi([
  "function whitelistManager() view returns (address)",
  "function whitelistNonce() view returns (uint256)",
  "function whitelisted(address) view returns (bool)",
  "function applyWhitelistBatch(address[] sortedAddrs, bool allowed, uint256 nonce, uint256 deadline, bytes wlSignature)",
]);

export const MAX_BATCH = 500;
export const MAX_SIGNATURE_TTL = 24n * 3600n; // contract: DeadlineTooFar beyond this
export const DEADLINE_MARGIN = 120n; // refuse signatures that expire within 2 minutes
/**
 * Status for "a chain call failed". Not 502/503: Cloudflare replaces the body of a 502 (and 503/504) answered by a
 * Worker with its own HTML error page, so the page only saw "提交服务返回 502" and never the real reason in our JSON.
 */
export const CHAIN_FAILED = 424;
export const READ_BATCH = 40; // JSON-RPC calls per HTTP request; the node's batch-request-limit is 50

const bad = (error: string, status = 400): SubmitResult => ({ status, json: { ok: false, error } });

/** One short line for the page: viem's headline plus its "Status:" / "Details:" lines; never the URL or the request body. */
export function errorLine(e: unknown): string {
  if (!(e instanceof Error)) return "未知错误";
  const lines = e.message.split("\n").map((s) => s.trim()).filter(Boolean);
  return lines.filter((l, i) => i === 0 || /^(Status|Details):/.test(l)).join(" | ").slice(0, 200);
}

/** Strict shape check; returns the parsed values or an error string. */
export function parseBody(b: unknown): { addresses: Address[]; allowed: boolean; nonce: bigint; deadline: bigint; signature: Hex } | string {
  if (!b || typeof b !== "object") return "请求体无效";
  const o = b as Record<string, unknown>;
  if (!Array.isArray(o.addresses) || o.addresses.length < 1 || o.addresses.length > MAX_BATCH) return `地址数量必须在 1～${MAX_BATCH}`;
  const addresses: Address[] = [];
  let prev = -1n;
  for (const a of o.addresses) {
    if (typeof a !== "string" || !isAddress(a, { strict: false })) return "地址格式错误";
    const v = BigInt(a);
    if (v === 0n) return "不能包含零地址";
    if (v <= prev) return "地址必须严格升序且不重复";
    prev = v;
    addresses.push(getAddress(a));
  }
  if (typeof o.allowed !== "boolean") return "allowed 必须是布尔值";
  if (typeof o.nonce !== "string" || !/^\d{1,20}$/.test(o.nonce)) return "nonce 无效";
  if (typeof o.deadline !== "string" || !/^\d{1,12}$/.test(o.deadline)) return "deadline 无效";
  if (typeof o.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(o.signature)) return "签名格式错误（应为 65 字节）";
  return { addresses, allowed: o.allowed, nonce: BigInt(o.nonce), deadline: BigInt(o.deadline), signature: o.signature as Hex };
}

interface Side {
  key: "bsc" | "wantos";
  chainId: number;
  pub: PublicClient;
  /** Transport for sending transactions: same endpoints, but not batched. */
  send: Transport;
}

const usable = (u: string): boolean => /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(u);
/** Order: keyed endpoint (if any), the configured primary, then the fallbacks. Anything that is not https (or loopback) is dropped. */
const urlList = (primary: string, fallbacks?: string, keyed?: string): string[] => [
  ...(keyed && usable(keyed.trim()) ? [keyed.trim()] : []),
  primary,
  ...(fallbacks ?? "").split(",").map((s) => s.trim()).filter(usable),
];

/**
 * One endpoint → plain http with retries; several → viem `fallback` (next endpoint on any error, e.g. 429), each with a
 * single quick retry. `batch` merges concurrent reads into JSON-RPC batches.
 */
function transportFor(urls: string[], batch: boolean): Transport {
  const one = (u: string, retryCount: number) => http(u, { retryCount, retryDelay: 300, timeout: 12_000, ...(batch ? { batch: { batchSize: READ_BATCH, wait: 16 } } : {}) });
  return urls.length === 1 ? one(urls[0]!, 2) : fallback(urls.map((u) => one(u, 1)), { retryCount: 0 });
}

export async function submitWhitelist(env: SubmitEnv, raw: unknown, now: () => number = () => Date.now()): Promise<SubmitResult> {
  const p = parseBody(raw);
  if (typeof p === "string") return bad(p);
  if (!isAddress(env.BRIDGE, { strict: false })) return bad("服务未配置桥地址", 500);
  const bridge = getAddress(env.BRIDGE);
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.SUBMITTER_KEY ?? "")) return bad("服务未配置提交钥匙", 500);
  const account = privateKeyToAccount(env.SUBMITTER_KEY as Hex);

  const mk = (key: "bsc" | "wantos", chainId: string, urls: string[]): Side => ({
    key,
    chainId: Number(chainId),
    // Batched: the per-address `whitelisted()` reads become a few JSON-RPC batch requests. Single parallel requests are
    // rate-limited by rpc3 (429) and would also exhaust the Pages Function's subrequest cap on large batches.
    pub: createPublicClient({ transport: transportFor(urls, true) }) as PublicClient,
    send: transportFor(urls, false),
  });
  const sides: Record<"bsc" | "wantos", Side> = {
    bsc: mk("bsc", env.BSC_CHAIN_ID, urlList(env.BSC_RPC_URL, env.BSC_RPC_FALLBACKS, env.BSC_RPC_KEYED)),
    wantos: mk("wantos", env.WANTOS_CHAIN_ID, urlList(env.WANTOS_RPC_URL)),
  };

  // 1. the signature must come from the on-chain whitelist manager (same on both chains)
  let managers: [Address, Address];
  try {
    managers = (await Promise.all([sides.bsc, sides.wantos].map((s) => s.pub.readContract({ address: bridge, abi: ABI, functionName: "whitelistManager" })))) as [Address, Address];
  } catch {
    return bad("读取链上白名单管理者失败，请稍后重试", CHAIN_FAILED);
  }
  if (managers[0].toLowerCase() !== managers[1].toLowerCase()) return bad("两条链的白名单管理者不一致，拒绝提交", 409);
  const digest = hashTypedData(batchTypedData({ side: "bsc", chainId: sides.bsc.chainId, bridge, addresses: p.addresses, allowed: p.allowed, nonce: p.nonce, deadline: p.deadline }));
  let signer: Address;
  try {
    signer = await recoverAddress({ hash: digest, signature: p.signature });
  } catch {
    return bad("签名无法解析");
  }
  if (signer.toLowerCase() !== managers[0].toLowerCase()) return bad("签名人不是白名单钱包，拒绝提交", 403);

  // 2. deadline window (contract also enforces it; refuse early so we never spend gas on a doomed tx)
  const nowS = BigInt(Math.floor(now() / 1000));
  if (p.deadline <= nowS + DEADLINE_MARGIN) return bad("签名即将过期或已过期，请重新准备并签名", 409);
  if (p.deadline > nowS + MAX_SIGNATURE_TTL) return bad("签名有效期超过 24 小时上限", 400);

  // 3. per chain, in the §4.4 order (add: BSC then WANTOS; remove: WANTOS then BSC). Idempotent: a chain already in
  //    the target state is skipped, so the same request can be sent again after a partial failure.
  const order: ("bsc" | "wantos")[] = p.allowed ? ["bsc", "wantos"] : ["wantos", "bsc"];
  const runs: Record<"bsc" | "wantos", ChainResult> = { bsc: { status: "pending" }, wantos: { status: "pending" } };
  for (const k of order) {
    const s = sides[k];
    try {
      const states = await Promise.all(p.addresses.map((a) => s.pub.readContract({ address: bridge, abi: ABI, functionName: "whitelisted", args: [a] }) as Promise<boolean>));
      if (states.every((x) => x === p.allowed)) {
        runs[k] = { status: "skipped", note: "链上已是目标状态" };
        continue;
      }
      const nonce = (await s.pub.readContract({ address: bridge, abi: ABI, functionName: "whitelistNonce" })) as bigint;
      if (nonce !== p.nonce) {
        runs[k] = { status: "failed", error: `链上批次 nonce 是 ${nonce}，与签名的 ${p.nonce} 不一致，请重新准备本批` };
        return { status: 409, json: { ok: false, error: runs[k].error, runs } };
      }
      const wallet = createWalletClient({ account, transport: s.send });
      const args = [p.addresses, p.allowed, p.nonce, p.deadline, p.signature] as const;
      const { request } = await s.pub.simulateContract({ address: bridge, abi: ABI, functionName: "applyWhitelistBatch", args, account });
      const hash = await wallet.writeContract({ ...request, chain: null });
      const rc = await s.pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (rc.status !== "success") {
        runs[k] = { status: "failed", txHash: hash, error: "交易已上链但执行失败" };
        return { status: CHAIN_FAILED, json: { ok: false, error: runs[k].error, runs } };
      }
      runs[k] = { status: "done", txHash: hash };
    } catch (e) {
      const msg = errorLine(e);
      runs[k] = { status: "failed", error: msg };
      return { status: CHAIN_FAILED, json: { ok: false, error: `${k === "bsc" ? "BSC" : "WANTOS"}：${msg}`, runs } };
    }
  }
  return { status: 200, json: { ok: true, runs } };
}
