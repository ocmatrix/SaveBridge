// Mutation testing for @bridge/risk (PR-4). Every mutant is applied to a COPY of the package in a
// temp directory (never to the working tree), then the unit/fixture suites run there (anvil e2e is
// excluded for speed). Usage: node scripts/mutate.mjs [outDir]
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = resolve(process.argv[2] ?? join(tmpdir(), "risk-mutants"));

const M = [
  // rule: controlled-source ratio
  ["ratio", "engine.ts", "lhs >= ratio.total * BigInt(p.freezeBps)", "lhs > ratio.total * BigInt(p.freezeBps)"],
  ["ratio", "engine.ts", "lhs >= ratio.total * BigInt(p.auditBps)", "lhs > ratio.total * BigInt(p.auditBps)"],
  ["ratio", "engine.ts", "if (ratio.total > 0n)", "if (ratio.total >= 0n)"],
  ["ratio", "engine.ts", "(c.effective_from is null or c.effective_from <= x.block_time)", "true"],
  ["ratio", "engine.ts", "x.block_time > $2 and x.block_time <= $3`", "x.block_time >= $2 and x.block_time <= $3`"],
  ["ratio", "engine.ts", "x.block_time > $2 and x.block_time <= $3`", "x.block_time > $2 and x.block_time < $3`"],
  ["ratio", "engine.ts", "if (uncontrolled.size > 0)", "if (false)"],
  ["ratio", "engine.ts", "if (v > cv && !stopHex.has(hexOf(r.src)))", "if (v > cv)"],
  ["ratio", "engine.ts", "(uncontrolled.get(hexOf(r.to_addr))! * ctl) / tot", "uncontrolled.get(hexOf(r.to_addr))!"],
  ["ratio", "engine.ts", "where x.asset = 'USDT' and x.from_addr <> x.to_addr", "where x.asset = 'USDT'"],
  ["ratio", "engine.ts", "where x.asset = 'USDT' and x.from_addr <> x.to_addr", "where x.from_addr <> x.to_addr"],
  ["ratio", "engine.ts", "if (v > cv && ", "if (v >= cv && "],
  // rule: fresh funds (10 min)
  ["fresh", "engine.ts", "t - new Date(first).getTime() <= p.freshWindowMs", "t - new Date(first).getTime() < p.freshWindowMs"],
  ["fresh", "engine.ts", "if (order.amountWei >= p.freshMinAmount)", "if (order.amountWei > p.freshMinAmount)"],
  ["fresh", "engine.ts", "select min(x.block_time) as first", "select max(x.block_time) as first"],
  ["fresh", "engine.ts", "where x.to_addr = $1 and x.from_addr <> x.to_addr and x.block_time <= $2`", "where x.to_addr = $1 and x.from_addr <> x.to_addr`"],
  ["fresh", "engine.ts", "where x.to_addr = $1 and x.from_addr <> x.to_addr and x.block_time <= $2`", "where x.to_addr = $1 and x.block_time <= $2`"],
  ["fresh", "engine.ts", "risk_flows x ${this.minJoin(3)}", "risk_flows x ${this.minJoin(3).replace(/ and x\\.amount >= mn_x\\.mn/, \"\")}"],
  // rule: common funder
  ["funder", "engine.ts", "having count(distinct f.to_addr) >= $6", "having count(distinct f.to_addr) > $6"],
  ["funder", "engine.ts", "r.block_time > $2 and r.block_time <= $4)", "r.block_time > $2 and r.block_time <= $3)"],
  ["funder", "engine.ts", "and f.src <> all($5::bytea[]) ", ""],
  ["funder", "engine.ts", "and f.to_addr <> f.src and f.block_time > $2 and f.block_time <= $3", "and f.to_addr <> f.src and f.block_time <= $3"],
  ["funder", "engine.ts", "where o.direction = 'W2B' and o.user_addr", "where o.user_addr"],
  ["funder", "engine.ts", "if (funder) {", "if (false) {"],
  // rule: degradation → WAIT(index)
  ["index", "engine.ts", "this.now().getTime() - st.checkedAt.getTime() > p.indexStaleMs", "this.now().getTime() - st.checkedAt.getTime() >= p.indexStaleMs"],
  ["index", "engine.ts", "st.headBlock - st.lastBlock > BigInt(p.indexMaxLagBlocks)", "st.headBlock - st.lastBlock >= BigInt(p.indexMaxLagBlocks)"],
  ["index", "engine.ts", "st.lastBlock < order.srcBlockNumber", "st.lastBlock <= order.srcBlockNumber"],
  ["index", "engine.ts", "if (a.kind === \"WAIT\") return INDEX_WAIT;", "if (a.kind === \"WAIT\") return d;"],
  ["index", "engine.ts", "if (!st || st.broken)", "if (!st)"],
  ["index", "engine.ts", "if (!tr.rows[0]) return", "if (false) return"],
  // rule: combination / merge (approval scope)
  ["merge", "engine.ts", "if (order.direction !== \"W2B\" || d.kind === \"WAIT\") return d;", "if (order.direction !== \"W2B\") return d;"],
  ["merge", "engine.ts", "RANK[r.level] > RANK[acc] ? r.level : acc", "RANK[r.level] < RANK[acc] ? r.level : acc"],
  ["merge", "engine.ts", "if (d.kind === \"REVIEW\") reviews.push({ level: d.level, reason: d.reason });", ""],
  ["merge", "engine.ts", ".filter((x): x is string => !!x))].sort();", ".filter((x): x is string => !!x))];"],
  // rule: index (indexer)
  ["indexer", "indexer.ts", "src: isPair ? tf : from,", "src: from,"],
  ["indexer", "indexer.ts", "const target = head - BigInt(this.o.confirmations);", "const target = head;"],
  ["indexer", "indexer.ts", "if (lc(cur.hash) !== lc(st.lastBlockHash)) {", "if (false) {"],
  ["indexer", "indexer.ts", "if (!(await reader.txSucceeded(t.hash))) continue;", ""],
  ["indexer", "indexer.ts", "if (first && st.lastBlock >= 0n && lc(first.parentHash) !== lc(st.lastBlockHash)) {", "if (false) {"],
  ["indexer", "indexer.ts", "await t.query(\"delete from risk_flows where block_number between $1 and $2\", [from.toString(), to.toString()]);", ""],
  // Gate2 r1 A1: 0-amount / dust griefing, per-asset minimums
  ["A1", "indexer.ts", "if (amount === 0n) continue;", ""],
  ["A1", "engine.ts", "risk_flows f ${this.minJoin(7, \"f\")}", "risk_flows f ${this.minJoin(7, \"f\").replace(/ and f\\.amount >= mn_f\\.mn/, \"\")}"],
  ["A1", "engine.ts", "risk_flows x ${this.minJoin(7)}", "risk_flows x ${this.minJoin(7).replace(/ and x\\.amount >= mn_x\\.mn/, \"\")}"],
  ["A1", "engine.ts", "on mn_${alias}.asset = ${alias}.asset and", "on true and"],
  ["A1", "engine.ts", "${alias}.amount >= mn_${alias}.mn", "${alias}.amount > mn_${alias}.mn"],
  ["A1", "config.ts", "funderMinAmount: { USDT: 10n ** BigInt(usdtDecimals),", "funderMinAmount: { USDT: 1n,"],
  ["A1", "config.ts", "if (!(v > 0n)) throw", "if (v < 0n) throw"],
  ["A1", "engine.ts", "having count(distinct f.to_addr) >= $6", "having count(f.to_addr) >= $6"],
  ["A1", "engine.ts", "where x.to_addr = $1 and x.block_time > $2 and x.block_time <= $3)", "where x.to_addr = $1 and x.block_time <= $3)"],
  // r1 guards for aligner survivors
  ["ratio", "engine.ts", "const stop = [user, ZERO_ADDRESS", "const stop = [ZERO_ADDRESS"],
  ["ratio", "engine.ts", "uncontrolled.set(hexOf(r.src), v - cv)", "uncontrolled.set(hexOf(r.src), v)"],
  ["ratio", "engine.ts", "[srcs, start, end]", "[srcs, new Date(0), end]"],
  // Gate2 r1 B2: pricing = transfer amount
  ["B2", "indexer.ts", "const valueUsdt = asset === \"USDT\" ? amount : 0n;", "const valueUsdt = asset === \"USDT\" ? (isPair ? 1n : amount) : 0n;"],
  ["B2", "indexer.ts", "const valueUsdt = asset === \"USDT\" ? amount : 0n;", "const valueUsdt = amount;"],
  // r1 small fixes
  ["indexer", "indexer.ts", "lc(blocks.get(n)!.parentHash) !== lc(blocks.get(n - 1n)!.hash)", "false"],
  ["redact", "indexer.ts", "indexer tick failed: ${errText(e)}", "indexer tick failed: ${(e as Error).message}"],
  ["redact", "engine.ts", "risk assessment failed: ${errText(e)}", "risk assessment failed: ${(e as Error).message}"],
  ["pairs", "pairs.ts", "if (!Number.isInteger(expectCount) || expectCount < 1) throw", "if (false) throw"],
];

function setupCopy(dir) {
  rmSync(dir, { recursive: true, force: true });
  const p = join(dir, "packages", "risk");
  mkdirSync(p, { recursive: true });
  for (const d of ["src", "test"]) cpSync(join(pkg, d), join(p, d), { recursive: true });
  for (const f of ["package.json", "tsconfig.json"]) cpSync(join(pkg, f), join(p, f));
  cpSync(join(pkg, "..", "..", "tsconfig.base.json"), join(dir, "tsconfig.base.json"));
  symlinkSync(join(pkg, "node_modules"), join(p, "node_modules"));
  writeFileSync(
    join(p, "vitest.config.ts"),
    `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["test/e2e.test.ts"], testTimeout: 60000, fileParallelism: false } });\n`,
  );
  return p;
}

const run = (cwd) => spawnSync(join(cwd, "node_modules", ".bin", "vitest"), ["run", "--bail", "1"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const base = setupCopy(join(work, "base"));
const b0 = run(base);
if (b0.status !== 0) {
  console.error("baseline suite is not green in the copy\n" + b0.stdout + b0.stderr);
  process.exit(2);
}
const results = [];
for (const [i, [rule, file, from, to]] of M.entries()) {
  const dir = setupCopy(join(work, `m${i + 1}`));
  const f = join(dir, "src", file);
  const src = readFileSync(f, "utf8");
  const n = src.split(from).length - 1;
  if (n !== 1) {
    results.push({ id: i + 1, rule, file, from, to, status: `INVALID (${n} matches)` });
    continue;
  }
  writeFileSync(f, src.replace(from, to));
  const r = run(dir);
  const killedBy = (r.stdout.match(/FAIL\s+(\S+ > [^\n]+)/) ?? [])[1] ?? "";
  results.push({ id: i + 1, rule, file, from, to, status: r.status === 0 ? "SURVIVED" : "killed", killedBy });
  console.log(`${i + 1}\t${rule}\t${r.status === 0 ? "SURVIVED" : "killed"}\t${from.slice(0, 60)}`);
  rmSync(join(work, `m${i + 1}`), { recursive: true, force: true });
}
writeFileSync(join(work, "results.json"), JSON.stringify(results, null, 2));
const killed = results.filter((r) => r.status === "killed").length;
console.log(`\n${killed}/${results.length} killed; results in ${join(work, "results.json")}`);
if (existsSync(join(work, "base"))) rmSync(join(work, "base"), { recursive: true, force: true });
