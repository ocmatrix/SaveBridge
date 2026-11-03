import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { adminHandoverView } from "../../src/lib/handover";
import type { ChainState } from "../../src/lib/state";
import type { Proposal } from "../../src/lib/timelock";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const NOW = 1_000_000n;
const st = (o: Partial<ChainState> = {}): ChainState => ({ admin: A(1), pendingAdmin: null, now: NOW, ...o }) as ChainState;
const prop = (state: Proposal["state"], readyAt: bigint): Proposal => ({ state, readyAt }) as Proposal;
const val = (v: ReturnType<typeof adminHandoverView>, i: number) => v.rows[i]!.value;

describe("adminHandoverView (管理钱包交接四步)", () => {
  it("nothing started: step 1 waits for authorization, nothing revocable", () => {
    const v = adminHandoverView(st(), null, A(2));
    expect(v.rows.map((r) => r.label)).toEqual(["① 现管理员授权", "② 等待 48 小时", "③ 执行提议", "④ 新地址签名接收"]);
    expect(val(v, 0)).toBe("待授权");
    expect([val(v, 1), val(v, 2), val(v, 3)]).toEqual(["—", "—", "—"]);
    expect(v.revocable).toBe(false);
  });

  it("proposal waiting: authorized, countdown running, revocable", () => {
    const v = adminHandoverView(st(), prop("waiting", NOW + 3600n), A(2));
    expect(val(v, 0)).toBe("已完成 ✓");
    expect(val(v, 1)).toMatch(/^剩 /);
    expect(val(v, 2)).toBe("未到时间");
    expect(val(v, 3)).toBe("—");
    expect(v.revocable).toBe(true);
  });

  it("proposal ready: waiting period over, executable, still revocable", () => {
    const v = adminHandoverView(st(), prop("ready", NOW - 1n), A(2));
    expect(val(v, 1)).toBe("已到 ✓");
    expect(val(v, 2)).toBe("可执行");
    expect(v.revocable).toBe(true);
  });

  it("executed, pendingAdmin set: new address must sign; no one-click revoke", () => {
    const v = adminHandoverView(st({ pendingAdmin: { candidate: A(2), expiresAt: NOW + 86_400n } }), null, A(2));
    expect(val(v, 2)).toBe("已执行 ✓");
    expect(val(v, 3)).toMatch(/^待签名 · 剩 /);
    expect(v.waitingAccept).toBe(true);
    expect(v.revocable).toBe(false);
  });

  it("new address already admin: all done, effective", () => {
    const v = adminHandoverView(st({ admin: A(2) }), null, A(2));
    expect(v.rows.map((r) => r.value)).toEqual(["已完成 ✓", "已完成 ✓", "已完成 ✓", "已生效 ✓"]);
    expect(v.effective).toBe(true);
    expect(v.waitingAccept).toBe(false);
  });

  it("a pending admin for a different address than the one typed is not shown as progress", () => {
    const v = adminHandoverView(st({ pendingAdmin: { candidate: A(3), expiresAt: NOW + 86_400n } }), null, A(2));
    expect(val(v, 0)).toBe("待授权");
    expect(v.waitingAccept).toBe(false);
  });
});
