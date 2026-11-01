/**
 * GATE2 round 1 — A4 (an executed refund is not a "withdrawn" refund) and A5 (refund checks accept only
 * Voided: a source that was Released or is Queued on the other chain must pause).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNTS, E, startHarness, type Harness } from "../helpers/harness.js";
import { makeWatcher } from "../helpers/watcher.js";

describe("refund hardening", () => {
  let H: Harness;
  beforeAll(async () => {
    H = await startHarness();
  });
  afterAll(() => H?.stop());
  beforeEach(async () => {
    await H.reset();
  });

  const bridgeOut = async (amount: bigint) => {
    await H.wantos.write(ACCOUNTS.user1, "approve", [H.wantos.bridge, amount], H.wantos.token);
    return H.wantos.write(ACCOUNTS.user1, "bridgeOut", [amount]);
  };
  const deposit = async (amount: bigint) => {
    await H.bsc.write(ACCOUNTS.user2, "approve", [H.bsc.bridge, amount], H.bsc.token);
    return H.bsc.write(ACCOUNTS.user2, "deposit", [amount, ACCOUNTS.user2.address]);
  };

  describe("A4 — a refund executed while its check was deferred is still checked", () => {
    it("WANTOS refund executed (Refunded) without a BSC void → pause WANTOS, level 1", async () => {
      const t = await makeWatcher(H);
      await bridgeOut(E(100));
      await H.settle();
      await t.w.tick();
      await H.wantos.increaseTime(10);
      const rr = await H.wantos.write(ACCOUNTS.admin, "requestRefund", [1n]);
      await H.wantos.mine(7); // BSC view stays behind → deferred
      t.clock.now = rr.timestamp + 86_400 - 7000;
      await t.w.tick();
      expect(t.codes()).toContain("CHECK_DEFERRED");
      await H.wantos.increaseTime(86_400);
      await H.wantos.write(ACCOUNTS.attacker, "executeRefund", [1n]); // anyone may execute
      await H.settle();
      t.clock.now = (await H.wantos.latest()).timestamp;
      await t.w.tick();
      expect(await H.isPaused("wantos")).toBe(true);
      expect(t.sink.alerts.find((a) => a.code === "AUTO_PAUSE")!.level).toBe(1);
    });

    it("BSC deposit refund executed (Refunded) without a WANTOS void → pause BSC", async () => {
      const t = await makeWatcher(H);
      await deposit(E(50));
      await H.settle();
      await t.w.tick();
      await H.bsc.increaseTime(10);
      const rr = await H.bsc.write(ACCOUNTS.admin, "requestDepositRefund", [1n]);
      await H.bsc.mine(3); // WANTOS view stays behind → deferred
      t.clock.now = rr.timestamp + 86_400 - 7000;
      await t.w.tick();
      expect(t.codes()).toContain("CHECK_DEFERRED");
      await H.bsc.increaseTime(86_400);
      await H.bsc.write(ACCOUNTS.attacker, "executeDepositRefund", [1n]);
      await H.settle();
      t.clock.now = (await H.bsc.latest()).timestamp;
      await t.w.tick();
      expect(await H.isPaused("bsc")).toBe(true);
    });
  });
});
