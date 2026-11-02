import { bridgeTimelockAbi, bscVaultV2Abi } from "@bridge/abi";
import { decodeFunctionData, encodeFunctionData, getAddress, zeroHash, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { buildManifest } from "../../src/manifest.js";
import { MAX_LEGACY_BATCH, MIN_DELAY, buildProposals, hashOperation, legacySalt, payLegacyCalldata, renderProposals, verifyScheduledCall } from "../../src/proposal.js";
import { scanLegacy } from "../../src/scan.js";
import { R, T, TIMELOCK, VAULT, manyOrders } from "../helpers.js";

const mk = (n: number) => buildManifest(scanLegacy({ orders: manyOrders(n), payouts: [] }, { cutoverT: T }).payable, { bscChainId: 56, vault: VAULT, cutoverT: T });
const m250 = mk(250);

describe("buildProposals batching", () => {
  it.each([
    [1, [1]],
    [99, [99]],
    [100, [100]],
    [101, [100, 1]],
    [250, [100, 100, 50]],
  ])("%i rows -> batches %j", (n, sizes) => {
    const ps = buildProposals(mk(n), { timelock: TIMELOCK });
    expect(ps.map((p) => p.count)).toEqual(sizes);
    expect(ps.map((p) => p.index)).toEqual(sizes.map((_, i) => i));
  });
  it("covers every row exactly once, in manifest order, totals add up", () => {
    const ps = buildProposals(m250, { timelock: TIMELOCK });
    expect(ps.flatMap((p) => p.entries.map((e) => e.oldKey))).toEqual(m250.entries.map((e) => e.oldKey));
    expect(ps.reduce((s, p) => s + p.total, 0n)).toBe(m250.total);
    expect(ps[2]!.total).toBe(m250.entries.slice(200).reduce((s, e) => s + e.amount, 0n));
  });
  it("delay < 48h refused; longer delay kept; batches are always 100", () => {
    expect(() => buildProposals(m250, { timelock: TIMELOCK, delay: MIN_DELAY - 1n })).toThrow(/48h/);
    expect(buildProposals(m250, { timelock: TIMELOCK, delay: MIN_DELAY + 5n })[0]!.delay).toBe(MIN_DELAY + 5n);
    expect(MAX_LEGACY_BATCH).toBe(100);
  });
  it("exclude: blocked rows are left out, the rest re-batched; unknown or all-excluded refused", () => {
    const ex = new Set([m250.entries[0]!.oldKey, m250.entries[150]!.oldKey.toUpperCase().replace("0X", "0x")]);
    const ps = buildProposals(m250, { timelock: TIMELOCK, exclude: ex }, 1);
    expect(ps.map((p) => p.count)).toEqual([100, 100, 48]);
    const keys = ps.flatMap((p) => p.entries.map((e) => e.oldKey));
    expect(keys).toEqual(m250.entries.filter((_, i) => i !== 0 && i !== 150).map((e) => e.oldKey));
    expect(ps.reduce((s, p) => s + p.total, 0n)).toBe(m250.total - m250.entries[0]!.amount - m250.entries[150]!.amount);
    expect(() => buildProposals(m250, { timelock: TIMELOCK, exclude: new Set([`0x${"9".repeat(64)}`]) })).toThrow(/not in the manifest/);
    expect(() => buildProposals(m250, { timelock: TIMELOCK, exclude: new Set(m250.entries.map((e) => e.oldKey)) })).toThrow(/nothing to propose/);
    // every excluded-run batch still passes the whitelist-wallet check (subset of the manifest)
    for (const p of ps) expect(verifyScheduledCall({ target: VAULT, value: 0n, data: p.payCalldata, predecessor: zeroHash, delay: MIN_DELAY }, m250).ok).toBe(true);
  });
  it("payLegacyCalldata refuses empty or > 100", () => {
    expect(() => payLegacyCalldata([])).toThrow();
    expect(() => payLegacyCalldata(m250.entries.slice(0, 101))).toThrow();
  });
});

describe("proposal calldata", () => {
  const ps = buildProposals(m250, { timelock: TIMELOCK });
  const p = ps[1]!;
  it("payLegacyBatch args are the batch rows", () => {
    const d = decodeFunctionData({ abi: bscVaultV2Abi, data: p.payCalldata });
    expect(d.functionName).toBe("payLegacyBatch");
    const [k, to, amt] = d.args as [Hex[], Address[], bigint[]];
    expect(k).toEqual(p.entries.map((e) => e.oldKey));
    expect(to.map((a) => getAddress(a))).toEqual(p.entries.map((e) => e.to));
    expect(amt).toEqual(p.entries.map((e) => e.amount));
  });
  it("schedule / execute calldata target the vault with value 0, no predecessor, 48h", () => {
    const s = decodeFunctionData({ abi: bridgeTimelockAbi, data: p.scheduleCalldata });
    expect(s.functionName).toBe("schedule");
    expect(s.args).toEqual([VAULT, 0n, p.payCalldata, zeroHash, p.salt, MIN_DELAY]);
    const x = decodeFunctionData({ abi: bridgeTimelockAbi, data: p.executeCalldata });
    expect(x.functionName).toBe("execute");
    expect(x.args).toEqual([VAULT, 0n, p.payCalldata, zeroHash, p.salt]);
    expect(p.timelock).toBe(TIMELOCK);
  });
  it("salts are distinct per batch and per round, bound to the manifest hash; operation id = OZ hashOperation", () => {
    expect(new Set(ps.map((x) => x.salt)).size).toBe(3);
    expect(p.salt).toBe(legacySalt(m250.hash, 1));
    expect(legacySalt(m250.hash, 1, 1)).not.toBe(p.salt);
    expect(legacySalt(`0x${"0".repeat(64)}`, 1)).not.toBe(p.salt);
    expect(p.operationId).toBe(hashOperation(VAULT, 0n, p.payCalldata, zeroHash, p.salt));
    expect(buildProposals(m250, { timelock: TIMELOCK }, 2)[1]!.salt).toBe(legacySalt(m250.hash, 1, 2));
  });
  it("decoded view lists every row with its source", () => {
    const v = renderProposals(m250, ps);
    expect(v).toContain(`batches=3`);
    expect(v).toContain(`batch 2: 50 entries`);
    for (const e of m250.entries) expect(v).toContain(e.oldKey);
    expect(v).toContain(`<- 13555:${m250.entries[0]!.srcTxHash}#0 W2B`);
  });
});

describe("verifyScheduledCall (whitelist-wallet check of CallScheduled)", () => {
  const ps = buildProposals(m250, { timelock: TIMELOCK });
  const ok: { target: Address; value: bigint; data: Hex; predecessor: Hex; delay: bigint } = { target: VAULT, value: 0n, data: ps[0]!.payCalldata, predecessor: zeroHash, delay: MIN_DELAY };
  const pay = (keys: Hex[], to: Address[], amt: bigint[]) => encodeFunctionData({ abi: bscVaultV2Abi, functionName: "payLegacyBatch", args: [keys, to, amt] });
  const e0 = m250.entries[0]!;
  const e1 = m250.entries[1]!;

  it("accepts each generated batch", () => {
    for (const p of ps) {
      const c = verifyScheduledCall({ ...ok, data: p.payCalldata }, m250);
      expect(c.errors).toEqual([]);
      expect(c.total).toBe(p.total);
      expect(c.count).toBe(p.count);
    }
  });
  it("accepts a re-ordered subset of manifest rows", () => {
    expect(verifyScheduledCall({ ...ok, data: pay([e1.oldKey, e0.oldKey], [e1.to, e0.to], [e1.amount, e0.amount]) }, m250).ok).toBe(true);
  });
  const bad: [string, Partial<typeof ok>, RegExp][] = [
    ["wrong target", { target: R(999) }, /not the vault/],
    ["non-zero value", { value: 1n }, /value/],
    ["predecessor", { predecessor: `0x${"1".repeat(64)}` }, /predecessor/],
    ["short delay", { delay: MIN_DELAY - 1n }, /48h/],
    ["other function", { data: encodeFunctionData({ abi: bscVaultV2Abi, functionName: "withdraw", args: [R(1), 1n] }) }, /not payLegacyBatch/],
    ["garbage", { data: "0xdeadbeef" }, /cannot decode/],
    ["unknown oldKey", { data: pay([`0x${"9".repeat(64)}`], [e0.to], [e0.amount]) }, /not in the published manifest/],
    ["recipient swapped", { data: pay([e0.oldKey], [R(999)], [e0.amount]) }, /recipient/],
    ["amount inflated by 1 wei", { data: pay([e0.oldKey], [e0.to], [e0.amount + 1n]) }, /amount/],
    ["amount short by 1 wei (N03)", { data: pay([e0.oldKey], [e0.to], [e0.amount - 1n]) }, /amount/],
    ["recipient differs only in the last byte (N04)", { data: pay([e0.oldKey], [getAddress(`${e0.to.slice(0, 40)}${((parseInt(e0.to.slice(40), 16) + 1) % 256).toString(16).padStart(2, "0")}`.toLowerCase())], [e0.amount]) }, /recipient/],
    ["same oldKey twice", { data: pay([e0.oldKey, e0.oldKey], [e0.to, e0.to], [e0.amount, e0.amount]) }, /duplicate oldKey/],
    ["length mismatch", { data: pay([e0.oldKey, e1.oldKey], [e0.to], [e0.amount, e1.amount]) }, /lengths differ/],
    ["empty batch", { data: pay([], [], []) }, /batch size 0/],
  ];
  for (const [name, patch, re] of bad)
    it(`rejects: ${name}`, () => {
      const c = verifyScheduledCall({ ...ok, ...patch }, m250);
      expect(c.ok).toBe(false);
      expect(c.errors.join("\n")).toMatch(re);
    });
  it("rejects a 101-row call even if every row is in the manifest", () => {
    const es = m250.entries.slice(0, 101);
    const c = verifyScheduledCall({ ...ok, data: pay(es.map((e) => e.oldKey), es.map((e) => e.to), es.map((e) => e.amount)) }, m250);
    expect(c.errors.join()).toMatch(/batch size 101/);
  });
});
