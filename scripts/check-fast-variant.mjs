#!/usr/bin/env node
// PR-9: independent byte-level check of the generated testnet-fast tree.
//
//   node scripts/check-fast-variant.mjs        exit 0 = contracts/testnet-fast differs from contracts/{src,test,script}
//                                              ONLY by the manifest's substitutions, the chain-id guards and the overlay.
//
// It does not reuse the generator: it line-diffs (LCS) every main file against its fast copy and requires
//   - the same file set (plus exactly the manifest overlay files, byte-equal to contracts/fast-overlay);
//   - every changed line to be explained by exactly one manifest entry, each entry used exactly `count` times;
//   - nothing else (no extra, missing or reordered line anywhere).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal LCS line diff → list of {op: "=", "-", "+", a?, b?}. */
export function lineDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "=", a: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", a: a[i++] });
    else out.push({ op: "+", b: b[j++] });
  }
  while (i < n) out.push({ op: "-", a: a[i++] });
  while (j < m) out.push({ op: "+", b: b[j++] });
  return out;
}

/** Groups consecutive -/+ lines into hunks {removed: string[], added: string[]}. */
export function hunks(diff) {
  const hs = [];
  let cur = null;
  for (const d of diff) {
    if (d.op === "=") {
      cur = null;
      continue;
    }
    if (!cur) hs.push((cur = { removed: [], added: [] }));
    if (d.op === "-") cur.removed.push(d.a);
    else cur.added.push(d.b);
  }
  return hs;
}

/**
 * Explains one file's hunks with manifest entries. An entry explains a hunk when
 * `removed.join("\n")` contains `old` and the hunk's added text equals removed text with old→new.
 * Multi-line entries (guards) show up as pure insertions: added lines == lines of new that are not in old.
 */
export function explainFile(file, mainText, fastText, entries) {
  const errors = [];
  const used = new Map();
  const mine = entries.filter((e) => e.file === file);
  const single = mine.filter((e) => !e.old.includes("\n"));
  const multi = mine.filter((e) => e.old.includes("\n"));
  const bump = (id, n = 1) => used.set(id, (used.get(id) ?? 0) + n);
  const fail = (h) => errors.push(`${file}: unexplained change\n    - ${h.removed.join("\n    - ")}\n    + ${h.added.join("\n    + ")}`);
  for (const h of hunks(lineDiff(mainText.split("\n"), fastText.split("\n")))) {
    if (h.removed.length === 0) {
      // guard insertion: the inserted lines must be exactly the lines a multi-line entry adds to its anchor
      const e = multi.find((x) => {
        const oldLines = x.old.replace(/\n$/, "").split("\n");
        const inserted = x.new.replace(/\n$/, "").split("\n").filter((l) => !oldLines.includes(l));
        return inserted.join("\n") === h.added.join("\n");
      });
      if (e) bump(e.id);
      else fail(h);
      continue;
    }
    if (h.removed.length !== h.added.length) {
      fail(h);
      continue;
    }
    // in-place substitutions: pair line i with line i; each pair must be explained by exactly one entry
    for (let i = 0; i < h.removed.length; i++) {
      const r = h.removed[i];
      const ad = h.added[i];
      const hits = single.filter((e) => r.includes(e.old) && r.split(e.old).join(e.new) === ad);
      if (hits.length === 1) bump(hits[0].id, r.split(hits[0].old).length - 1);
      else fail({ removed: [r], added: [ad] });
    }
  }
  return { errors, used };
}

function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, acc);
    else acc.push(relative(base, p));
  }
  return acc;
}

export function checkTree(root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, "scripts/fast-variant/manifest.json"), "utf8"));
  const fastRoot = join(root, "contracts/testnet-fast");
  const errors = [];
  if (!existsSync(fastRoot)) return { errors: ["contracts/testnet-fast missing: run node scripts/make-fast-variant.mjs"], changedLines: 0 };
  const mainFiles = ["src", "test", "script"].flatMap((t) => walk(join(root, "contracts", t)).map((f) => `${t}/${f}`));
  const fastFiles = ["src", "test", "script"].flatMap((t) => walk(join(fastRoot, t)).map((f) => `${t}/${f}`));
  const expected = new Set([...mainFiles, ...manifest.overlay]);
  for (const f of fastFiles) if (!expected.has(f)) errors.push(`unexpected file in fast tree: ${f}`);
  for (const f of expected) if (!fastFiles.includes(f)) errors.push(`missing file in fast tree: ${f}`);
  for (const f of manifest.overlay) {
    if (!fastFiles.includes(f)) continue;
    if (readFileSync(join(fastRoot, f), "utf8") !== readFileSync(join(root, "contracts/fast-overlay", f), "utf8")) errors.push(`overlay ${f} differs from contracts/fast-overlay`);
  }
  const used = new Map();
  let changedLines = 0;
  for (const f of mainFiles) {
    if (!fastFiles.includes(f)) continue;
    const a = readFileSync(join(root, "contracts", f), "utf8");
    const b = readFileSync(join(fastRoot, f), "utf8");
    if (a === b) continue;
    const r = explainFile(f, a, b, manifest.entries);
    errors.push(...r.errors);
    for (const [k, v] of r.used) used.set(k, (used.get(k) ?? 0) + v);
    changedLines += hunks(lineDiff(a.split("\n"), b.split("\n"))).reduce((s, h) => s + Math.max(h.removed.length, h.added.length), 0);
  }
  for (const e of manifest.entries) if ((used.get(e.id) ?? 0) !== e.count) errors.push(`${e.id}: expected ${e.count} use(s) in the diff, saw ${used.get(e.id) ?? 0}`);
  return { errors, changedLines, used };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = checkTree();
  if (r.errors.length) {
    console.error(`check-fast-variant: FAILED\n  ${r.errors.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`check-fast-variant: OK — fast tree = main tree + ${r.used.size} manifest entries (${r.changedLines} changed/inserted lines) + overlay`);
}
