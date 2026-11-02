import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256 as viemKeccak, toFunctionSelector, toFunctionSignature } from "viem";
import { bscVaultV2Abi, wantosBridgeV2Abi, bridgeTimelockAbi } from "@bridge/abi";
import * as oc from "../offline-check.mjs";
import vectors from "../vectors.json" with { type: "json" };

const TOOL = fileURLToPath(new URL("../offline-check.mjs", import.meta.url));
const enc = new TextEncoder();
const P = vectors.params;

describe("keccak256 (independent implementation) agrees with viem", () => {
  const inputs = [new Uint8Array(0), enc.encode("abc"), new Uint8Array(135).fill(7), new Uint8Array(136).fill(1), new Uint8Array(137).fill(255), new Uint8Array(1000).map((_, i) => i * 31)];
  for (const x of inputs) it(`len ${x.length}`, () => expect(oc.toHex(oc.keccak256(x))).toBe(viemKeccak(x)));
  it("typehashes equal PR1-NOTES §5.4", () => {
    expect(oc.DOMAIN_TYPEHASH).toBe("0x91ab3d17e3a50a9d89e63fd30b92be7f5336b03b287bb946787a83a9d62a2766"); // no chainId (contracts: WL_DOMAIN_TYPEHASH)
    expect(oc.BATCH_TYPEHASH).toBe("0x5a100c8996927acc3ae2b696188b99aa517fc144b559fc238612fc884bec2a20");
  });
});

describe("EIP-55", () => {
  it("matches viem getAddress for many addresses", () => {
    for (let i = 0; i < 200; i++) {
      const a = viemKeccak(enc.encode(`a${i}`)).slice(0, 42);
      expect(oc.toChecksum(a)).toBe(getAddress(a));
    }
  });
  it("rejects a wrong checksum, accepts all-lower / all-upper", () => {
    expect(oc.checkField("0x9dAb17a9Ad061cbDA2BeF607A6A330EE74076E90").address).toBe("0x9dab17a9ad061cbda2bef607a6a330ee74076e90");
    expect(oc.checkField("0x9dab17a9Ad061cbDA2BeF607A6A330EE74076E90").reason).toBe("checksum");
    expect(oc.checkField("0x9DAB17A9AD061CBDA2BEF607A6A330EE74076E90").address).toBeDefined();
    expect(oc.checkField("0x" + "0".repeat(40)).reason).toBe("zero");
    expect(oc.checkField("9dab17a9ad061cbda2bef607a6a330ee74076e90").reason).toBe("format");
    expect(oc.checkField("0x9dab17a9ad061cbda2bef607a6a330ee74076e9g").reason).toBe("format");
  });
});

describe("shared test vectors (same file is used by apps/admin-web)", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const p = oc.parseAddressList(c.text);
      expect(p).toEqual(c.expect);
      const r = oc.computeBatches(c.text, { ...P, allowed: c.allowed, contract: P.contract, batchSize: c.batchSize });
      if (c.expect.errors.length > 0 || c.expect.addresses.length === 0) {
        expect(r.ok).toBe(false);
        expect(r.batches).toEqual([]);
        return;
      }
      expect(r.ok).toBe(true);
      expect(r.batches.map((b) => ({ count: b.count, listHash: b.listHash, bsc: pick(b.bsc), wantos: pick(b.wantos) }))).toEqual(c.batches);
    });
  }
  const pick = (x) => ({ nonce: x.nonce, domainHash: x.domainHash, messageHash: x.messageHash, digest: x.digest });
});

describe("rules", () => {
  it("chunk bounds", () => {
    expect(() => oc.chunk([], 0)).toThrow();
    expect(() => oc.chunk([], 501)).toThrow();
    expect(() => oc.chunk([], 1.5)).toThrow();
    expect(oc.chunk(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
    expect(oc.chunk(["a"])).toEqual([["a"]]);
  });
  it("listHash of empty and single list matches viem abi.encode", () => {
    for (const l of [[], ["0x0000000000000000000000000000000000000001"]]) expect(oc.listHash(l)).toBe(viemKeccak(encodeAbiParameters([{ type: "address[]" }], [l])));
  });
  it("1200 addresses → 3 batches of ≤500, each strictly increasing", () => {
    const text = Array.from({ length: 1200 }, (_, i) => viemKeccak(enc.encode(`x${i}`)).slice(0, 42)).join("\n");
    const r = oc.computeBatches(text, { allowed: true, contract: P.contract });
    expect(r.batches.map((b) => b.count)).toEqual([500, 500, 200]);
    for (const b of r.batches) for (let i = 1; i < b.addresses.length; i++) expect(BigInt(b.addresses[i]) > BigInt(b.addresses[i - 1])).toBe(true);
    expect(r.batches[0].bsc.messageHash).toBeUndefined(); // no nonce/deadline given
  });
  it("messageHash rejects count beyond uint32; word rejects out-of-range", () => {
    expect(() => oc.messageHash({ listHash: "0x" + "0".repeat(64), count: 2 ** 32, allowed: true, nonce: 0, deadline: 0 })).toThrow();
    expect(() => oc.word(-1n)).toThrow();
    expect(() => oc.word(1n << 256n)).toThrow();
    expect(() => oc.fromHex("0x1")).toThrow();
    expect(() => oc.fromHex("zz")).toThrow();
  });
});

describe("decode", () => {
  const all = [...bscVaultV2Abi, ...wantosBridgeV2Abi, ...bridgeTimelockAbi].filter((x) => x.type === "function");
  it("every signature in the tool's table exists in the contract ABIs", () => {
    const abiSel = new Set(all.map((f) => toFunctionSelector(toFunctionSignature(f))));
    for (const s of Object.keys(oc.SELECTORS)) expect(abiSel.has(s), oc.SELECTORS[s]).toBe(true);
  });
  it("decodes a timelock schedule(setParams) proposal including the inner call", () => {
    const inner = encodeFunctionData({ abi: bscVaultV2Abi, functionName: "setParams", args: [{ dailyCap: 1n, perAddrDailyCap: 2n, largeThreshold: 3n, releaseDelay: 4n, minDeposit: 5n, maxDepositPerTx: 6n }] });
    const outer = encodeFunctionData({ abi: bridgeTimelockAbi, functionName: "schedule", args: [P.contract, 0n, inner, "0x" + "0".repeat(64), "0x" + "1".repeat(64), 172800n] });
    const d = oc.decodeCalldata(outer);
    expect(d.signature).toBe("schedule(address,uint256,bytes,bytes32,bytes32,uint256)");
    expect(d.args[0].value).toBe(P.contract);
    expect(d.args[5].value).toBe("172800");
    expect(d.args[2].inner.signature).toBe("setParams((uint256,uint256,uint256,uint256,uint256,uint256))");
    expect(d.args[2].inner.args[0].value).toEqual(["1", "2", "3", "4", "5", "6"]);
  });
  it("decodes scheduleBatch with role labels, arrays and bools", () => {
    const relayer = viemKeccak(enc.encode("RELAYER_ROLE"));
    const c1 = encodeFunctionData({ abi: bscVaultV2Abi, functionName: "grantRole", args: [relayer, P.contract] });
    const c2 = encodeFunctionData({ abi: bscVaultV2Abi, functionName: "voidSourceBatch", args: [[1n, 2n]] });
    const outer = encodeFunctionData({ abi: bridgeTimelockAbi, functionName: "scheduleBatch", args: [[P.contract, P.contract], [0n, 0n], [c1, c2], "0x" + "0".repeat(64), "0x" + "2".repeat(64), 172800n] });
    const d = oc.decodeCalldata(outer);
    expect(d.args[2].inner[0].args[0].label).toBe("RELAYER_ROLE");
    expect(d.args[2].inner[1].args[0].value).toEqual(["1", "2"]);
    const wb = oc.decodeCalldata(encodeFunctionData({ abi: bscVaultV2Abi, functionName: "applyWhitelistBatch", args: [[P.contract], false, 1n, 2n, "0xabcd"] }));
    expect(wb.args.map((a) => a.value)).toEqual([[P.contract], false, "1", "2", "0xabcd"]);
    expect(oc.runCli(["--decode", outer], () => "").out).toContain("RELAYER_ROLE");
  });
  it("unknown / short calldata", () => {
    expect(oc.decodeCalldata("0x12345678").signature).toBeNull();
    expect(() => oc.decodeCalldata("0x12")).toThrow();
    expect(() => oc.decodeCalldata(toFunctionSelector("transferAdmin(address)"))).toThrow(/太短/);
    expect(oc.runCli(["--decode", "0x12345678"], () => "").code).toBe(1);
  });
});

describe("CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-"));
  const file = join(dir, "list.csv");
  writeFileSync(file, vectors.cases[0].text);
  const base = [file, "--action", "add", "--contract", P.contract, "--bsc-chain-id", "31338", "--wantos-chain-id", "31337", "--bsc-nonce", "3", "--wantos-nonce", "7", "--deadline", "1800000000"];
  const v = vectors.cases[0].batches[0];

  it("prints the same hashes as the vectors (real process, no network)", () => {
    const out = execFileSync(process.execPath, [TOOL, ...base, "--list"], { encoding: "utf8" });
    for (const h of [v.listHash, v.bsc.domainHash, v.bsc.messageHash, v.bsc.digest, v.wantos.domainHash, v.wantos.messageHash, v.wantos.digest]) expect(out).toContain(h);
    expect(out).toContain(getAddress(vectors.cases[0].expect.addresses[1]));
  });
  it("--expect-list-hash: match exits 0, mismatch exits 2", () => {
    expect(spawnSync(process.execPath, [TOOL, ...base, "--expect-list-hash", v.listHash]).status).toBe(0);
    const bad = spawnSync(process.execPath, [TOOL, ...base, "--expect-list-hash", "0x" + "ab".repeat(32)], { encoding: "utf8" });
    expect(bad.status).toBe(2);
    expect(bad.stdout).toContain("不要签名");
  });
  it("--json, errors, usage", () => {
    const j = oc.runCli([...base, "--json"], () => vectors.cases[0].text);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out).batches[0].listHash).toBe(v.listHash);
    expect(oc.runCli([...base, "--json", "--expect-list-hash", "0x" + "00".repeat(32)], () => vectors.cases[0].text).code).toBe(2);
    const e = oc.runCli(base, () => vectors.cases[2].text);
    expect(e.code).toBe(1);
    expect(e.out).toContain("第 2 行");
    expect(oc.runCli([...base, "--json"], () => vectors.cases[2].text).code).toBe(1);
    expect(oc.runCli(base, () => "address\n").out).toContain("没有地址");
    const dup = oc.runCli([file, "--action", "remove", "--contract", P.contract, "--bsc-nonce", "1", "--wantos-nonce", "1", "--deadline", "9"], () => vectors.cases[1].text);
    expect(dup.code).toBe(0);
    expect(dup.out).toContain("第 7 行与第 4 行重复");
    const errProc = spawnSync(process.execPath, [TOOL, join(dir, "missing.txt"), "--action", "add", "--contract", P.contract, "--bsc-nonce", "0", "--wantos-nonce", "0", "--deadline", "1"], { encoding: "utf8" });
    expect(errProc.status).toBe(1);
  });

  it("fail-closed argument parsing: every malformed invocation exits 64 (no hash printed as if OK)", () => {
    const H = "0x" + "de".repeat(32);
    const bad = [
      [],
      [...base.slice(1)], // no file
      [...base, "extra.txt"], // two files
      [...base, `--expect-list-hash=${H}`],
      [...base, "--expect-listhash", H], // typo → unknown option
      [...base, "--expect-list-hash", ""],
      [...base, "--expect-list-hash", "0xdead"],
      [...base, "--expect-list-hash"],
      [...base, "--expect-list-hash", "--json"],
      [...base, "--bsc-chain-id", "0"],
      [...base, "--wantos-chain-id", "-1"],
      [...base, "--batch-size", "500"], // option removed: the batch size is fixed at 500
      [...base, "--batch", "0"],
      [...base, "--batch", "1.5"],
      [...base, "--batch", "9"], // out of range
      [...base, "--deadline", "2"], // duplicate
      [...base, "-x"],
      [file, "--action", "x", "--contract", P.contract, "--bsc-nonce", "1", "--wantos-nonce", "1", "--deadline", "1"],
      [file, "--action", "add", "--contract", "0x1", "--bsc-nonce", "1", "--wantos-nonce", "1", "--deadline", "1"],
      [file, "--action", "add", "--contract", P.contract, "--wantos-nonce", "1", "--deadline", "1"], // missing bsc nonce
      [file, "--action", "add", "--contract", P.contract, "--bsc-nonce", "1", "--deadline", "1"], // missing wantos nonce
      [file, "--action", "add", "--contract", P.contract, "--bsc-nonce", "1", "--wantos-nonce", "1"], // missing deadline
      [file, "--action", "add", "--contract", P.contract, "--bsc-nonce", "", "--wantos-nonce", "1", "--deadline", "1"],
      [file, "--action", "add", "--contract", P.contract, "--bsc-nonce", "1", "--wantos-nonce", "1", "--deadline", "1e9"],
      [file, "--action"],
      ["--decode", "0x8456cb59", "--action", "add"],
      ["--decode", "0x8456cb59", "x.txt"],
      ["--decode", ""],
      ["--decode", "  "],
    ];
    for (const argv of bad) {
      const r = oc.runCli(argv, () => vectors.cases[0].text);
      expect(r.code, JSON.stringify(argv)).toBe(64);
      expect(r.out).not.toContain("messageHash");
    }
    // the error says why (the "=" form is called out, not reported as an unknown option)
    expect(oc.runCli([...base, `--expect-list-hash=${H}`], () => "").out).toContain("不支持的写法");
    expect(oc.runCli([...base, "--expect-listhash", H], () => "").out).toContain("未知选项");
    // the same through a real process
    expect(spawnSync(process.execPath, [TOOL, ...base, `--expect-list-hash=${H}`]).status).toBe(64);
    expect(oc.runCli(["--decode", "0x8456cb59", "--json"], () => "").code).toBe(0);
    expect(oc.runCli(["-", "--action", "add", "--contract", P.contract, "--bsc-nonce", "1", "--wantos-nonce", "1", "--deadline", "1"], () => vectors.cases[0].text).code).toBe(0);
  });

  it("--batch K: only batch K, with the given nonce (no +i); multi-batch --expect requires --batch; text and --json agree", () => {
    const addrs = Array.from({ length: 1001 }, (_, i) => viemKeccak(enc.encode(`bk${i}`)).slice(0, 42));
    const text = addrs.join("\n");
    const sorted = oc.parseAddressList(text).addresses;
    const lh = [0, 1, 2].map((k) => oc.listHash(sorted.slice(k * 500, k * 500 + 500)));
    const msg = (k, nonce, chainId) => oc.messageHash({ listHash: lh[k], count: k === 2 ? 1 : 500, allowed: true, nonce, deadline: 1800000000 });
    const args = (extra, bn = "3", wn = "7") => [file, "--action", "add", "--contract", P.contract, "--bsc-chain-id", "31338", "--wantos-chain-id", "31337", "--bsc-nonce", bn, "--wantos-nonce", wn, "--deadline", "1800000000", ...extra];
    // without --batch: batch 2 uses nonce 3+1 / 7+1
    const all = JSON.parse(oc.runCli(args(["--json"]), () => text).out);
    expect(all.batches.map((b) => b.count)).toEqual([500, 500, 1]);
    expect(all.batches[1].bsc.messageHash).toBe(msg(1, 4));
    expect(all.batches[1].wantos.messageHash).toBe(msg(1, 8));
    // with --batch 2: nonce used as given (3 / 7), only that batch
    const ob = JSON.parse(oc.runCli(args(["--batch", "2", "--json"]), () => text).out);
    expect(ob.batches.length).toBe(1);
    expect(ob.batches[0].index).toBe(1);
    expect(ob.batches[0].bsc.nonce).toBe("3");
    expect(ob.batches[0].bsc.messageHash).toBe(msg(1, 3));
    expect(ob.batches[0].wantos.messageHash).toBe(msg(1, 7));
    // --batch equal to the last batch is accepted; one past it is not
    const last = JSON.parse(oc.runCli(args(["--batch", "3", "--json"]), () => text).out);
    expect(last.batches[0].count).toBe(1);
    expect(last.batches[0].listHash).toBe(lh[2]);
    expect(oc.runCli(args(["--batch", "3"]), () => text).code).toBe(0);
    expect(oc.runCli(args(["--batch", "4"]), () => text).code).toBe(64);
    // multi-batch + expect without --batch → 64 (text and json)
    expect(oc.runCli(args(["--expect-list-hash", lh[1]]), () => text).code).toBe(64);
    expect(oc.runCli(args(["--expect-list-hash", lh[1], "--json"]), () => text).code).toBe(64);
    // with --batch: hit → 0 in both modes, another batch's hash → 2 in both modes
    for (const json of [[], ["--json"]]) {
      expect(oc.runCli(args(["--batch", "2", "--expect-list-hash", lh[1], ...json]), () => text).code).toBe(0);
      expect(oc.runCli(args(["--batch", "2", "--expect-list-hash", lh[0], ...json]), () => text).code).toBe(2);
    }
    expect(oc.runCli(args(["--batch", "2", "--expect-list-hash", lh[1]]), () => text).out).toContain("只核对第 2/3 批");
    expect(oc.computeBatches(text, { allowed: true, contract: P.contract, batch: 4 }).ok).toBe(false);
  });

  it("exactly two batches: --expect-list-hash without --batch → 64; single batch without --batch is fine", () => {
    const two = Array.from({ length: 501 }, (_, i) => viemKeccak(enc.encode(`tw${i}`)).slice(0, 42)).join("\n");
    const one = Array.from({ length: 500 }, (_, i) => viemKeccak(enc.encode(`tw${i}`)).slice(0, 42)).join("\n");
    const args = (h) => [file, "--action", "add", "--contract", P.contract, "--bsc-nonce", "1", "--wantos-nonce", "1", "--deadline", "9", "--expect-list-hash", h];
    const lh2 = oc.listHash(oc.parseAddressList(two).addresses.slice(0, 500));
    expect(oc.runCli(args(lh2), () => two).code).toBe(64);
    expect(oc.runCli([...args(lh2), "--json"], () => two).code).toBe(64);
    expect(oc.runCli([...args(lh2), "--batch", "1"], () => two).code).toBe(0);
    const lh1 = oc.listHash(oc.parseAddressList(one).addresses);
    expect(oc.runCli(args(lh1), () => one).code).toBe(0);
  });
});
