// Post-build gate: CSP headers, no inline scripts, no secrets / env files, no unlimited-approval markers.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCsp, checkFile, checkIndexHtml, MAX_APPROVE_PATTERNS } from "./distChecks.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const real = process.argv.includes("--real");
const errs = [];

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const files = walk(dist);

errs.push(...checkCsp(existsSync(join(dist, "_headers")) ? readFileSync(join(dist, "_headers"), "utf8") : null));
errs.push(...checkIndexHtml(readFileSync(join(dist, "index.html"), "utf8")));
for (const f of files) errs.push(...checkFile(relative(dist, f), readFileSync(f, "utf8")));
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
