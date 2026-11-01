import { describe, expect, it } from "vitest";
import { remaining, whitelistState } from "../../src/lib/quota";

describe("remaining quota", () => {
  it("is cap minus used, floored at zero", () => {
    expect(remaining(2000n, 500n)).toBe(1500n);
    expect(remaining(2000n, 2000n)).toBe(0n);
    expect(remaining(2000n, 2500n)).toBe(0n); // cap tightened below today's usage
  });
});

describe("whitelistState (DESIGN §8.1)", () => {
  it("open on both chains", () => expect(whitelistState(true, true)).toBe("open"));
  it("closed on both chains", () => expect(whitelistState(false, false)).toBe("closed"));
  it("syncing when the chains disagree", () => {
    expect(whitelistState(true, false)).toBe("syncing");
    expect(whitelistState(false, true)).toBe("syncing");
  });
});
