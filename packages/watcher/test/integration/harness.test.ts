import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNTS, startHarness, type Harness } from "../helpers/harness.js";

describe("local two-chain harness", () => {
  let H: Harness;
  beforeAll(async () => {
    H = await startHarness();
  });
  afterAll(() => H?.stop());

  it("deploys identical bridge addresses on two local anvils with users whitelisted", async () => {
    expect(H.bsc.bridge).toBe(H.wantos.bridge);
    expect(H.bsc.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    for (const h of [H.bsc, H.wantos]) {
      const ok = await h.pub.readContract({ address: h.bridge, abi: h.abi as never, functionName: "whitelisted" as never, args: [ACCOUNTS.user1.address] as never });
      expect(ok).toBe(true);
    }
    await H.settle();
    const f = await H.bsc.pub.getBlock({ blockTag: "finalized" });
    expect(f.number).toBeGreaterThan(0n);
  });
});
