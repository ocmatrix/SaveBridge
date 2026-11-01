/**
 * §9.1 checks 2–4:
 *  2. WANTOS B2W ReleaseQueued ↔ finalized BSC Deposited (nonce, recipient, amount) → pause WANTOS; grace = until eta − 3 min
 *  3. WANTOS RefundRequested ↔ BSC payouts(eventKey(orderId)) finalized Voided → pause WANTOS; grace = until exec − 2 h
 *  4. BSC DepositRefundRequested ↔ WANTOS payouts(eventKey(nonce)) Voided → pause BSC; grace = until exec − 2 h
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeEventKey } from "../../src/events.js";
import { ACCOUNTS, E, startHarness, type Harness } from "../helpers/harness.js";
import { makeWatcher } from "../helpers/watcher.js";

describe("§9.1-2/3/4", () => {
  let H: Harness;
  beforeAll(async () => {
    H = await startHarness();
  });
  afterAll(() => H?.stop());
  beforeEach(async () => {
    await H.reset();
  });

  const deposit = async (amount: bigint, recipient = ACCOUNTS.user2.address) => {
    await H.bsc.write(ACCOUNTS.user2, "approve", [H.bsc.bridge, amount], H.bsc.token);
    return H.bsc.write(ACCOUNTS.user2, "deposit", [amount, recipient]);
  };
  const bridgeOut = async (amount: bigint) => {
    await H.wantos.write(ACCOUNTS.user1, "approve", [H.wantos.bridge, amount], H.wantos.token);
    return H.wantos.write(ACCOUNTS.user1, "bridgeOut", [amount]);
  };
  const etaOf = async (block: bigint): Promise<number> => {
    const logs = await H.wantos.pub.getContractEvents({ address: H.wantos.bridge, abi: H.wantos.abi, eventName: "ReleaseQueued", fromBlock: block, toBlock: block });
    return Number((logs[0] as unknown as { args: { executableAt: bigint } }).args.executableAt);
  };

  it("local eventKey derivation equals the contracts' (orderEventKey / depositEventKey / eventKeyOf)", async () => {
    const k1 = await H.wantos.pub.readContract({ address: H.wantos.bridge, abi: H.wantos.abi, functionName: "orderEventKey", args: [5n] } as never);
    const k1b = await H.bsc.pub.readContract({ address: H.bsc.bridge, abi: H.bsc.abi, functionName: "eventKeyOf", args: [5n] } as never);
    expect(computeEventKey(H.wantos.chainId, H.wantos.bridge, 5n)).toBe(k1);
    expect(k1b).toBe(k1);
    const k2 = await H.bsc.pub.readContract({ address: H.bsc.bridge, abi: H.bsc.abi, functionName: "depositEventKey", args: [3n] } as never);
    expect(computeEventKey(H.bsc.chainId, H.bsc.bridge, 3n)).toBe(k2);
  });

  describe("check 2: B2W", () => {
    it("positive: matching deposit → no pause, even after eta − 3 min", async () => {
      const t = await makeWatcher(H);
      await deposit(E(100));
      const q = await H.wantos.write(ACCOUNTS.relayer, "queueRelease", [1n, ACCOUNTS.user2.address, E(100)]);
      await H.settle();
      t.clock.now = (await etaOf(q.block)) - 179;
      await t.w.tick();
      expect(await H.isPaused("wantos")).toBe(false);
      expect(t.w.state.derived.pending).toHaveLength(0);
      expect(t.codes()).not.toContain("AUTO_PAUSE");
    });

    for (const [label, nonce, to, amount] of [
      ["number", 99n, ACCOUNTS.user2.address, E(100)],
      ["recipient", 1n, ACCOUNTS.user3.address, E(100)],
      ["amount", 1n, ACCOUNTS.user2.address, E(101)],
    ] as const) {
      it(`negative: wrong ${label} → no pause inside grace, pause WANTOS (only) after eta − 3 min, with cancel-first advice`, async () => {
        const t = await makeWatcher(H);
        await deposit(E(100));
        const q = await H.wantos.write(ACCOUNTS.relayer, "queueRelease", [nonce, to, amount]);
        await H.settle();
        const eta = await etaOf(q.block);
        t.clock.now = eta - 181;
        await t.w.tick();
        expect(await H.isPaused("wantos")).toBe(false);
        t.clock.now = eta - 179;
        await t.w.tick();
        expect(await H.isPaused("wantos")).toBe(true);
        expect(await H.isPaused("bsc")).toBe(false);
        const a = t.sink.alerts.find((x) => x.code === "AUTO_PAUSE")!;
        expect(a.chain).toBe("wantos");
        expect(String(a.detail["advice"])).toContain("先吊销被怀疑的付款钥匙");
        expect(String(a.detail["advice"])).toContain("取消可疑排队项");
      });
    }

    it("deposit not yet finalized on BSC → deferred, not paused", async () => {
      const t = await makeWatcher(H);
      await H.settle();
      await t.w.tick(); // BSC cursor exists but will be older than the queue item
      await H.wantos.increaseTime(20);
      const q = await H.wantos.write(ACCOUNTS.relayer, "queueRelease", [1n, ACCOUNTS.user2.address, E(100)]);
      await H.wantos.mine(7);
      t.clock.now = (await etaOf(q.block)) - 100;
      await t.w.tick();
      expect(await H.isPaused("wantos")).toBe(false);
      expect(t.codes()).toContain("CHECK_DEFERRED");
      expect(t.codes()).not.toContain("CHECK_OVERDUE");
      // B4: still undecidable when the queue item becomes executable → level-1 escalation (no pause)
      t.clock.now = await etaOf(q.block);
      await t.w.tick();
      expect(t.sink.alerts.find((a) => a.code === "CHECK_OVERDUE")!.level).toBe(1);
      expect(await H.isPaused("wantos")).toBe(false);
    });
  });

  describe("check 3: WANTOS refund ↔ BSC Voided", () => {
    const refundFlow = async (voidOnBsc: boolean) => {
      const t = await makeWatcher(H);
      await bridgeOut(E(100));
      if (voidOnBsc) await H.bsc.write(ACCOUNTS.admin, "voidSource", [1n]);
      await H.settle();
      const rr = await H.wantos.write(ACCOUNTS.admin, "requestRefund", [1n]);
      await H.settle();
      const exec = rr.timestamp + 86_400;
      t.clock.now = exec - 7201;
      await t.w.tick();
      expect(await H.isPaused("wantos")).toBe(false);
      expect(t.w.state.derived.pending.map((p) => p.kind)).toEqual(["refund"]);
      t.clock.now = exec - 7199;
      await t.w.tick();
      return t;
    };

    it("positive: BSC eventKey finalized Voided → no pause", async () => {
      const t = await refundFlow(true);
      expect(await H.isPaused("wantos")).toBe(false);
      expect(t.w.state.derived.pending).toHaveLength(0);
    });

    it("negative: not voided on BSC → pause WANTOS at exec − 2h (not before)", async () => {
      const t = await refundFlow(false);
      expect(await H.isPaused("wantos")).toBe(true);
      expect(await H.isPaused("bsc")).toBe(false);
      expect(t.sink.alerts.find((x) => x.code === "AUTO_PAUSE")!.detail["reason"]).toMatch(/Voided/);
    });

    it("a refund cancelled before the decision is dropped", async () => {
      const t = await makeWatcher(H);
      await bridgeOut(E(100));
      const rr = await H.wantos.write(ACCOUNTS.admin, "requestRefund", [1n]);
      await H.wantos.write(ACCOUNTS.wl, "cancelRefund", [1n]);
      await H.settle();
      t.clock.now = rr.timestamp + 86_400;
      await t.w.tick();
      expect(await H.isPaused("wantos")).toBe(false);
      expect(t.w.state.derived.pending).toHaveLength(0);
    });
  });

  describe("check 4: BSC deposit refund ↔ WANTOS Voided", () => {
    const flow = async (voidOnWantos: boolean) => {
      const t = await makeWatcher(H);
      await deposit(E(50));
      if (voidOnWantos) await H.wantos.write(ACCOUNTS.admin, "voidSource", [1n]);
      await H.settle();
      const rr = await H.bsc.write(ACCOUNTS.admin, "requestDepositRefund", [1n]);
      await H.settle();
      const exec = rr.timestamp + 86_400;
      t.clock.now = exec - 7201;
      await t.w.tick();
      expect(await H.isPaused("bsc")).toBe(false);
      t.clock.now = exec - 7199;
      await t.w.tick();
      return t;
    };

    it("positive: WANTOS eventKey Voided → no pause", async () => {
      const t = await flow(true);
      expect(await H.isPaused("bsc")).toBe(false);
      expect(t.w.state.derived.pending).toHaveLength(0);
    });

    it("negative: not voided on WANTOS → pause BSC only", async () => {
      await flow(false);
      expect(await H.isPaused("bsc")).toBe(true);
      expect(await H.isPaused("wantos")).toBe(false);
    });

    it("a deposit refund cancelled before the decision is dropped", async () => {
      const t = await makeWatcher(H);
      await deposit(E(50));
      const rr = await H.bsc.write(ACCOUNTS.admin, "requestDepositRefund", [1n]);
      await H.bsc.write(ACCOUNTS.wl, "cancelDepositRefund", [1n]);
      await H.settle();
      t.clock.now = rr.timestamp + 86_400;
      await t.w.tick();
      expect(await H.isPaused("bsc")).toBe(false);
      expect(t.w.state.derived.pending).toHaveLength(0);
    });
  });
});
