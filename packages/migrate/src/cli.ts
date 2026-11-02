/**
 * PR-8 legacy payout tool. Read-only against real chains: it never signs or sends a transaction,
 * except `drill`, which starts its own local anvil.
 *
 *   scan      --source <file.json> | --rpc-config <file.json>   --cutoff <T> --vault <0x> --bsc-chain-id <id> --out <dir>
 *   validate  <manifest.csv> [--hash <0x>]
 *   propose   <manifest.csv> --hash <0x> --timelock <0x> [--round N] [--exclude <oldKey file>] --out <dir>
 *   preflight <manifest.csv> --hash <0x> --rpc-config <old-bridge.json> --rpc <new-vault url> --vault <0x> [--data <CallScheduled payLegacyBatch calldata>]
 *   verify-call <manifest.csv> --hash <0x> --target <0x> --data <0x> --delay <sec> [--value 0] [--predecessor 0x..]
 *   reconcile <manifest.csv>... --rpc <url> --vault <0x> --from-block <n>
 *   drill     <manifest.csv>
 *
 * Exit codes: 0 ok, 1 check failed / error, 2 unknown command, 64 usage error (missing or unknown option).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createPublicClient, getAddress, http, zeroHash, type Hex, type PublicClient } from "viem";
import { runDrill, startLocalVault } from "./drill.js";
import { parseSourceJson } from "./io.js";
import { buildManifest, loadManifest, validateManifest } from "./manifest.js";
import { safeMessage } from "./redact.js";
import { MIN_DELAY, buildProposals, renderProposals, verifyScheduledCall } from "./proposal.js";
import { legacyPaidReader, preflightBatch, readLegacyPaid, reconcileLegacy } from "./reconcile.js";
import { scanLegacy } from "./scan.js";
import { checkRpcConfig, loadFromRpc, type SourceClient } from "./source-rpc.js";
import type { LegacySourceData } from "./types.js";

const json = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2) + "\n";
const client = (url: string): PublicClient => createPublicClient({ transport: http(url, { retryCount: 2 }) }) as PublicClient;
class UsageError extends Error {}
const need = (v: string | undefined, name: string): string => {
  if (!v) throw new UsageError(`--${name} is required`);
  return v;
};


async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      source: { type: "string" }, "rpc-config": { type: "string" }, cutoff: { type: "string" }, vault: { type: "string" }, "bsc-chain-id": { type: "string" },
      out: { type: "string" }, hash: { type: "string" }, rpc: { type: "string" },
      timelock: { type: "string" }, exclude: { type: "string" }, round: { type: "string" }, target: { type: "string" }, data: { type: "string" },
      delay: { type: "string" }, value: { type: "string" }, predecessor: { type: "string" }, "from-block": { type: "string" },
    },
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values: o, positionals: pos } = parsed;
  const lines = (f: string): string[] => readFileSync(f, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const fromRpcConfig = async (file: string): Promise<LegacySourceData> => {
    const raw = JSON.parse(readFileSync(file, "utf8"), (_k, v) => (typeof v === "string" && /^(0|[1-9]\d*)n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as Record<string, unknown>;
    // validate at the CLI entry too (block numbers must be real bigints, payout specs read to "latest")
    checkRpcConfig(raw);
    const rpc = raw["rpc"];
    if (typeof rpc !== "object" || rpc === null) throw new Error("rpc-config: rpc { chainId: url } is required");
    const clients: Record<number, SourceClient> = {};
    for (const [id, url] of Object.entries(rpc)) {
      if (!/^[1-9]\d*$/.test(id) || typeof url !== "string") throw new Error(`rpc-config: bad rpc entry for chain "${id}"`);
      clients[Number(id)] = client(url);
    }
    return loadFromRpc(raw, clients);
  };
  /** Every non-comment line must be a 32-byte hex key. */
  const keyLines = (f: string): string[] =>
    lines(f).map((l) => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(l)) throw new Error(`${f}: "${l}" is not a 32-byte oldKey`);
      return l.toLowerCase();
    });
  const excludeSet = (): Set<string> => new Set(o.exclude ? keyLines(o.exclude) : []);
  switch (cmd) {
    case "scan": {
      let data: LegacySourceData;
      const cutoverT = Number(need(o.cutoff, "cutoff"));
      // offline JSON is not checked against any chain: coverage of the old payouts is the preparer's responsibility
      const source = o.source ? "offline-json (NOT RPC-verified)" : "rpc";
      if (o.source) data = parseSourceJson(readFileSync(o.source, "utf8"));
      else data = await fromRpcConfig(need(o["rpc-config"], "rpc-config"));
      const r = scanLegacy(data, { cutoverT });
      const out = need(o.out, "out");
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "scan-report.json"), json(r));
      const counts: Record<string, number> = {};
      for (const e of r.entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
      process.stdout.write(json({ source, counts, duplicatesDropped: r.duplicatesDropped, orphanPayouts: r.orphanPayouts.length }));
      if (r.payable.length === 0) return 0;
      const m = buildManifest(r.payable, { bscChainId: Number(need(o["bsc-chain-id"], "bsc-chain-id")), vault: getAddress(need(o.vault, "vault")), cutoverT });
      writeFileSync(join(out, "manifest.csv"), m.csv);
      process.stdout.write(`manifest ${m.count} rows, total ${m.total} wei, hash ${m.hash}\n`);
      return 0;
    }
    case "validate": {
      const opts: Parameters<typeof validateManifest>[1] = {};
      if (o.hash) opts.expectedHash = o.hash as Hex;
      const v = await validateManifest(readFileSync(need(pos[0], "manifest"), "utf8"), opts);
      process.stdout.write(json({ ok: v.ok, hash: v.hash, count: v.count, total: v.total, errors: v.errors }));
      return v.ok ? 0 : 1;
    }
    case "propose": {
      const m = await loadManifest(readFileSync(need(pos[0], "manifest"), "utf8"), need(o.hash, "hash") as Hex);
      const ps = buildProposals(m, { timelock: getAddress(need(o.timelock, "timelock")), exclude: excludeSet() }, Number(o.round ?? 0));
      const out = need(o.out, "out");
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "proposals.json"), json(ps.map(({ entries, ...p }) => ({ ...p, oldKeys: entries.map((e) => e.oldKey) }))));
      writeFileSync(join(out, "proposals.txt"), renderProposals(m, ps));
      process.stdout.write(`${ps.length} proposals (dry run, nothing sent) -> ${out}\n`);
      return 0;
    }
    case "preflight": {
      // run inside the 48h window, BEFORE the operation becomes ready: execute is open to anyone, so a blocker
      // must be handled by cancel (whitelist or admin wallet), not by "not executing".
      const [file, hash, rpcConfig, rpcUrl] = [need(pos[0], "manifest"), need(o.hash, "hash"), need(o["rpc-config"], "rpc-config"), need(o.rpc, "rpc")];
      const vault = getAddress(need(o.vault, "vault"));
      const m = await loadManifest(readFileSync(file, "utf8"), hash as Hex);
      if (vault !== m.header.vault) throw new Error(`--vault ${vault} is not the manifest vault ${m.header.vault}`);
      const vaultClient = client(rpcUrl);
      const vaultChain = await vaultClient.getChainId();
      if (vaultChain !== m.header.bscChainId) throw new Error(`--rpc serves chain ${vaultChain}, the manifest is for chain ${m.header.bscChainId}`);
      let entries = m.entries;
      if (o.data !== undefined) {
        // the batch is exactly what was scheduled: decode the CallScheduled calldata (no re-batching by flags)
        const c = verifyScheduledCall({ target: m.header.vault, value: 0n, data: o.data as Hex, predecessor: zeroHash, delay: MIN_DELAY }, m);
        if (!c.ok) {
          process.stdout.write(json({ ok: false, blockers: c.errors.map((e) => `calldata: ${e}`), checked: 0 }));
          return 1;
        }
        entries = c.entries;
      }
      // the loader fails closed on missing / stale payout coverage and on double-captured orders
      // every payout spec of every chain goes in (BSC payouts AND WANTOS refunds)
      const old = await fromRpcConfig(rpcConfig);
      const r = await preflightBatch(entries, { isLegacyPaid: legacyPaidReader(vaultClient, vault), oldPayouts: old.payouts, orders: old.orders });
      process.stdout.write(json({ ...r, checked: entries.length }));
      return r.ok ? 0 : 1;
    }
    case "verify-call": {
      // the whitelist wallet checks against the PUBLISHED manifest, so its hash is mandatory here
      const m = await loadManifest(readFileSync(need(pos[0], "manifest"), "utf8"), need(o.hash, "hash") as Hex);
      const c = verifyScheduledCall({ target: getAddress(need(o.target, "target")), value: BigInt(o.value ?? 0), data: need(o.data, "data") as Hex, predecessor: (o.predecessor ?? zeroHash) as Hex, delay: BigInt(need(o.delay, "delay")) }, m);
      process.stdout.write(json({ ok: c.ok, count: c.count, total: c.total, errors: c.errors }));
      return c.ok ? 0 : 1;
    }
    case "reconcile": {
      const ms = await Promise.all(pos.map((f) => loadManifest(readFileSync(f, "utf8"))));
      if (ms.length === 0) throw new Error("at least one manifest is required");
      const evs = await readLegacyPaid(client(need(o.rpc, "rpc")), getAddress(need(o.vault, "vault")), BigInt(need(o["from-block"], "from-block")));
      const r = reconcileLegacy(ms, evs);
      process.stdout.write(json({ ...r, unpaid: r.unpaid.map((e) => e.oldKey) }));
      return r.ok ? 0 : 1;
    }
    case "drill": {
      const m = await loadManifest(readFileSync(need(pos[0], "manifest"), "utf8"));
      const lv = await startLocalVault();
      try {
        const r = await runDrill(lv, m);
        process.stdout.write(json(r));
        return r.reconcile.complete && r.allPaidOnChain && r.duplicateRejectedWith === "LegacyAlreadyPaid" ? 0 : 1;
      } finally {
        lv.stop();
      }
    }
    default:
      process.stderr.write("usage: migrate scan|validate|propose|preflight|verify-call|reconcile|drill (see src/cli.ts header)\n");
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`error: ${safeMessage(e)}\n`);
    process.exit(e instanceof UsageError ? 64 : 1);
  },
);
