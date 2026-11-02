/**
 * PR-9 rehearsal entry point.
 *
 *   pnpm --filter ./packages/pr9 run rehearse                                  # local, all stages, fresh run dir
 *   pnpm --filter ./packages/pr9 run rehearse -- --only roles --run-dir <dir>  # re-run one stage of an earlier run
 *   pnpm --filter ./packages/pr9 run rehearse -- --from e2e --run-dir <dir>    # resume from a stage
 *   pnpm --filter ./packages/pr9 run rehearse -- --config config/rehearse.testnet.json --authorized   (testnet; owner-authorized only)
 *
 * Fails fast: the first failed check stops the run and prints the log location. Test keys live only in
 * the run directory (outside the repository, mode 0600); destroy it after the run.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Chain, spawnAnvil } from "./chain";
import { hasCheckpoint, restoreChains, restoreOffchain, saveCheckpoint } from "./checkpoint";
import { loadConfig, rpcUrls } from "./config";
import { Ctx } from "./ctx";
import { assertTestnetAuthorized, type Side } from "./guard";
import { loadOrCreateKeys } from "./keys";
import { renderReport } from "./report";
import { STAGES, type StageName } from "./stages";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cfgPath = resolve(arg("--config") ?? join(import.meta.dirname, "../../config/rehearse.local.json"));
  const cfg = loadConfig(cfgPath);
  if (cfg.profile === "testnet") assertTestnetAuthorized(process.argv, process.env);
  const runDir = resolve(arg("--run-dir") ?? mkdtempSync(join(tmpdir(), "pr9-rehearse-")));
  if (runDir.startsWith(resolve(import.meta.dirname, "../../../.."))) throw new Error("run dir must be outside the repository (it holds test keys)");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const names = STAGES.map((s) => s.name);
  const only = arg("--only")?.split(",") as StageName[] | undefined;
  const from = arg("--from") as StageName | undefined;
  for (const n of [...(only ?? []), ...(from ? [from] : [])]) if (!names.includes(n)) throw new Error(`unknown stage ${n}; stages: ${names.join(", ")}`);
  const selected = STAGES.filter((s) => (only ? only.includes(s.name) : from ? names.indexOf(s.name) >= names.indexOf(from) : true));

  const keys = loadOrCreateKeys(join(runDir, "keys.json"));
  const chains = {} as Record<Side, Chain>;
  // re-running a stage (local): start from that stage's checkpoint, else from where the last run ended
  const first = selected[0]!.name;
  const restoreFrom = cfg.profile === "local" && (only || from) ? (hasCheckpoint(runDir, first) ? first : hasCheckpoint(runDir, "_end") ? "_end" : null) : null;
  if (restoreFrom) restoreOffchain(runDir, restoreFrom);
  if (cfg.profile === "local") {
    const genesis = Math.floor(Date.now() / 1000);
    [chains.wantos, chains.bsc] = await Promise.all([spawnAnvil("wantos", cfg.chains.wantos.chainId, genesis, cfg.localBlockTimeSec), spawnAnvil("bsc", cfg.chains.bsc.chainId, genesis, cfg.localBlockTimeSec)]);
    if (restoreFrom) {
      await restoreChains(runDir, restoreFrom, chains);
      console.log(`restored checkpoint of stage ${restoreFrom}`);
    }
    writeFileSync(join(runDir, "anvil.pids"), `${chains.wantos.proc!.pid} ${chains.bsc.proc!.pid}\n`);
  } else {
    for (const s of ["wantos", "bsc"] as Side[]) {
      chains[s] = new Chain(s, cfg.chains[s].chainId, rpcUrls(cfg, s), "testnet", null);
      await chains[s].checkChainIds();
    }
  }
  const ctx = new Ctx(cfg, runDir, chains, keys);
  console.log(`PR-9 rehearsal — profile ${cfg.profile}, wait ${cfg.waitMode}, run dir ${runDir}`);
  const t0 = Date.now();
  let failed: Error | null = null;
  try {
    for (const s of selected) {
      if (cfg.profile === "local") await saveCheckpoint(runDir, s.name, chains);
      ctx.begin(s.name);
      try {
        await s.run(ctx);
      } finally {
        const r = ctx.end();
        console.log(`── stage ${s.name}: ${r.checks.filter((c) => c.pass).length}/${r.checks.length} checks, ${(r.ms / 1000).toFixed(1)} s`);
        ctx.save();
      }
    }
  } catch (e) {
    failed = e as Error;
  } finally {
    const report = renderReport(ctx, Date.now() - t0, failed);
    writeFileSync(join(runDir, "report.md"), report);
    console.log(`\n${report}`);
    if (cfg.profile === "local") {
      await saveCheckpoint(runDir, "_end", chains).catch((e) => console.error(`could not save the end checkpoint: ${String(e)}`));
      if (!process.argv.includes("--keep-chains")) for (const c of Object.values(chains)) await c.stop();
    }
    console.log(`\nlog: ${join(runDir, "rehearse.log")}\nreport: ${join(runDir, "report.md")}`);
    console.log(`测试钥匙在 ${join(runDir, "keys.json")}（仅本机、0600）。演练结束后请销毁整个运行目录：rm -r '${runDir}'`);
  }
  if (failed) {
    console.error(`\nFAILED: ${failed.message}\nsee ${join(runDir, "rehearse.log")}`);
    process.exit(1);
  }
  if (!existsSync(runDir)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
