import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config.js";
import { MultiRpc, stableStringify } from "../../src/rpc.js";

const exampleDir = join(__dirname, "../../config");

describe("config", () => {
  it("parses the shipped example (placeholders only, no real endpoints)", () => {
    const raw = JSON.parse(readFileSync(join(exampleDir, "watcher.example.json"), "utf8"));
    const cfg = parseConfig(raw);
    expect(cfg.minRpcAgreement).toBe(2);
    expect(cfg.chains.bsc.head).toEqual({ kind: "finalized" });
    expect(cfg.chains.wantos.head).toEqual({ kind: "confirmations", confirmations: 6 });
    expect(cfg.mintAlertThreshold).toBe(10_000n * 10n ** 18n);
    expect(cfg.grace).toEqual({ w2bSeconds: 300, b2wBeforeEtaSeconds: 180, refundBeforeExecSeconds: 7200, depositRefundBeforeExecSeconds: 7200 });
    for (const c of [cfg.chains.bsc, cfg.chains.wantos]) {
      expect(c.rpcUrls.length).toBeGreaterThanOrEqual(2);
      for (const u of c.rpcUrls) expect(u).toMatch(/example\.invalid/);
    }
    expect(cfg.legacyAddresses.map((l) => l.address.toLowerCase())).toContain("0x8dfd39e98f478688a41cdbe40bc544d672f0a9e3");
    expect(cfg.legacyAddresses.map((l) => l.address.toLowerCase())).toContain("0x9dab17a9ad061cbda2bef607a6a330ee74076e90");
  });

  it("rejects fewer RPCs than the agreement threshold, threshold < 2, bad addresses", () => {
    const raw = JSON.parse(readFileSync(join(exampleDir, "watcher.example.json"), "utf8"));
    expect(() => parseConfig({ ...raw, minRpcAgreement: 1 })).toThrow(/minRpcAgreement/);
    const one = structuredClone(raw);
    one.chains.bsc.rpcUrls = ["http://a.example.invalid"];
    expect(() => parseConfig(one)).toThrow(/rpcUrls/);
    const badAddr = structuredClone(raw);
    badAddr.chains.wantos.bridge = "0x123";
    expect(() => parseConfig(badAddr)).toThrow(/bridge/);
    const badHead = structuredClone(raw);
    badHead.chains.wantos.head = { kind: "latest" };
    expect(() => parseConfig(badHead)).toThrow(/head/);
  });
});

describe("MultiRpc consensus (condition ②: at least two RPCs agree)", () => {
  const mk = (answers: Array<unknown | Error>) =>
    new MultiRpc(
      "bsc",
      answers.map((a, i) => ({ label: `r${i}`, client: a as never })),
      2,
    );
  const run = (m: MultiRpc) =>
    m.consensus(async (c) => {
      const v = c as unknown;
      if (v instanceof Error) throw v;
      return v;
    });

  it("ok when two agree and none contradicts (errors ignored)", async () => {
    expect(await run(mk([{ a: 1n }, { a: 1n }]))).toMatchObject({ ok: true, value: { a: 1n }, agree: 2 });
    expect(await run(mk([{ a: 1n }, new Error("down"), { a: 1n }]))).toMatchObject({ ok: true, agree: 2 });
  });

  it("not ok when any two successful answers differ", async () => {
    const r = await run(mk([{ a: 1n }, { a: 2n }, { a: 1n }]));
    expect(r).toMatchObject({ ok: false, reason: "disagree" });
  });

  it("not ok when fewer than two answered", async () => {
    expect(await run(mk([{ a: 1n }, new Error("down")]))).toMatchObject({ ok: false, reason: "insufficient" });
  });

  it("primary falls through failing endpoints in order and throws if all fail", async () => {
    const m = mk([new Error("x"), 7]);
    expect(await m.primary(async (c) => {
      if ((c as unknown) instanceof Error) throw c;
      return c as unknown as number;
    })).toBe(7);
    await expect(mk([new Error("x"), new Error("y")]).primary(async (c) => {
      throw c;
    })).rejects.toThrow(/all 2 RPCs failed/);
  });

  it("stableStringify is key-order independent and bigint-safe", () => {
    expect(stableStringify({ b: 1n, a: [2, { d: 1, c: 2 }] })).toBe(stableStringify({ a: [2, { c: 2, d: 1 }], b: 1n }));
  });

  it("r4 item 2: dissent is a sliding window — interleaved agreements do not reset it (Z09)", async () => {
    let lie = true;
    const m = new MultiRpc("bsc", [{ label: "a", client: 1 as never }, { label: "b", client: 1 as never }, { label: "c", client: 1 as never }], 2);
    const run = () => m.consensus(async (c, label) => (label === "c" && lie ? 99 : (c as unknown as number)), "probe");
    for (let i = 0; i < 6; i++) {
      lie = true;
      await run(); // c dissents
      lie = false;
      await run(); // c agrees
    }
    expect(m.dissent.get("c")!.count).toBe(6);
    expect(m.dissent.get("c")!.last).toBe("probe");
    expect(m.dissent.get("a")?.count ?? 0).toBe(0);
  });

  it("r4 item 2: a null answer agreeing with a null majority is neutral, not an agreement (Z08)", async () => {
    let mode: "lie" | "null" = "lie";
    const m = new MultiRpc("bsc", [{ label: "a", client: 1 as never }, { label: "b", client: 1 as never }, { label: "c", client: 1 as never }], 2);
    const run = () => m.consensus(async (_c, label) => (mode === "null" ? null : label === "c" ? 99 : 1));
    for (let i = 0; i < 5; i++) await run();
    mode = "null";
    for (let i = 0; i < 30; i++) await run();
    expect(m.dissent.get("c")!.count).toBe(5); // 30 "agreements on nothing" did not flush the window
  });

  it("r4 item 2: siding with a null majority in a DISPUTED read is neutral too (Z08)", async () => {
    let phase = 1;
    const m = new MultiRpc("bsc", [{ label: "a", client: 1 as never }, { label: "b", client: 1 as never }, { label: "c", client: 1 as never }], 2);
    const run = () => m.consensus(async (_c, label) => (phase === 1 ? (label === "a" ? 99 : 1) : label === "c" ? 7 : null));
    for (let i = 0; i < 5; i++) await run(); // a dissents 5×
    phase = 2;
    for (let i = 0; i < 30; i++) await run(); // a & b answer null (the "majority"), c something else
    expect(m.dissent.get("a")!.count).toBe(5);
  });
});
