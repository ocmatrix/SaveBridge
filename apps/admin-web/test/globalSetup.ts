import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Integration/component tests deploy PR-1 contracts from forge's out/ — build them once if missing (local only). */
export default function setup() {
  const root = resolve(__dirname, "../../..");
  if (!existsSync(resolve(root, "out/WantosBridgeV2.sol/WantosBridgeV2.json")) || !existsSync(resolve(root, "out/MockToken.sol/MockToken.json"))) {
    execFileSync("forge", ["build"], { cwd: root, stdio: "ignore" });
  }
}
