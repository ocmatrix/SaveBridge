#!/usr/bin/env node
// PR-9 testnet-fast variant generator (build-time, never committed output).
//
//   node scripts/make-fast-variant.mjs            generate contracts/testnet-fast/ and print the table
//   node scripts/make-fast-variant.mjs --table    print the replacement table (markdown) only
//
// Copies contracts/{src,test,script} to contracts/testnet-fast/, applies the audited substitution table
// scripts/fast-variant/manifest.json (each `old` must occur exactly `count` times, otherwise it fails),
// adds the overlay (contracts/fast-overlay: DeployFast + guard tests) and refuses any leftover day/hour
// window literal in the generated sources that is not on the manifest's residual allow-list.
// contracts/src and the default foundry profile are never touched. Build with `FOUNDRY_PROFILE=fast`.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function loadManifest(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "scripts/fast-variant/manifest.json"), "utf8"));
}

export function countOccurrences(text, needle) {
  if (needle.length === 0) throw new Error("empty needle");
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Applies every manifest entry to the in-memory file map; throws on any count mismatch. */
export function applyManifest(files, manifest) {
  const out = new Map(files);
  const applied = [];
  for (const e of manifest.entries) {
    if (!Number.isInteger(e.count) || e.count < 1) throw new Error(`${e.id}: count must be a positive integer`);
    const text = out.get(e.file);
    if (text === undefined) throw new Error(`${e.id}: file ${e.file} not found`);
    const n = countOccurrences(text, e.old);
    if (n !== e.count) throw new Error(`${e.id}: expected ${e.count} occurrence(s) of ${JSON.stringify(e.old)} in ${e.file}, found ${n}`);
    out.set(e.file, text.split(e.old).join(e.new));
    applied.push({ id: e.id, file: e.file, oldValue: e.oldValue, newValue: e.newValue, count: n });
  }
  return { files: out, applied };
}

const WINDOW_LITERAL = /\b\d[\d_]*\s+(weeks|days|hours)\b/g;

/** Day/hour/week literals left in generated *source* code lines (comments ignored) that are not allow-listed. */
export function leftoverWindowLiterals(files, manifest) {
  const bad = [];
  for (const [file, text] of files) {
    if (!file.startsWith("src/")) continue;
    text.split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (!WINDOW_LITERAL.test(code)) return;
      WINDOW_LITERAL.lastIndex = 0;
      if (manifest.residualWindowLiterals.some((ok) => code.includes(ok))) return;
      bad.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  return bad;
}

function walk(dir, base = dir, acc = new Map()) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, acc);
    else acc.set(relative(base, p), readFileSync(p, "utf8"));
  }
  return acc;
}

/** contracts/{src,test,script} as a map keyed "src/...", "test/...", "script/...". */
export function readMainTree(root = ROOT) {
  const files = new Map();
  for (const top of ["src", "test", "script"]) for (const [k, v] of walk(join(root, "contracts", top))) files.set(`${top}/${k}`, v);
  return files;
}

export function readOverlay(root = ROOT, manifest = loadManifest(root)) {
  const files = new Map();
  for (const rel of manifest.overlay) files.set(rel, readFileSync(join(root, "contracts/fast-overlay", rel), "utf8"));
  return files;
}

/** Pure generation: main tree + manifest + overlay → generated tree. */
export function generate(mainFiles, overlay, manifest) {
  for (const rel of overlay.keys()) if (mainFiles.has(rel)) throw new Error(`overlay ${rel} would shadow a main file`);
  const { files, applied } = applyManifest(mainFiles, manifest);
  const leftovers = leftoverWindowLiterals(files, manifest);
  if (leftovers.length) throw new Error(`un-replaced window literal(s) in the fast sources:\n  ${leftovers.join("\n  ")}`);
  for (const [k, v] of overlay) files.set(k, v);
  return { files, applied };
}

export function table(manifest) {
  const rows = manifest.entries.map((e) => `| ${e.id} | ${e.kind} | \`${e.file}\` | ${e.oldValue} | ${e.newValue} | ${e.count} | ${e.note} |`);
  return ["| id | kind | file | old | new | count | note |", "|---|---|---|---|---|---|---|", ...rows].join("\n");
}

/** Generates <root>/contracts/testnet-fast from <root>/contracts. Returns the applied entries. */
export function build(root = ROOT) {
  const manifest = loadManifest(root);
  const { files, applied } = generate(readMainTree(root), readOverlay(root, manifest), manifest);
  const outDir = join(root, "contracts/testnet-fast");
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true }); // generated, owned by this script
  for (const [rel, text] of files) {
    const p = join(outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  cpSync(join(root, "scripts/fast-variant/manifest.json"), join(outDir, "MANIFEST.json"));
  return { manifest, applied, fileCount: files.size };
}

function main() {
  if (process.argv.includes("--table")) {
    console.log(table(loadManifest()));
    return;
  }
  const { manifest, applied, fileCount } = build();
  console.log(table(manifest));
  console.log(`\nmake-fast-variant: ${applied.length} substitutions applied (${applied.reduce((s, a) => s + a.count, 0)} occurrences), ${fileCount} files → contracts/testnet-fast/`);
  console.log("TESTNET ONLY: chain ids", manifest.allowedChainIds.join(", "), "— never deploy to WANTOS 13555 / BSC 56.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`make-fast-variant: FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
