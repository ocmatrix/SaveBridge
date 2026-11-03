/**
 * Abnormal-withdrawal alerts on WANTOS BridgeOut orders: one large order, one address ordering often in a window.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNTS, E, startHarness, type Harness } from "../helpers/harness.js";
import { makeWatcher } from "../helpers/watcher.js";

describe("withdrawal alerts", () => {
  let H: Harness;
  beforeAll(async () => {
    H = await startHarness();
  });
  afterAll(() => H?.stop());
  beforeEach(async () => {
    await H.reset();
  });

  const tickNow = async (t: Awaited<ReturnType<typeof makeWatcher>>): Promise<void> => {
    await H.settle();
    t.clock.now = (await H.wantos.latest()).timestamp;
    await t.w.tick();
  };
  const count = (t: Awaited<ReturnType<typeof makeWatcher>>, code: string): number => t.sink.alerts.filter((a) => a.code === code).length;

  it("a single order strictly above the threshold → LARGE_WITHDRAWAL (level 2); an order exactly at it does not alert", async () => {
    const t = await makeWatcher(H, { config: (c) => void (c.withdrawalAlerts.largeWei = E(50)) });
    await H.wantos.write(ACCOUNTS.user1, "approve", [H.wantos.bridge, E(500)], H.wantos.token);
    await H.wantos.write(ACCOUNTS.user1, "bridgeOut", [E(50)]);
    await tickNow(t);
    expect(count(t, "LARGE_WITHDRAWAL")).toBe(0);
    await H.wantos.write(ACCOUNTS.user1, "bridgeOut", [E(60)]);
    await tickNow(t);
    expect(count(t, "LARGE_WITHDRAWAL")).toBe(1);
    const a = t.sink.alerts.find((x) => x.code === "LARGE_WITHDRAWAL")!;
    expect(a.level).toBe(2);
    expect(a.detail["user"]).toBe(ACCOUNTS.user1.address.toLowerCase());
    expect(a.detail["amount"]).toBe(E(60).toString());
    await tickNow(t); // the same order is not alerted again
    expect(count(t, "LARGE_WITHDRAWAL")).toBe(1);
  });

  it("the same address placing `count` orders within the window → FREQUENT_WITHDRAWALS once; fewer orders do not alert", async () => {
    const t = await makeWatcher(H, { config: (c) => void (c.withdrawalAlerts.frequent = { count: 3, windowSeconds: 3600 }) });
    await H.wantos.write(ACCOUNTS.user1, "approve", [H.wantos.bridge, E(500)], H.wantos.token);
    await H.wantos.write(ACCOUNTS.user1, "bridgeOut", [E(10)]);
    await H.wantos.write(ACCOUNTS.user1, "bridgeOut", [E(10)]);
    await tickNow(t);
    expect(count(t, "FREQUENT_WITHDRAWALS")).toBe(0);
    await H.wantos.write(ACCOUNTS.user1, "bridgeOut", [E(10)]);
    await tickNow(t);
    expect(count(t, "FREQUENT_WITHDRAWALS")).toBe(1);
    const a = t.sink.alerts.find((x) => x.code === "FREQUENT_WITHDRAWALS")!;
    expect(a.level).toBe(2);
    expect(a.detail["count"]).toBe(3);
    expect(a.detail["total"]).toBe(E(30).toString());
    await H.wantos.write(ACCOUNTS.user1, "bridgeOut", [E(10)]); // a 4th order in the same window: still one alert
    await tickNow(t);
    expect(count(t, "FREQUENT_WITHDRAWALS")).toBe(1);
  });

  it("orders spread wider than the window do not count together", async () => {
    const t = await makeWatcher(H, { config: (c) => void (c.withdrawalAlerts.frequent = { count: 3, windowSeconds: 3600 }) });
    await H.wantos.write(ACCOUNTS.user1, "approve", [H.wantos.bridge, E(500)], H.wantos.token);
    for (let i = 0; i < 3; i++) {
      await H.wantos.write(ACCOUNTS.user1, "bridgeOut", [E(10)]);
      await tickNow(t);
      await H.wantos.increaseTime(4000);
    }
    expect(count(t, "FREQUENT_WITHDRAWALS")).toBe(0);
  });
});
