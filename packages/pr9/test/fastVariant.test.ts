import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * PR-9 testnet-fast variant: the generator's replacement-point assertions and the independent
 * byte-level checker (scripts/make-fast-variant.mjs, scripts/check-fast-variant.mjs).
 */
const ROOT = resolve(__dirname, "../../..");

interface Entry { id: string; file: string; kind: string; old: string; new: string; count: number; oldValue: string; newValue: string }
interface Manifest { allowedChainIds: number[]; overlay: string[]; residualWindowLiterals: string[]; entries: Entry[] }
interface Gen {
  loadManifest(root?: string): Manifest;
  countOccurrences(t: string, n: string): number;
  applyManifest(files: Map<string, string>, m: Manifest): { files: Map<string, string>; applied: { id: string; count: number }[] };
  leftoverWindowLiterals(files: Map<string, string>, m: Manifest): string[];
  readMainTree(root?: string): Map<string, string>;
  readOverlay(root?: string, m?: Manifest): Map<string, string>;
  generate(main: Map<string, string>, overlay: Map<string, string>, m: Manifest): { files: Map<string, string> };
  build(root?: string): { applied: unknown[]; fileCount: number };
  table(m: Manifest): string;
}
interface Chk {
  checkTree(root?: string): { errors: string[]; changedLines: number };
  explainFile(file: string, a: string, b: string, entries: Entry[]): { errors: string[]; used: Map<string, number> };
}

let gen: Gen;
let chk: Chk;
let m: Manifest;
let main: Map<string, string>;
let overlay: Map<string, string>;
let tmp: string;

beforeAll(async () => {
  gen = (await import(pathToFileURL(join(ROOT, "scripts/make-fast-variant.mjs")).href)) as Gen;
  chk = (await import(pathToFileURL(join(ROOT, "scripts/check-fast-variant.mjs")).href)) as Chk;
  m = gen.loadManifest(ROOT);
  main = gen.readMainTree(ROOT);
  overlay = gen.readOverlay(ROOT, m);
  // private copy of the inputs: tamper tests never touch the worktree
  tmp = mkdtempSync(join(tmpdir(), "pr9-fast-"));
  for (const d of ["contracts/src", "contracts/test", "contracts/script", "contracts/fast-overlay", "scripts/fast-variant"]) cpSync(join(ROOT, d), join(tmp, d), { recursive: true });
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ALL_WINDOW_IDS = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "B1", "B2", "B3", "B4", "B5", "B6", "R1"];

describe("manifest", () => {
  it("lists every production window constant with old → new values, testnet chain ids only", () => {
    const ids = m.entries.map((e) => e.id);
    for (const id of [...ALL_WINDOW_IDS, "G1", "G2"]) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(m.allowedChainIds).toEqual([1345, 97, 31337, 31338]);
    const byId = Object.fromEntries(m.entries.map((e) => [e.id, e]));
    expect(byId.T2!.newValue).toBe("2min"); // spec: MIN_DELAY 48h → 2 min
    expect(byId.T2!.oldValue).toBe("48h");
    for (const g of ["G1", "G2"]) {
      const e = byId[g]!;
      for (const c of [1345, 97, 31337, 31338]) expect(e.new).toContain(`block.chainid == ${c}`);
      for (const c of [56, 13555]) expect(e.new).not.toContain(`== ${c}`);
      expect(e.new.startsWith(e.old.split("\n")[0]!)).toBe(true);
    }
    expect(gen.table(m).split("\n")).toHaveLength(m.entries.length + 2);
  });

  it("every src window constant of the production build is on the table (none forgotten)", () => {
    const decl = /constant (\w+) = \d+ (hours|days|minutes);/g;
    const found: string[] = [];
    for (const [f, t] of main) if (f.startsWith("src/")) for (const x of t.matchAll(decl)) found.push(`${f}:${x[1]}`);
    expect(found.length).toBe(11);
    for (const f of found) {
      const [file, name] = f.split(":");
      expect(m.entries.some((e) => e.file === file && e.old.includes(`${name} = `)), f).toBe(true);
    }
  });
});

describe("generator replacement points", () => {
  it("applies each entry exactly `count` times to the current main tree", () => {
    const { applied } = gen.applyManifest(main, m);
    expect(applied).toHaveLength(m.entries.length);
    for (const a of applied) expect(a.count).toBe(m.entries.find((e) => e.id === a.id)!.count);
  });

  it("fails when a replacement point is missing (0 occurrences)", () => {
    const f = new Map(main);
    f.set("src/BridgeBase.sol", f.get("src/BridgeBase.sol")!.replace("REFUND_DELAY = 24 hours;", "REFUND_DELAY = 25 hours;"));
    expect(() => gen.applyManifest(f, m)).toThrow(/B6: expected 1 occurrence/);
  });

  it("fails when a replacement point appears more often than declared (would over-replace)", () => {
    const f = new Map(main);
    f.set("src/BscVaultV2.sol", f.get("src/BscVaultV2.sol")! + "\n// p.releaseDelay < 6 hours \n");
    expect(() => gen.applyManifest(f, m)).toThrow(/R1: expected 1 occurrence\(s\).*found 2/);
  });

  it("fails on an unknown file and on a non-positive count", () => {
    expect(() => gen.applyManifest(main, { ...m, entries: [{ ...m.entries[0]!, file: "src/Nope.sol" }] })).toThrow(/not found/);
    expect(() => gen.applyManifest(main, { ...m, entries: [{ ...m.entries[0]!, count: 0 }] })).toThrow(/positive integer/);
  });

  it("refuses a leftover day/hour window literal the table does not cover", () => {
    const f = new Map(main);
    f.set("src/BridgeBase.sol", f.get("src/BridgeBase.sol")!.replace("uint256 public constant REFUND_DELAY = 24 hours;", "uint256 public constant REFUND_DELAY = 24 hours;\n    uint256 public constant NEW_WINDOW = 5 days;"));
    expect(() => gen.generate(f, overlay, m)).toThrow(/un-replaced window literal.*NEW_WINDOW/s);
    // comments and the allow-listed residues (UTC day, range upper bounds) are fine
    expect(gen.leftoverWindowLiterals(gen.applyManifest(main, m).files, m)).toEqual([]);
  });

  it("refuses an overlay file that would shadow a main file", () => {
    const o = new Map(overlay);
    o.set("script/Deploy.s.sol", "// shadow");
    expect(() => gen.generate(main, o, m)).toThrow(/shadow/);
  });

  it("never modifies contracts/src (pure function over a copy)", () => {
    const before = readFileSync(join(ROOT, "contracts/src/BridgeTimelock.sol"), "utf8");
    gen.generate(main, overlay, m);
    expect(readFileSync(join(ROOT, "contracts/src/BridgeTimelock.sol"), "utf8")).toBe(before);
    expect(before).toContain("MIN_DELAY = 48 hours;");
    expect(before).not.toContain("TESTNET_FAST_ONLY");
  });
});

describe("independent diff check (main vs fast)", () => {
  it("a freshly generated tree passes", () => {
    gen.build(tmp);
    const r = chk.checkTree(tmp);
    expect(r.errors).toEqual([]);
    expect(r.changedLines).toBeGreaterThanOrEqual(m.entries.length);
  });

  const tamper = (file: string, from: string, to: string) => {
    gen.build(tmp);
    const p = join(tmp, "contracts/testnet-fast", file);
    const t = readFileSync(p, "utf8");
    expect(t.includes(from)).toBe(true);
    writeFileSync(p, t.replace(from, to));
    return chk.checkTree(tmp).errors.join("\n");
  };

  it("catches a changed value (2 minutes → 1 minutes)", () => {
    expect(tamper("src/BridgeTimelock.sol", "MIN_DELAY = 2 minutes;", "MIN_DELAY = 1 minutes;")).toMatch(/unexplained change|T2/);
  });
  it("catches an unrelated code change", () => {
    expect(tamper("src/BscVaultV2.sol", "revert ParamOutOfRange(3);", "revert ParamOutOfRange(4);")).toMatch(/unexplained change/);
  });
  it("catches a removed chain-id guard", () => {
    expect(tamper("src/BridgeBase.sol", '"TESTNET_FAST_ONLY"', '"X"')).toMatch(/unexplained change|G2/);
  });
  it("catches a mainnet chain id added to the guard", () => {
    expect(tamper("src/BridgeTimelock.sol", "block.chainid == 97 ||", "block.chainid == 97 || block.chainid == 56 ||")).toMatch(/unexplained/);
  });
  it("catches a reverted (missing) substitution", () => {
    expect(tamper("src/BridgeBase.sol", "REFUND_DELAY = 3 minutes;", "REFUND_DELAY = 24 hours;")).toMatch(/B6: expected 1 use/);
  });
  it("catches an extra file and a modified overlay", () => {
    gen.build(tmp);
    writeFileSync(join(tmp, "contracts/testnet-fast/src/Extra.sol"), "// x");
    expect(chk.checkTree(tmp).errors.join("\n")).toMatch(/unexpected file/);
    gen.build(tmp);
    const p = join(tmp, "contracts/testnet-fast/script/DeployFast.s.sol");
    writeFileSync(p, readFileSync(p, "utf8").replace("block.chainid == 97 ||", "block.chainid == 56 ||"));
    expect(chk.checkTree(tmp).errors.join("\n")).toMatch(/overlay script\/DeployFast\.s\.sol differs/);
  });
  it("explainFile pairs multi-line substitution hunks line by line", () => {
    const e: Entry[] = [
      { id: "a", file: "f", kind: "window", old: "A = 1 days;", new: "A = 1 minutes;", count: 1, oldValue: "", newValue: "" },
      { id: "b", file: "f", kind: "window", old: "B = 2 days;", new: "B = 2 minutes;", count: 1, oldValue: "", newValue: "" },
    ];
    const r = chk.explainFile("f", "x\nA = 1 days;\nB = 2 days;\ny", "x\nA = 1 minutes;\nB = 2 minutes;\ny", e);
    expect(r.errors).toEqual([]);
    expect([...r.used.entries()]).toEqual([["a", 1], ["b", 1]]);
    expect(chk.explainFile("f", "A = 1 days;", "A = 9 minutes;", e).errors).toHaveLength(1);
  });
});
