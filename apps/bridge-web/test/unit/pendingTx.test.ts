import { describe, expect, it } from "vitest";
import { pendingKey, loadPending, savePending, type PendingTx } from "../../src/lib/pendingTx";

class Mem {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}
const A = "0x5555555555555555555555555555555555555555";
const H = `0x${"ab".repeat(32)}` as const;
const p: PendingTx = { account: A, chainId: 13555, action: "w2b", hash: H, kind: "approve" };

describe("pending-transaction locks (round-2 A1)", () => {
  it("key is account (case-insensitive) + chain + action", () => {
    expect(pendingKey(A.toUpperCase().replace("0X", "0x"), 13555, "w2b")).toBe(pendingKey(A, 13555, "w2b"));
    expect(pendingKey(A, 13555, "w2b")).not.toBe(pendingKey(A, 56, "b2w"));
  });
  it("round-trips through session storage", () => {
    const s = new Mem();
    savePending(s, { [pendingKey(A, 13555, "w2b")]: p });
    expect(loadPending(s)).toEqual({ [pendingKey(A, 13555, "w2b")]: p });
  });
  it("keeps only well-formed locks; never stores or restores a 'confirmed' outcome", () => {
    const s = new Mem();
    s.setItem(
      "bridge.pending",
      JSON.stringify({
        good: { ...p },
        badHash: { ...p, hash: "0x12" },
        badKind: { ...p, account: "0x6666666666666666666666666666666666666666", kind: "confirmed" },
        badAction: { ...p, account: "0x7777777777777777777777777777777777777777", action: "admin" },
        extra: { ...p, confirmed: true, status: "success" },
      }),
    );
    const got = loadPending(s);
    // entries are re-keyed from their own fields; extra fields dropped
    expect(Object.values(got)).toEqual([p]); // 'good' and 'extra' normalise to the same lock
    for (const v of Object.values(got)) {
      expect(Object.keys(v).sort()).toEqual(["account", "action", "chainId", "hash", "kind"]);
    }
    expect(JSON.stringify(got)).not.toMatch(/confirmed|success/);
  });
  it.each([
    ["account not an address", { account: "0x12" }],
    ["account missing", { account: undefined }],
    ["chainId a string", { chainId: "13555" }],
    ["chainId fractional", { chainId: 1.5 }],
    ["kind invalid", { kind: "confirmed" }],
    ["hash too short", { hash: "0xabc" }],
    ["hash not hex", { hash: `0x${"zz".repeat(32)}` }],
    ["action invalid", { action: "admin" }],
  ])("drops a stored lock with %s (D3)", (_n, bad) => {
    const s = new Mem();
    s.setItem("bridge.pending", JSON.stringify({ x: { ...p, ...bad } }));
    expect(loadPending(s)).toEqual({});
  });

  it("a lock is filed under its own account/chain, whatever key it was stored under (D3)", () => {
    const s = new Mem();
    const B = "0x6666666666666666666666666666666666666666";
    s.setItem("bridge.pending", JSON.stringify({ [pendingKey(A, 13555, "w2b")]: { ...p, account: B, chainId: 56 } }));
    const got = loadPending(s);
    expect(got[pendingKey(A, 13555, "w2b")]).toBeUndefined();
    expect(got[pendingKey(B, 56, "w2b")]).toEqual({ ...p, account: B, chainId: 56 });
  });

  it("never throws without storage", () => {
    const broken = {
      getItem(): string | null {
        throw new Error("x");
      },
      setItem() {
        throw new Error("x");
      },
    };
    expect(loadPending(broken)).toEqual({});
    expect(() => savePending(broken, {})).not.toThrow();
    expect(loadPending(null)).toEqual({});
  });
});
