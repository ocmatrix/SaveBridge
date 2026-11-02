// Post-build gate: CSP headers, no inline scripts, no secrets / env files, no unlimited-approval markers.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { checkConnectSrc, checkCsp, checkFile, checkIndexHtml, checkInlined, checkRealConfig, parseArgs, MAX_APPROVE_PATTERNS } from "./distChecks.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { real, testnet, mode, dist: distDir } = parseArgs(process.argv.slice(2));
const dist = join(root, distDir);
const errs = [];

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const files = walk(dist);

errs.push(...checkCsp(existsSync(join(dist, "_headers")) ? readFileSync(join(dist, "_headers"), "utf8") : null));
errs.push(...checkIndexHtml(readFileSync(join(dist, "index.html"), "utf8")));
for (const f of files) errs.push(...checkFile(relative(dist, f), readFileSync(f, "utf8")));
const env = real ? loadEnv(mode, root, "VITE_") : {};
if (real) errs.push(...checkRealConfig(env, { testnet }));
if (real) {
  const bundle = files.filter((f) => f.endsWith(".js")).map((f) => readFileSync(f, "utf8")).join("\n");
  errs.push(...checkInlined(bundle, [env.VITE_WANTOS_USDT, env.VITE_BSC_USDT, env.VITE_WANTOS_BRIDGE].filter(Boolean)));
}
if (real) errs.push(...checkConnectSrc(readFileSync(join(dist, "_headers"), "utf8")));
if (real && files.some((f) => readFileSync(f, "utf8").includes("00000000000000000000000000000000000000b1"))) {
  errs.push("real build contains placeholder addresses");
}

// our own source must not mention MaxUint256 either
const srcFiles = walk(join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
for (const f of srcFiles) {
  const t = readFileSync(f, "utf8");
  for (const p of MAX_APPROVE_PATTERNS) if (p.test(t)) errs.push(`src ${relative(root, f)}: MaxUint256 marker ${p}`);
}

const size = files.reduce((n, f) => n + statSync(f).size, 0);
if (errs.length) {
  console.error("check-dist FAILED:\n  " + errs.join("\n  "));
  process.exit(1);
}
console.log(`check-dist OK: ${files.length} files, ${(size / 1024).toFixed(1)} KiB, CSP strict, no secrets / env / MaxUint256${real ? "" : " (placeholder build: inert)"}`);
