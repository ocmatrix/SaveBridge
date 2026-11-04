/**
 * PR-9 BSC testnet (chainId 97) public-RPC probe — pure logic, no IO of its own.
 *
 * READ-ONLY: the only JSON-RPC methods this module ever issues are eth_chainId, eth_blockNumber,
 * eth_getBlockByNumber("latest"|"finalized"|"safe") and eth_getLogs. It never signs or sends anything.
 * The transport is injected (`RpcFn`) so tests run against a fake.
 */

export const BSC_TESTNET_CHAIN_ID = 97;

/** Methods this probe may call. Anything else is refused before reaching the transport. */
export const READ_ONLY_METHODS = new Set(["eth_chainId", "net_version", "eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs"]);

export type RpcOk = { ok: true; result: unknown; ms: number; httpStatus: number };
export type RpcErr = { ok: false; ms: number; httpStatus?: number; code?: number; message: string };
export type RpcResult = RpcOk | RpcErr;
export type RpcFn = (url: string, method: string, params: unknown[]) => Promise<RpcResult>;

export interface ProbeOptions {
  /** getLogs ladder, tried largest first. */
  logRangeLadder: number[];
  /** Blocks kept away from the head when choosing the getLogs window. */
  logWindowHeadMargin: number;
  /** Address used as the getLogs filter (keeps results empty so the error is about the range, not the payload). */
  logAddress: string;
  burstCalls: number;
  burstConcurrency: number;
  /** p95 above this → degraded. */
  slowP95Ms: number;
  /** getLogs range below this → degraded. */
  minUsefulLogRange: number;
  /** Blocks behind the best endpoint in the simultaneous head snapshot before → degraded. */
  maxHeadSkew: number;
  /** Pause before the single retry of a rate-limited getLogs rung. */
  rateLimitBackoffMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_OPTIONS: ProbeOptions = {
  logRangeLadder: [10_000, 5000, 3000, 2000, 1000, 500, 100, 50, 10],
  logWindowHeadMargin: 50,
  logAddress: "0x000000000000000000000000000000000000dEaD",
  burstCalls: 20,
  burstConcurrency: 4,
  slowP95Ms: 2500,
  minUsefulLogRange: 100,
  maxHeadSkew: 30,
  rateLimitBackoffMs: 1500,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export type Classification = "usable" | "degraded" | "unusable";

export interface TagReport {
  supported: boolean;
  block: number | null;
  /** (eth_blockNumber read right after the tag) - tag block: an upper bound of the true lag. */
  lag: number | null;
  error?: string;
}

export interface LogRangeReport {
  /** Largest ladder rung (or provider hint) accepted; null = none accepted. */
  maxAccepted: number | null;
  /** The ladder's top rung was accepted → the real limit is at least this (unknown above). */
  atLeast: boolean;
  firstRejection: { range: number; kind: ErrorKind; hint: number | null; error: string } | null;
  attempts: { range: number; ok: boolean; kind?: ErrorKind; error?: string; ms: number }[];
  window: { from: number; to: number } | null;
}

export interface BurstReport {
  calls: number;
  ok: number;
  http429: number;
  httpOther: number;
  rpcErrorCodes: Record<string, number>;
  transport: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface EndpointReport {
  url: string;
  host: string;
  family: string;
  chainId: number | null;
  latest: number | null;
  finalized: TagReport;
  safe: TagReport;
  logs: LogRangeReport;
  burst: BurstReport;
  /** Blocks behind the highest `latest` seen across all endpoints (filled by crossCheck). */
  headSkew: number | null;
  classification: Classification;
  reasons: string[];
}

/* --------------------------------------------------------------------------------------------- */
/* error parsing                                                                                  */
/* --------------------------------------------------------------------------------------------- */

export type ErrorKind = "range" | "rate" | "transient" | "unsupported" | "other";

const RATE_RE = /\b429\b|too many requests|rate.?limit|request limit|requests? per|exceeded (the )?(daily|monthly|request)|capacity|throttl/i;
const RANGE_RE =
  /block range|ranges? over [\d,]+ blocks|range (is )?too (large|wide|big|long)|range limit|exceed(s|ed)?( the)? max(imum)?( block)? range|max(imum)? block range|limit exceeded|query returned more than|too many (blocks|logs|results)|response (size|is too big)|log response size|range exceeds|block count|\b413\b|payload too large|limited to (a )?[\d,]+/i;
const TRANSIENT_RE = /temporar|internal error|try again|please retry|timeout|timed out|unavailable|bad gateway|ECONNRESET/i;
const UNSUPPORTED_RE = /method not found|not supported|unsupported|does not exist|is not available|invalid block (tag|number)|unknown block|-32601/i;

/** Classify an RPC failure in the getLogs/tag context. */
export function classifyError(e: Pick<RpcErr, "httpStatus" | "code" | "message">): ErrorKind {
  const msg = e.message ?? "";
  if (e.httpStatus === 429 || RATE_RE.test(msg)) return "rate";
  if (e.httpStatus === 413) return "range";
  if (RANGE_RE.test(msg)) return "range";
  if ((e.httpStatus !== undefined && e.httpStatus >= 500) || TRANSIENT_RE.test(msg)) return "transient";
  // -32005 is "limit exceeded" (EIP-1474); in a getLogs context with no rate wording it is the range/result cap.
  if (e.code === -32005) return "range";
  if (e.code === -32601 || UNSUPPORTED_RE.test(msg)) return "unsupported";
  return "other";
}

/**
 * Extract the provider's advertised range limit from an error message, e.g.
 * "exceed maximum block range: 5000", "block range is too large, max 1000",
 * "eth_getLogs is limited to a 10,000 range", "you can make eth_getLogs requests with up to a 2K block range".
 * Numbers that describe result counts ("query returned more than 10000 results") are ignored.
 */
export function parseRangeHint(message: string): number | null {
  if (!message) return null;
  if (/more than [\d,]+ results|[\d,]+ (results|logs)\b/i.test(message) && !/block range|range:/i.test(message)) return null;
  const patterns = [
    /(?:block range|range limit|max(?:imum)?(?: block)? range|range)[^\d\n]{0,40}?(\d[\d,]*)(\s*k)?\b/i,
    /limited to (?:a )?(\d[\d,]*)(\s*k)?\s*(?:block )?range/i,
    /up to (?:a )?(\d[\d,]*)(\s*k)?\s*block/i,
    /(?:max(?:imum)?|limit)\s*(?:is|of|=|:)?\s*(\d[\d,]*)(\s*k)?\s*blocks?/i,
    /max(?:imum)? allowed number of (?:requested )?blocks is (\d[\d,]*)(\s*k)?/i,
    /(\d[\d,]*)(\s*k)?\s*blocks?\s*(?:max|limit|range)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(message);
    if (m && m[1]) {
      let n = Number(m[1].replace(/,/g, ""));
      if (m[2] && m[2].trim().toLowerCase() === "k") n *= 1000;
      if (Number.isFinite(n) && n >= 1 && n <= 10_000_000) return n;
    }
  }
  return null;
}

/* --------------------------------------------------------------------------------------------- */
/* helpers                                                                                        */
/* --------------------------------------------------------------------------------------------- */

const DENY_HOST = [/^101\.32\./, /^172\.237\./, /^10\.0\.0\./];
const DENY_WORD = /wanton|wantos|bsc-dataseed|bsc-mainnet|bsc-rpc\.publicnode|mainnet/i;

/** Safety guard: only plausible BSC-testnet URLs; never the WANTON/WANTOS fleet, never mainnet. */
export function assertAllowedUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`probe: not a URL: ${url}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`probe: unsupported protocol ${u.protocol}`);
  if (DENY_HOST.some((re) => re.test(u.hostname))) throw new Error(`probe: host ${u.hostname} is on the deny list`);
  if (DENY_WORD.test(url)) throw new Error(`probe: ${u.hostname} looks like mainnet/WANTOS — refused`);
  if (!/test|prebsc|chapel/i.test(url) && !/^97\./.test(u.hostname))
    throw new Error(`probe: ${url} does not look like a BSC testnet endpoint (needs "test"/"prebsc"/"chapel" in the URL or a "97." host)`);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Provider family = registrable-ish domain (last two labels), so data-seed-prebsc-1/2 count as one provider. */
export function providerFamily(url: string): string {
  let h: string;
  try {
    h = new URL(url).hostname;
  } catch {
    return url;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return h;
  const parts = h.split(".");
  return parts.slice(-2).join(".");
}

export function hexToNum(v: unknown): number | null {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) return null;
  const n = Number.parseInt(v, 16);
  return Number.isSafeInteger(n) ? n : null;
}

const toHex = (n: number): string => `0x${n.toString(16)}`;

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return Math.round(s[idx] ?? 0);
}

const short = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const errText = (e: RpcErr, max = 200): string =>
  short([e.httpStatus && e.httpStatus !== 200 ? `HTTP ${e.httpStatus}` : null, e.code !== undefined ? `code ${e.code}` : null, e.message].filter(Boolean).join(" "), max);

function guarded(rpc: RpcFn): RpcFn {
  return (url, method, params) => {
    if (!READ_ONLY_METHODS.has(method)) throw new Error(`probe: method ${method} is not read-only — refused`);
    return rpc(url, method, params);
  };
}

/* --------------------------------------------------------------------------------------------- */
/* measurements                                                                                   */
/* --------------------------------------------------------------------------------------------- */

async function probeTag(rpc: RpcFn, url: string, tag: "finalized" | "safe"): Promise<TagReport> {
  const r = await rpc(url, "eth_getBlockByNumber", [tag, false]);
  if (!r.ok) return { supported: false, block: null, lag: null, error: errText(r) };
  const blk = r.result as { number?: unknown } | null;
  const n = blk ? hexToNum(blk.number) : null;
  if (n === null) return { supported: false, block: null, lag: null, error: blk === null ? "null block" : "malformed block" };
  // Read the head *after* the tag so the lag is not under-reported on a fast (sub-second) chain.
  const after = await rpc(url, "eth_blockNumber", []);
  const head = after.ok ? hexToNum(after.result) : null;
  return { supported: true, block: n, lag: head !== null ? head - n : null };
}

export async function probeLogRange(rpc: RpcFn, url: string, anchor: number, opts: ProbeOptions): Promise<LogRangeReport> {
  const to = anchor - opts.logWindowHeadMargin;
  const report: LogRangeReport = { maxAccepted: null, atLeast: false, firstRejection: null, attempts: [], window: null };
  if (to <= 0) return report;
  const ladder = [...new Set(opts.logRangeLadder)].filter((n) => n > 0).sort((a, b) => b - a);
  const tried = new Set<number>();
  const tryRange = async (range: number): Promise<RpcResult> => {
    const from = Math.max(0, to - range + 1);
    const params = [{ fromBlock: toHex(from), toBlock: toHex(to), address: opts.logAddress }];
    let r = await rpc(url, "eth_getLogs", params);
    const k = r.ok ? null : classifyError(r);
    if (k === "rate" || k === "transient") {
      await opts.sleep(opts.rateLimitBackoffMs);
      r = await rpc(url, "eth_getLogs", params);
    }
    tried.add(range);
    report.attempts.push({ range, ok: r.ok, ms: r.ms, ...(r.ok ? {} : { kind: classifyError(r), error: errText(r, 120) }) });
    return r;
  };

  const queue = [...ladder];
  while (queue.length > 0) {
    const range = queue.shift() as number;
    if (tried.has(range)) continue;
    const r = await tryRange(range);
    if (r.ok) {
      report.maxAccepted = range;
      report.atLeast = range === ladder[0];
      report.window = { from: Math.max(0, to - range + 1), to };
      break;
    }
    const kind = classifyError(r);
    const hint = parseRangeHint(r.message);
    if (!report.firstRejection) report.firstRejection = { range, kind, hint, error: errText(r) };
    // A provider-advertised limit smaller than what we tried: test it next (then continue down the ladder).
    if (hint !== null && hint < range && !tried.has(hint)) {
      const rest = queue.filter((n) => n < hint);
      queue.length = 0;
      queue.push(hint, ...rest);
    }
  }
  return report;
}

export async function probeBurst(rpc: RpcFn, url: string, opts: ProbeOptions): Promise<BurstReport> {
  const out: BurstReport = { calls: opts.burstCalls, ok: 0, http429: 0, httpOther: 0, rpcErrorCodes: {}, transport: 0, p50Ms: null, p95Ms: null };
  const lat: number[] = [];
  let left = opts.burstCalls;
  while (left > 0) {
    const n = Math.min(left, Math.max(1, opts.burstConcurrency));
    left -= n;
    const rs = await Promise.all(Array.from({ length: n }, () => rpc(url, "eth_blockNumber", [])));
    for (const r of rs) {
      lat.push(r.ms);
      if (r.ok) {
        if (hexToNum(r.result) !== null) out.ok++;
        else out.rpcErrorCodes["malformed"] = (out.rpcErrorCodes["malformed"] ?? 0) + 1;
      } else if (r.httpStatus === 429) out.http429++;
      else if (r.httpStatus !== undefined && r.httpStatus !== 200) out.httpOther++;
      else if (r.code !== undefined) out.rpcErrorCodes[String(r.code)] = (out.rpcErrorCodes[String(r.code)] ?? 0) + 1;
      else out.transport++;
    }
  }
  out.p50Ms = percentile(lat, 50);
  out.p95Ms = percentile(lat, 95);
  return out;
}

const emptyTag = (): TagReport => ({ supported: false, block: null, lag: null });
const emptyLogs = (): LogRangeReport => ({ maxAccepted: null, atLeast: false, firstRejection: null, attempts: [], window: null });
const emptyBurst = (calls: number): BurstReport => ({ calls, ok: 0, http429: 0, httpOther: 0, rpcErrorCodes: {}, transport: 0, p50Ms: null, p95Ms: null });

/** Probe one endpoint. Stops after eth_chainId if the endpoint is not chain 97. */
export async function probeEndpoint(rawRpc: RpcFn, url: string, partial: Partial<ProbeOptions> = {}): Promise<EndpointReport> {
  const opts: ProbeOptions = { ...DEFAULT_OPTIONS, ...partial };
  const rpc = guarded(rawRpc);
  const rep: EndpointReport = {
    url,
    host: hostOf(url),
    family: providerFamily(url),
    chainId: null,
    latest: null,
    finalized: emptyTag(),
    safe: emptyTag(),
    logs: emptyLogs(),
    burst: emptyBurst(opts.burstCalls),
    headSkew: null,
    classification: "unusable",
    reasons: [],
  };
  try {
    assertAllowedUrl(url);
  } catch (e) {
    rep.reasons.push((e as Error).message);
    return rep;
  }

  const cid = await rpc(url, "eth_chainId", []);
  if (!cid.ok) {
    rep.reasons.push(`eth_chainId failed: ${errText(cid)}`);
    return rep;
  }
  rep.chainId = hexToNum(cid.result);
  if (rep.chainId !== BSC_TESTNET_CHAIN_ID) {
    rep.reasons.push(`wrong chainId ${rep.chainId} (want ${BSC_TESTNET_CHAIN_ID}) — no further calls`);
    return rep;
  }

  const bn = await rpc(url, "eth_blockNumber", []);
  if (bn.ok) rep.latest = hexToNum(bn.result);
  else rep.reasons.push(`eth_blockNumber failed: ${errText(bn)}`);

  rep.finalized = await probeTag(rpc, url, "finalized");
  rep.safe = await probeTag(rpc, url, "safe");

  const anchor = rep.finalized.block ?? rep.latest;
  if (anchor !== null) rep.logs = await probeLogRange(rpc, url, anchor, opts);

  rep.burst = await probeBurst(rpc, url, opts);
  return classify(rep, opts);
}

/* --------------------------------------------------------------------------------------------- */
/* classification + recommendation                                                                */
/* --------------------------------------------------------------------------------------------- */

/** Recompute classification + reasons from the measurements (idempotent; keeps pre-IO guard reasons). */
export function classify(rep: EndpointReport, partial: Partial<ProbeOptions> = {}): EndpointReport {
  const opts: ProbeOptions = { ...DEFAULT_OPTIONS, ...partial };
  const fatal: string[] = [];
  const soft: string[] = [];
  const keep = rep.reasons.filter((r) => /deny list|refused|not a URL|unsupported protocol|does not look like|eth_chainId failed|wrong chainId|eth_blockNumber failed/.test(r));

  if (rep.chainId !== BSC_TESTNET_CHAIN_ID && keep.length === 0) fatal.push(`wrong chainId ${rep.chainId} (want ${BSC_TESTNET_CHAIN_ID})`);
  if (rep.latest === null && keep.every((r) => !r.startsWith("eth_blockNumber"))) fatal.push("no latest block");
  if (rep.chainId === BSC_TESTNET_CHAIN_ID && rep.latest !== null) {
    if (rep.logs.maxAccepted === null) {
      const smallest = rep.logs.attempts.length ? Math.min(...rep.logs.attempts.map((a) => a.range)) : null;
      fatal.push(`eth_getLogs rejected at every range${smallest !== null ? ` down to ${smallest} blocks` : ""}${rep.logs.firstRejection ? `: ${rep.logs.firstRejection.error}` : ""}`);
    } else if (rep.logs.maxAccepted < opts.minUsefulLogRange) {
      soft.push(`getLogs range only ${rep.logs.maxAccepted} blocks`);
    }
    if (!rep.finalized.supported) soft.push(`"finalized" tag unsupported${rep.finalized.error ? ` (${rep.finalized.error})` : ""} — watcher/relayer require it`);
    else if (rep.finalized.lag !== null && rep.finalized.lag < 0) soft.push(`finalized ahead of latest (lag ${rep.finalized.lag})`);
    const b = rep.burst;
    const rpcErrs = Object.values(b.rpcErrorCodes).reduce((a, n) => a + n, 0);
    if (b.ok === 0) fatal.push(`burst: 0/${b.calls} eth_blockNumber succeeded`);
    else if (b.http429 + b.httpOther + rpcErrs + b.transport > 0) {
      const codes = Object.entries(b.rpcErrorCodes).map(([c, n]) => `${c}×${n}`);
      soft.push(
        `burst errors: ${[b.http429 ? `429×${b.http429}` : null, b.httpOther ? `HTTP×${b.httpOther}` : null, ...codes, b.transport ? `transport×${b.transport}` : null].filter(Boolean).join(", ")} of ${b.calls}`,
      );
    }
    if (b.p95Ms !== null && b.p95Ms > opts.slowP95Ms) soft.push(`slow: p95 ${b.p95Ms}ms`);
    if (rep.headSkew !== null && rep.headSkew > opts.maxHeadSkew) soft.push(`head ${rep.headSkew} blocks behind the best endpoint`);
  }

  rep.reasons = [...keep, ...fatal, ...soft];
  rep.classification = keep.length + fatal.length > 0 ? "unusable" : soft.length > 0 ? "degraded" : "usable";
  return rep;
}

/**
 * One concurrent eth_blockNumber per chain-97 endpoint, so heads are comparable (the per-endpoint probes run
 * sequentially over tens of seconds on a sub-second-block chain, so their `latest` values are not).
 */
export async function headSnapshot(rawRpc: RpcFn, reports: EndpointReport[]): Promise<Record<string, number | null>> {
  const rpc = guarded(rawRpc);
  const live = reports.filter((r) => r.chainId === BSC_TESTNET_CHAIN_ID);
  const rs = await Promise.all(live.map((r) => rpc(r.url, "eth_blockNumber", [])));
  return Object.fromEntries(live.map((r, i) => {
    const x = rs[i];
    return [r.url, x && x.ok ? hexToNum(x.result) : null];
  }));
}

/** Fill headSkew from a simultaneous head snapshot (see headSnapshot) and re-classify. */
export function crossCheck(reports: EndpointReport[], heads: Record<string, number | null>, partial: Partial<ProbeOptions> = {}): EndpointReport[] {
  const vals = Object.values(heads).filter((n): n is number => n !== null);
  const best = vals.length ? Math.max(...vals) : null;
  for (const r of reports) {
    const h = heads[r.url];
    r.headSkew = best !== null && h !== undefined && h !== null && r.chainId === BSC_TESTNET_CHAIN_ID ? best - h : null;
    classify(r, partial);
  }
  return reports;
}

export interface Recommendation {
  ok: boolean;
  problems: string[];
  minProviders: number;
  selected: { env: string; url: string; family: string; maxLogRange: number | null; p95Ms: number | null; finalizedLag: number | null }[];
  maxBlockRange: number | null;
  minRpcAgreement: number;
  /** Healthy chain-97 endpoints whose only defect is eth_getLogs being disabled: fine for head/finality cross-checks, not for event scanning. */
  headOnly: string[];
  relayer: { bsc: { chainId: number; rpcUrlEnvs: string[] }; poll: { maxBlockRange: number | null } };
  relayerEnv: Record<string, string>;
  watcher: { minRpcAgreement: number; chains: { bsc: { chainId: number; rpcUrls: string[]; head: { kind: "finalized" }; maxBlockRange: number | null } } };
}

export interface RecommendOptions {
  minProviders: number;
  /** Upper cap for maxBlockRange even if every endpoint accepted more. */
  maxBlockRangeCap: number;
  envPrefix: string;
}

export const DEFAULT_RECOMMEND: RecommendOptions = { minProviders: 3, maxBlockRangeCap: 5000, envPrefix: "BSC_TESTNET_RPC_" };

/**
 * Choose ≥ minProviders usable endpoints from distinct provider families (fastest p95 first), and the
 * conservative maxBlockRange = min accepted getLogs range over the chosen set (capped).
 */
export function recommend(reports: EndpointReport[], partial: Partial<RecommendOptions> = {}): Recommendation {
  const o: RecommendOptions = { ...DEFAULT_RECOMMEND, ...partial };
  const usable = reports
    .filter((r) => r.classification === "usable")
    .sort((a, b) => (a.burst.p95Ms ?? Infinity) - (b.burst.p95Ms ?? Infinity) || (b.logs.maxAccepted ?? 0) - (a.logs.maxAccepted ?? 0));
  const seen = new Set<string>();
  const picked: EndpointReport[] = [];
  for (const r of usable) {
    if (seen.has(r.family)) continue;
    seen.add(r.family);
    picked.push(r);
  }
  const problems: string[] = [];
  if (picked.length < o.minProviders) {
    problems.push(`only ${picked.length} usable independent provider(s) (${[...seen].join(", ") || "none"}); need ≥ ${o.minProviders}`);
  }
  const ranges = picked.map((r) => r.logs.maxAccepted).filter((n): n is number => n !== null);
  const maxBlockRange = ranges.length ? Math.min(o.maxBlockRangeCap, ...ranges) : null;
  const selected = picked.map((r, i) => ({
    env: `${o.envPrefix}${i + 1}`,
    url: r.url,
    family: r.family,
    maxLogRange: r.logs.maxAccepted,
    p95Ms: r.burst.p95Ms,
    finalizedLag: r.finalized.lag,
  }));
  const minRpcAgreement = 2;
  return {
    ok: problems.length === 0,
    problems,
    minProviders: o.minProviders,
    selected,
    maxBlockRange,
    minRpcAgreement,
    headOnly: reports
      .filter((r) => r.chainId === BSC_TESTNET_CHAIN_ID && r.finalized.supported && r.burst.ok === r.burst.calls && r.logs.maxAccepted === null)
      .map((r) => r.url),
    relayer: { bsc: { chainId: BSC_TESTNET_CHAIN_ID, rpcUrlEnvs: selected.map((s) => s.env) }, poll: { maxBlockRange } },
    relayerEnv: Object.fromEntries(selected.map((s) => [s.env, s.url])),
    watcher: {
      minRpcAgreement,
      chains: { bsc: { chainId: BSC_TESTNET_CHAIN_ID, rpcUrls: selected.map((s) => s.url), head: { kind: "finalized" }, maxBlockRange } },
    },
  };
}
