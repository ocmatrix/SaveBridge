import { describe, expect, it } from "vitest";
import { newMigratedDb } from "./helpers/db";
import { OrderRepo, type NewOrder } from "../src/orders";

const KEY = ("0x" + "11".repeat(32)) as `0x${string}`;
const base: NewOrder = {
  eventKey: KEY,
  direction: "W2B",
  srcChain: 13555,
  srcEventNonce: 1n,
  srcTxHash: ("0x" + "22".repeat(32)) as `0x${string}`,
  srcBlockNumber: 10n,
  srcBlockHash: ("0x" + "33".repeat(32)) as `0x${string}`,
  userAddr: "0x00000000000000000000000000000000000000Aa",
  toAddr: "0x00000000000000000000000000000000000000Aa",
  amountWei: 123456789012345678901234567890n,
};

describe("OrderRepo", () => {
  it("round-trips big amounts and addresses", async () => {
    const repo = new OrderRepo(await newMigratedDb());
    expect(await repo.insertDetected(base)).toBe(true);
    expect(await repo.insertDetected(base)).toBe(false);
    const o = (await repo.get(KEY))!;
    expect(o.amountWei).toBe(base.amountWei);
    expect(o.userAddr.toLowerCase()).toBe("0x00000000000000000000000000000000000000aa");
    expect(o.srcBlockNumber).toBe(10n);
    expect(await repo.get(("0x" + "99".repeat(32)) as `0x${string}`)).toBeNull();
  });

  it("compare-and-set: a stale `from` does not update", async () => {
    const repo = new OrderRepo(await newMigratedDb());
    await repo.insertDetected(base);
    const o = (await repo.get(KEY))!;
    expect(await repo.move(o, "WAITING", { reason: "quota" })).toBe(true);
    expect(await repo.move(o, "SUBMITTED")).toBe(false); // o.status is stale (DETECTED)
    expect((await repo.get(KEY))!.status).toBe("WAITING");
  });

  it("rejects illegal transitions and terminal updates", async () => {
    const repo = new OrderRepo(await newMigratedDb());
    await repo.insertDetected(base);
    const o = (await repo.get(KEY))!;
    await expect(repo.move(o, "REFUNDED")).rejects.toThrow(/illegal/);
    await expect(repo.move({ ...o, status: "RELEASED" }, "SUBMITTED")).rejects.toThrow(/terminal/);
    await expect(repo.move({ ...o, direction: "B2W" }, "WAITING", { reason: "whitelist" })).rejects.toThrow(/B2W/);
  });

  it("state_since resets on status/reason change only; history kept in reasons", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const db = await newMigratedDb();
    const repo = new OrderRepo(db, () => now);
    await repo.insertDetected(base);
    let o = (await repo.get(KEY))!;
    now = new Date("2026-01-01T00:10:00Z");
    await repo.move(o, "WAITING", { reason: "quota" });
    o = (await repo.get(KEY))!;
    expect(o.stateSince.toISOString()).toBe("2026-01-01T00:10:00.000Z");
    now = new Date("2026-01-01T00:20:00Z");
    await repo.move(o, "WAITING", { reason: "quota" });
    expect((await repo.get(KEY))!.stateSince.toISOString()).toBe("2026-01-01T00:10:00.000Z");
    await repo.move(o, "WAITING", { reason: "reserve" });
    o = (await repo.get(KEY))!;
    expect(o.stateSince.toISOString()).toBe("2026-01-01T00:20:00.000Z");
    await repo.move(o, "REVIEW", { reason: "amount_limit", reviewLevel: "freeze" });
    o = (await repo.get(KEY))!;
    expect(o.reviewLevel).toBe("freeze");
    const h = await db.query<{ reasons: unknown[] }>("select reasons from orders");
    expect(h.rows[0]!.reasons).toHaveLength(4);
    expect(await repo.listByAddress("0x00000000000000000000000000000000000000aa")).toHaveLength(1);
    expect(await repo.listByStatus(["REVIEW"], "W2B")).toHaveLength(1);
    expect(await repo.listActive()).toHaveLength(1);
  });
});
