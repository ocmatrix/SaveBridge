import { beforeEach, describe, expect, it } from "vitest";
import { loadKnown, saveKnown } from "../../src/lib/knownOrders";

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe("per-address remembered order ids (browser convenience only)", () => {
  let s: MemStorage;
  beforeEach(() => {
    s = new MemStorage();
  });
  const A = "0x5555555555555555555555555555555555555555";

  it("round-trips ids per address, case-insensitively", () => {
    saveKnown(s, A, { w2b: [1n, 2n], b2w: [7n] });
    expect(loadKnown(s, A.toUpperCase().replace("0X", "0x"))).toEqual({ w2b: [1n, 2n], b2w: [7n] });
    expect(loadKnown(s, "0x6666666666666666666666666666666666666666")).toEqual({ w2b: [], b2w: [] });
  });
  it("keeps the newest 50 and ignores garbage", () => {
    saveKnown(s, A, { w2b: Array.from({ length: 60 }, (_, i) => BigInt(i + 1)), b2w: [] });
    expect(loadKnown(s, A).w2b).toHaveLength(50);
    expect(loadKnown(s, A).w2b[0]).toBe(11n);
    s.setItem(`bridge.orders.${A.toLowerCase()}`, '{"w2b":["x",-1,"3"],"b2w":5}');
    expect(loadKnown(s, A)).toEqual({ w2b: [3n], b2w: [] });
  });
  it("never throws when storage is unavailable", () => {
    const broken = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    };
    expect(loadKnown(broken, A)).toEqual({ w2b: [], b2w: [] });
    expect(() => saveKnown(broken, A, { w2b: [1n], b2w: [] })).not.toThrow();
    expect(loadKnown(null, A)).toEqual({ w2b: [], b2w: [] });
  });
});
