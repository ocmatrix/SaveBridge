/**
 * PR-9 read-only BSC testnet RPC probe.
 *
 *   pnpm probe [--out <file.json>]
 *
 * Probes every candidate endpoint sequentially (polite, small bursts), prints a table + JSON report,
 * writes the report to --out (default: <os.tmpdir()>/pr9-probe-<ts>.json — never into the repo) and exits 1
 * when fewer than 3 independent usable providers were found. The WANTON section is a template only:
 * this tool never connects to WANTON/WANTOS.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { candidateEndpoints } from "./endpoints.js";
import { crossCheck, headSnapshot, probeEndpoint, READ_ONLY_METHODS, recommend, type EndpointReport, type RpcFn, type RpcResult } from "./probe.js";

const TIMEOUT_MS = 12_000;

/** Plain-fetch JSON-RPC transport (read-only methods only). */
export const fetchRpc: RpcFn = async (url, method, params): Promise<RpcResult> => {
  if (!READ_ONLY_METHODS.has(method)) throw new Error(`refusing non-read-only method ${method}`);
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    if (Array.isArray(body)) body = body[0];
    const b = body as { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } } | null;
    if (b && typeof b === "object" && b.error) {
      const data = typeof b.error.data === "string" ? ` (${b.error.data})` : "";
      return {
        ok: false,
        ms: ms(),
        httpStatus: res.status,
        ...(typeof b.error.code === "number" ? { code: b.error.code } : {}),
        message: `${String(b.error.message ?? "error")}${data}`,
      };
    }
    if (!res.ok) return { ok: false, ms: ms(), httpStatus: res.status, message: text.slice(0, 300) || res.statusText };
    if (!b || typeof b !== "object" || !("result" in b)) return { ok: false, ms: ms(), httpStatus: res.status, message: `malformed response: ${text.slice(0, 200)}` };
    return { ok: true, ms: ms(), httpStatus: res.status, result: b.result };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    return { ok: false, ms: ms(), message: `${err.name}: ${err.message}${err.cause?.code ? ` (${err.cause.code})` : ""}` };
  }
};

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

export function renderTable(reports: EndpointReport[]): string {
  const head = ["host", "chain", "latest", "fin.lag", "safe.lag", "getLogs max", "burst ok/429/err", "p50/p95 ms", "class"];
  const w = [44, 6, 10, 8, 9, 12, 17, 12, 9];
  const rows = reports.map((r) => {
    const b = r.burst;
    const errs = b.httpOther + b.transport + Object.values(b.rpcErrorCodes).reduce((a, n) => a + n, 0);
    return [
      r.host,
      String(r.chainId ?? "-"),
      String(r.latest ?? "-"),
      r.finalized.supported ? String(r.finalized.lag) : "n/a",
      r.safe.supported ? String(r.safe.lag) : "n/a",
      r.logs.maxAccepted === null ? "none" : `${r.logs.atLeast ? "≥" : ""}${r.logs.maxAccepted}`,
      `${b.ok}/${b.http429}/${errs}`,
      `${b.p50Ms ?? "-"}/${b.p95Ms ?? "-"}`,
      r.classification,
    ];
  });
  const line = (cells: string[]) => cells.map((c, i) => pad(c, w[i] ?? 10)).join(" ");
  const out = [line(head), w.map((n) => "-".repeat(n)).join(" "), ...rows.map(line)];
  for (const r of reports) {
    if (r.reasons.length) out.push(`  ${r.host}: ${r.reasons.join("; ")}`);
    if (r.logs.firstRejection) out.push(`  ${r.host}: first getLogs rejection @${r.logs.firstRejection.range} [${r.logs.firstRejection.kind}] ${r.logs.firstRejection.error}`);
  }
  return out.join("\n");
}

export const WANTON_TEMPLATE = {
  chainId: 1345,
  access: "VPC / SSH tunnel to rpc-test only — not connected in this round",
  env: { WANTON_RPC_PRIMARY: "<http://127.0.0.1:<tunnel-port> via ssh -L to rpc-test>", WANTON_RPC_CROSSCHECK_1: "<second tunnel / VPC address>" },
  head: { kind: "confirmations", confirmations: 6 },
};

function parseOut(argv: string[]): string {
  const i = argv.indexOf("--out");
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && !v) throw new Error("--out needs a path");
  return resolve(v ?? join(tmpdir(), `pr9-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
}

async function main(): Promise<number> {
  const out = parseOut(process.argv.slice(2));
  const urls = candidateEndpoints();
  console.log(`PR-9 BSC testnet RPC probe (read-only) — ${urls.length} candidates, sequential\n`);
  const reports: EndpointReport[] = [];
  for (const url of urls) {
    process.stderr.write(`probing ${url} …\n`);
    reports.push(await probeEndpoint(fetchRpc, url));
  }
  process.stderr.write("head snapshot (1 concurrent eth_blockNumber per chain-97 endpoint) …\n");
  const heads = await headSnapshot(fetchRpc, reports);
  crossCheck(reports, heads);
  const rec = recommend(reports);

  console.log(renderTable(reports));
  console.log("\nRecommendation:");
  if (!rec.ok) for (const p of rec.problems) console.log(`  ✗ ${p}`);
  for (const s of rec.selected) console.log(`  ${s.env}=${s.url}   (${s.family}, getLogs ${s.maxLogRange}, p95 ${s.p95Ms}ms, finalized lag ${s.finalizedLag})`);
  console.log(`  maxBlockRange=${rec.maxBlockRange}  minRpcAgreement=${rec.minRpcAgreement}`);
  if (rec.headOnly.length) console.log(`  head/finality cross-check only (eth_getLogs disabled): ${rec.headOnly.join(", ")}`);
  console.log("\nrelayer config (URLs via env only):\n" + JSON.stringify(rec.relayer, null, 2));
  console.log("\nwatcher config (chains.bsc):\n" + JSON.stringify(rec.watcher, null, 2));

  console.log("\nWANTON (chainId 1345) — placeholder, NOT connected in this round:");
  console.log("  access via VPC / SSH tunnel to rpc-test, e.g. ssh -L <port>:127.0.0.1:8545 <rpc-test>");
  console.log("  export WANTON_RPC_PRIMARY=http://127.0.0.1:<port>");
  console.log("  export WANTON_RPC_CROSSCHECK_1=<second tunnel or VPC address>");
  console.log("  head: confirmations 6 — see packages/pr9/config/wanton.rpc.example.json");

  const report = { generatedAt: new Date().toISOString(), chainId: 97, headSnapshot: heads, endpoints: reports, recommendation: rec, wanton: WANTON_TEMPLATE };
  console.log("\nJSON report:\n" + JSON.stringify(report, null, 2));
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nreport written: ${out}`);
  return rec.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
