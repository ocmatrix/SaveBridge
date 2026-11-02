import { describe, expect, it } from "vitest";
import { buildManifest, loadManifest, manifestHash, validateManifest } from "../../src/manifest.js";
import { oldKey } from "../../src/oldkey.js";
import { scanLegacy } from "../../src/scan.js";
import { R, T, VAULT, fixture, manyOrders, tx } from "../helpers.js";

const basic = fixture("legacy-basic.json");
const scan = scanLegacy(basic, { cutoverT: T, alreadyPaid: new Set([oldKey(tx("5"), 0)]) });
const header = { bscChainId: 56, vault: VAULT, cutoverT: T };
const m = buildManifest(scan.payable, header);

/** Replaces one data row (0-based among rows) and returns the new CSV. */
function editRow(csv: string, row: number, f: (cols: string[]) => string[]): string {
  const lines = csv.split("\n");
  const idx = lines.findIndex((l) => l.startsWith("oldKey,")) + 1 + row;
  lines[idx] = f(lines[idx]!.split(",")).join(",");
  return lines.join("\n");
}

describe("manifest build", () => {
  it("is deterministic, sorted, hashed over the CSV text", () => {
    const again = buildManifest([...scan.payable].reverse(), header);
    expect(again.csv).toBe(m.csv);
    expect(again.hash).toBe(m.hash);
    expect(m.hash).toBe(manifestHash(m.csv));
    expect(m.count).toBe(4);
    expect(m.total).toBe(100n * 10n ** 18n + 1n + 75n * 10n ** 17n + 12_345_678n * 10n ** 12n);
    expect(m.csv).toContain("# count=4\n# total=" + m.total.toString() + "\n");
    expect(m.csv).toContain(`# vault=${VAULT}`);
    expect(m.csv).toContain("# oldKey=keccak256(abi.encode(bytes32 srcTxHash, uint256 srcLogIndex))");
    expect(m.csv).toContain(`${oldKey(tx("a"), 7)},13555,${tx("a")},7,W2B,${R(2)},${R(2)},1,0.000000000000000001`);
    // B2W is published as B2W, refunds the depositor and carries the WANTOS recipient (N11)
    expect(m.csv).toContain(`${oldKey(tx("3"), 4)},56,${tx("3")},4,B2W,${R(5)},${R(99)},12345678000000000000,12.345678`);
  });
  it("hash changes with any byte (header included)", () => {
    expect(buildManifest(scan.payable, { ...header, cutoverT: T + 1 }).hash).not.toBe(m.hash);
    expect(buildManifest(scan.payable.slice(1), header).hash).not.toBe(m.hash);
  });
  it("refuses non-PAYABLE entries and empty lists", () => {
    expect(() => buildManifest(scan.entries, header)).toThrow(/not PAYABLE/);
    expect(() => buildManifest([], header)).toThrow(/no rows/);
  });
  it("refuses two rows with the same oldKey", () => {
    const p = scan.payable[0]!;
    expect(() => buildManifest([p, { ...p }], header)).toThrow(/duplicate oldKey/);
  });
  it("handles > 100 rows", () => {
    const big = buildManifest(scanLegacy({ orders: manyOrders(250), payouts: [] }, { cutoverT: T }).payable, header);
    expect(big.count).toBe(250);
    expect(big.total).toBe(Array.from({ length: 250 }, (_, i) => BigInt(i + 1) * 10n ** 18n + 25n * 10n ** 16n).reduce((a, b) => a + b));
  });
});

describe("validateManifest", () => {
  it("accepts the published manifest and its hash; loadManifest round-trips", async () => {
    const v = await validateManifest(m.csv, { expectedHash: m.hash });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.total).toBe(m.total);
    const back = await loadManifest(m.csv, m.hash);
    expect(back.entries).toEqual(m.entries);
    expect(back.header).toEqual({ ...header });
  });
  const bad: [string, (c: string) => string, RegExp][] = [
    ["wrong published hash", (c) => c, /hash/],
    ["oldKey not matching tx/logIndex", (c) => editRow(c, 0, (f) => [f[0]!, f[1]!, f[2]!, "5", ...f.slice(4)]), /oldKey does not match/],
    ["zero recipient", (c) => editRow(c, 1, (f) => [...f.slice(0, 5), "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", ...f.slice(7)]), /zero recipient/],
    ["zero amount", (c) => editRow(c, 0, (f) => [...f.slice(0, 7), "0", "0"]), /zero amount/],
    ["amountWei vs display mismatch", (c) => editRow(c, 0, (f) => [...f.slice(0, 8), "999"]), /amount column/],
    ["changed amount breaks footer total", (c) => editRow(c, 0, (f) => [...f.slice(0, 7), "13345678000000000000", "13.345678"]), /footer total/],
    ["duplicate row", (c) => c.replace(/(\n0x[^\n]+\n)/, "$1" + c.split("\n").find((l) => l.startsWith("0x"))! + "\n"), /duplicate oldKey/],
    ["rows out of order", (c) => {
      const l = c.split("\n");
      const i = l.findIndex((x) => x.startsWith("oldKey,")) + 1;
      [l[i], l[i + 1]] = [l[i + 1]!, l[i]!];
      return l.join("\n");
    }, /not strictly sorted/],
    ["lowercase (non-checksummed) recipient", (c) => editRow(c, 0, (f) => [...f.slice(0, 5), f[5]!.toLowerCase(), ...f.slice(6)]), /checksummed/],
    ["lowercase srcRecipient", (c) => editRow(c, 0, (f) => [...f.slice(0, 6), f[6]!.toLowerCase(), ...f.slice(7)]), /checksummed/],
    ["W2B srcRecipient differs from to", (c) => editRow(c, 1, (f) => [...f.slice(0, 6), R(77), ...f.slice(7)]), /srcRecipient must equal/],
    ["B2W relabelled W2B (N11)", (c) => editRow(c, 0, (f) => [...f.slice(0, 4), "W2B", ...f.slice(5)]), /srcRecipient must equal/],
    ["second vault header (P5)", (c) => c.replace("# cutoverT=", `# vault=${R(66)}\n# cutoverT=`), /duplicate key "vault"/],
    ["header key after the column line (P5)", (c) => c.replace(/(# bscChainId=\d+\n)([\s\S]*?oldKey,srcChainId[^\n]*\n)/, "$2$1"), /after the column line/],
    ["footer before rows (P5)", (c) => c.replace(/(oldKey,srcChainId[^\n]*\n)/, "$1# count=4\n"), /before the rows|duplicate key/],
    ["footer moved above the column line (P5)", (c) => {
      const foot = c.match(/# count=[^\n]*\n# total=[^\n]*\n/)![0];
      return c.replace(foot, "").replace(/(oldKey,srcChainId)/, foot + "$1");
    }, /footer key "count" before the rows/],
    ["row after footer (P5)", (c) => c.replace(/(# count=4\n)/, "$1" + c.split("\n").find((l) => l.startsWith("0x"))! + "\n"), /malformed row/],
    ["unknown key", (c) => c.replace("# cutoverT=", "# fee=1\n# cutoverT="), /unknown key/],
    ["stray comment", (c) => c.replace("# cutoverT=", "# hello\n# cutoverT="), /unexpected comment/],
    ["CRLF line endings", (c) => c.replace(/\n/g, "\r\n"), /LF/],
    ["missing vault header", (c) => c.replace(/# vault=.*\n/, ""), /vault/],
    ["other oldKey encoding", (c) => c.replace("abi.encode(", "abi.encodePacked("), /oldKey encoding/],
    ["malformed row", (c) => c.replace("# count=", "x,y\n# count="), /malformed/],
    ["bad direction", (c) => editRow(c, 0, (f) => [...f.slice(0, 4), "XYZ", ...f.slice(5)]), /bad direction/],
    ["other amount unit", (c) => c.replace("wei (18 decimals)", "wei (6 decimals)"), /amountUnit/],
    ["bad tx hash", (c) => editRow(c, 0, (f) => [f[0]!, f[1]!, "0x12", ...f.slice(3)]), /bad srcTxHash/],
    ["bad amountWei", (c) => editRow(c, 0, (f) => [...f.slice(0, 7), "1.5", f[8]!]), /bad amountWei/],
    ["bad logIndex", (c) => editRow(c, 0, (f) => [f[0]!, f[1]!, f[2]!, "-1", ...f.slice(4)]), /bad srcLogIndex/],
    ["footer count", (c) => c.replace("# count=4", "# count=5"), /footer count/],
    ["missing title", (c) => c.replace(/^# wantos[^\n]*\n/, ""), /title/],
    ["no column header", (c) => c.replace(/oldKey,srcChainId[^\n]*\n/, ""), /column header|malformed/],
  ];
  for (const [name, mutate, re] of bad)
    it(`rejects: ${name}`, async () => {
      const v = await validateManifest(mutate(m.csv), { expectedHash: name === "wrong published hash" ? `0x${"0".repeat(64)}` : undefined });
      expect(v.ok).toBe(false);
      expect(v.errors.join("\n")).toMatch(re);
      if (name !== "wrong published hash") await expect(loadManifest(mutate(m.csv))).rejects.toThrow(/manifest invalid/);
    });
  it("an empty manifest is rejected", async () => {
    const empty = m.csv.split("\n").filter((l) => !l.startsWith("0x")).join("\n").replace("# count=4", "# count=0").replace(/# total=\d+/, "# total=0");
    expect((await validateManifest(empty)).errors.join()).toMatch(/no rows/);
  });
  it("controlled addresses (to or srcRecipient) are errors (D7)", async () => {
    expect((await validateManifest(m.csv, { controlled: [R(99).toLowerCase()] })).errors.join()).toMatch(/controlled set/);
    expect((await validateManifest(m.csv, { controlled: [R(1)] })).errors.join()).toMatch(/controlled set/);
    expect((await validateManifest(m.csv, { controlled: [R(500)] })).ok).toBe(true);
  });
});
