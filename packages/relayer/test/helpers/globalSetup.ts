import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Make sure Foundry artifacts (out/*.json) exist for the anvil end-to-end tests. Local only. */
export default function setup(): void {
  const root = resolve(__dirname, "../../../..");
  if (!existsSync(resolve(root, "out/BscVaultV2.sol/BscVaultV2.json")) || process.env.RELAYER_FORCE_FORGE_BUILD) {
    execFileSync("forge", ["build"], { cwd: root, stdio: "ignore" });
  }
}
