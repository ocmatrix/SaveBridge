/**
 * GATE2 round 3 regressions (aligner POC-M1/M2/E/J/L/F/G + mutation gaps). Each test asserts the desired
 * behaviour; the POCs were red on the round-2 HEAD.
 */
import { bridgeTimelockAbi } from "@bridge/abi";
import { type Abi, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNTS, E, startHarness, type Harness } from "../helpers/harness.js";
import { fakeLog, honest, injector, injectorAt, logRewriter, makeWatcher, stalledNode, tamperedClient } from "../helpers/watcher.js";

describe("round-3 hardening", () => {
  let H: Harness;
  beforeAll(async () => {
    H = await startHarness();
  });
  afterAll(() => H?.stop());
  beforeEach(async () => {
    await H.reset();
  });
  const forge = (nonce: bigint) => H.bsc.write(ACCOUNTS.relayer, "release", [nonce, ACCOUNTS.user2.address, E(50)]);
  const three = (liar: ReturnType<typeof honest>, label = "liar") => [{ label: "a", client: H.bsc.pub }, { label: "b", client: honest(H.bsc) }, { label, client: liar }];

  describe("A-1: confirmations count distinct RPCs, not entries", () => {
    it("POC-M1: one RPC returning a fabricated Unpaused TWICE does not acknowledge a forged payout", async () => {
      let X: bigint | null = null;
      const liar = injectorAt(H.bsc, () => H.bsc.bridge, () => fakeLog(H.bsc.abi as Abi, "Unpaused", () => ACCOUNTS.admin.address), () => X !== null, { times: 2, fixedTx: `0x${"ab".repeat(32)}` });
      const t = await makeWatcher(H, { endpoints: { bsc: three(liar) } });
      const r = await forge(22n);
      await H.bsc.increaseTime(400);
      X = (await H.bsc.latest()).number;
      await H.settle();
      t.clock.now = r.timestamp + 500;
      await t.w.tick();
      expect(t.w.state.derived.bsc.lastUnpaused).toBeNull();
      expect(await H.isPaused("bsc")).toBe(true);
    });

    it("POC-M2: one RPC returning a fabricated Deposited TWICE does not enter sums / deposit index", async () => {
      let on = false;
      const liar = injectorAt(H.bsc, () => H.bsc.bridge, () => fakeLog(H.bsc.abi as Abi, "Deposited", (i) => (i.name === "nonce" ? 7n : i.type.startsWith("uint") ? E(100) : ACCOUNTS.user2.address)), () => on, { times: 2, fixedTx: `0x${"ab".repeat(32)}` });
      const t = await makeWatcher(H, { endpoints: { bsc: three(liar) } });
      on = true;
      await H.settle();
      await t.w.tick();
      expect(t.w.state.derived.bsc.sums["deposited"] ?? "0").toBe("0");
      expect(t.w.state.derived.depositBlocks["7"]).toBeUndefined();
      expect(t.codes()).toContain("RPC_DISAGREE"); // the duplicate itself is reported
    });
  });
});
