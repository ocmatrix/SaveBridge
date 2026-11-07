import { describe, expect, it } from "vitest";
import { splitByChainState } from "../../src/lib/whitelist";

const A = ["0xa1", "0xa2", "0xa3", "0xa4"];
// states per chain, same order as A: index 0 = both, 1 = only BSC, 2 = only WANTOS, 3 = neither
const bsc = [true, true, false, false];
const wantos = [true, false, true, false];

describe("splitByChainState (添加：两条链都已在才排除)", () => {
  const r = splitByChainState(A, { bsc, wantos }, true);

  it("excludes only what both chains already have", () => {
    expect(r.excluded).toEqual(["0xa1"]);
    expect(r.keep).toEqual(["0xa2", "0xa3", "0xa4"]);
  });

  it("keeps an address that is on one chain only (the other chain still needs it) and says which chain has it", () => {
    expect(r.partial).toEqual([
      { address: "0xa2", sides: ["bsc"] },
      { address: "0xa3", sides: ["wantos"] },
    ]);
  });

  it("an address on neither chain is kept and not partial", () => {
    expect(r.keep).toContain("0xa4");
    expect(r.partial.map((p) => p.address)).not.toContain("0xa4");
  });
});

describe("splitByChainState (移除：两条链都已不在才排除)", () => {
  const r = splitByChainState(A, { bsc, wantos }, false);

  it("excludes only what neither chain has any more", () => {
    expect(r.excluded).toEqual(["0xa4"]);
    expect(r.keep).toEqual(["0xa1", "0xa2", "0xa3"]);
  });

  it("an address already gone from one chain is kept (partial), naming the chain where it is already gone", () => {
    expect(r.partial).toEqual([
      { address: "0xa2", sides: ["wantos"] },
      { address: "0xa3", sides: ["bsc"] },
    ]);
  });
});

describe("splitByChainState edge cases", () => {
  it("keeps the input order and handles an empty list", () => {
    expect(splitByChainState([], { bsc: [], wantos: [] }, true)).toEqual({ keep: [], excluded: [], partial: [] });
    const r = splitByChainState(["0xb2", "0xb1"], { bsc: [false, false], wantos: [false, false] }, true);
    expect(r.keep).toEqual(["0xb2", "0xb1"]);
  });

  it("refuses states that do not line up with the list (never guesses)", () => {
    expect(() => splitByChainState(["0xa1", "0xa2"], { bsc: [true], wantos: [true, true] }, true)).toThrow();
  });
});
