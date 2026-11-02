import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Chain } from "./chain";
import type { Side } from "./guard";

/**
 * Local-profile stage checkpoints: at the start of every stage both anvils' full state (anvil_dumpState)
 * plus the run's state.json, watcher state and relayer databases are saved, so a single stage can be
 * re-run later from exactly the same starting point (`--only <stage>` / `--from <stage>`).
 */
const OFFCHAIN = (runDir: string): string[] => readdirSync(runDir).filter((n) => n === "state.json" || n === "watcher" || n.startsWith("relayer-pg"));

export function checkpointDir(runDir: string, stage: string): string {
  return join(runDir, "checkpoints", stage);
}

export function hasCheckpoint(runDir: string, stage: string): boolean {
  return existsSync(join(checkpointDir(runDir, stage), "bsc.hex"));
}

export async function saveCheckpoint(runDir: string, stage: string, chains: Record<Side, Chain>): Promise<void> {
  const dir = checkpointDir(runDir, stage);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "offchain"), { recursive: true });
  for (const s of ["wantos", "bsc"] as Side[]) writeFileSync(join(dir, `${s}.hex`), await chains[s].rpc<string>("anvil_dumpState"));
  for (const n of OFFCHAIN(runDir)) cpSync(join(runDir, n), join(dir, "offchain", n), { recursive: true });
}

/** Restores the off-chain part (call before the run context is created). */
export function restoreOffchain(runDir: string, stage: string): void {
  const src = join(checkpointDir(runDir, stage), "offchain");
  for (const n of OFFCHAIN(runDir)) rmSync(join(runDir, n), { recursive: true, force: true });
  for (const n of readdirSync(src)) cpSync(join(src, n), join(runDir, n), { recursive: true });
}

/** Loads the chain part into freshly spawned (empty) anvils. */
export async function restoreChains(runDir: string, stage: string, chains: Record<Side, Chain>): Promise<void> {
  for (const s of ["wantos", "bsc"] as Side[]) await chains[s].rpc("anvil_loadState", [readFileSync(join(checkpointDir(runDir, stage), `${s}.hex`), "utf8").trim()]);
  // anvil resumes from the wall clock after a load (time would run backwards): continue from the saved head, both chains aligned
  // (interval-mining anvils may mine in between: retry with a fresh head)
  for (let attempt = 0; ; attempt++) {
    try {
      const t = Math.max(Math.floor(Date.now() / 1000) * (attempt > 0 ? 1 : 0), ...(await Promise.all((["wantos", "bsc"] as Side[]).map(async (s) => (await chains[s].latest()).timestamp)))) + 2 + attempt * 5;
      for (const s of ["wantos", "bsc"] as Side[]) await chains[s].setNextTimestamp(t);
      return;
    } catch (e) {
      if (attempt >= 5) throw e;
    }
  }
}
