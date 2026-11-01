import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  ENFORCED_PAUSE_SELECTOR,
  PAUSE_SELECTOR,
  PauseExecutor,
  PauseGuardError,
  PauseOnlySigner,
  assertPauseOnly,
  isEnforcedPause,
  pauseCall,
  type PauseChainReader,
  type RawTxSender,
} from "../../src/pauser.js";

const BRIDGE = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;

class FakeSender implements RawTxSender {
  readonly address = "0x00000000000000000000000000000000000000aa" as Address;
  sent: Array<{ to: Address; data: Hex }> = [];
  failures: unknown[] = [];
  async send(tx: { to: Address; data: Hex }): Promise<Hex> {
    const f = this.failures.shift();
    if (f !== undefined) throw f;
    this.sent.push(tx);
    return `0x${"ab".repeat(32)}` as Hex;
  }
}

class FakeReader implements PauseChainReader {
  constructor(public isPaused = false, public receipt: "success" | "reverted" = "success") {}
  async paused(): Promise<boolean | null> {
    return this.isPaused;
  }
  async waitReceipt(): Promise<"success" | "reverted"> {
    if (this.receipt === "success") this.isPaused = true;
    return this.receipt;
  }
}

describe("PAUSER signer guard", () => {
  it("pause() selector is 0x8456cb59 and EnforcedPause() is 0xd93c0665", () => {
    expect(PAUSE_SELECTOR).toBe("0x8456cb59");
    expect(ENFORCED_PAUSE_SELECTOR).toBe("0xd93c0665");
  });

  it("accepts exactly pause() to a configured bridge", async () => {
    const s = new FakeSender();
    const signer = new PauseOnlySigner(s, [BRIDGE]);
    await signer.sendPause(pauseCall(BRIDGE));
    expect(s.sent).toEqual([{ to: BRIDGE, data: PAUSE_SELECTOR }]);
    expect(signer.address).toBe(s.address);
  });

  it("rejects any other function, extra calldata, value-bearing shapes, or another target — nothing is sent", async () => {
    const s = new FakeSender();
    const signer = new PauseOnlySigner(s, [BRIDGE]);
    const bad: Array<{ to: Address; data: Hex }> = [
      { to: BRIDGE, data: "0x3f4ba83a" }, // unpause()
      { to: BRIDGE, data: "0x8456cb5900" }, // pause() + trailing byte
      { to: BRIDGE, data: "0xa9059cbb" }, // transfer
      { to: OTHER, data: PAUSE_SELECTOR }, // pause() on a non-bridge
      { to: BRIDGE, data: "0x" },
    ];
    for (const tx of bad) {
      // @ts-expect-error — the type system only admits branded PauseCall values
      await expect(signer.sendPause(tx)).rejects.toBeInstanceOf(PauseGuardError);
      expect(() => assertPauseOnly(tx, [BRIDGE])).toThrow(PauseGuardError);
    }
    expect(() => assertPauseOnly({ to: BRIDGE, data: PAUSE_SELECTOR, value: 1n } as never, [BRIDGE])).toThrow(PauseGuardError);
    expect(s.sent).toHaveLength(0);
  });

  it("pauseCall refuses an unconfigured shape at construction time", () => {
    expect(() => pauseCall("0x1234" as Address)).toThrow(PauseGuardError);
  });

  it("detects EnforcedPause in nested errors", () => {
    expect(isEnforcedPause(new Error("reverted with custom error 0xd93c0665"))).toBe(true);
    expect(isEnforcedPause({ cause: { data: "0xd93c0665" } })).toBe(true);
    expect(isEnforcedPause({ shortMessage: "EnforcedPause()" })).toBe(true);
    expect(isEnforcedPause(new Error("nonce too low"))).toBe(false);
    expect(isEnforcedPause(undefined)).toBe(false);
  });
});

describe("PauseExecutor", () => {
  const mk = (reader: FakeReader, sender = new FakeSender()) => {
    const ex = new PauseExecutor(
      { bsc: new PauseOnlySigner(sender, [BRIDGE]), wantos: new PauseOnlySigner(sender, [OTHER]) },
      { bsc: reader, wantos: reader },
      { bsc: BRIDGE, wantos: OTHER },
      { attempts: 3, backoffMs: 0 },
    );
    return { ex, sender };
  };

  it("is idempotent: an already-paused bridge is success without sending", async () => {
    const { ex, sender } = mk(new FakeReader(true));
    expect(await ex.pause("bsc")).toMatchObject({ ok: true, status: "already-paused" });
    expect(sender.sent).toHaveLength(0);
  });

  it("sends pause() and reports success", async () => {
    const { ex, sender } = mk(new FakeReader(false));
    expect(await ex.pause("bsc")).toMatchObject({ ok: true, status: "paused", attempts: 1 });
    expect(sender.sent).toEqual([{ to: BRIDGE, data: PAUSE_SELECTOR }]);
  });

  it("treats an EnforcedPause revert as success only once ≥2 RPCs confirm paused() (race: someone paused first)", async () => {
    const sender = new FakeSender();
    sender.failures.push(new Error("execution reverted: custom error 0xd93c0665"));
    const reader = new FakeReader(false);
    let reads = 0;
    reader.paused = async () => reads++ > 0; // unpaused at first read, paused when re-checked
    const { ex } = mk(reader, sender);
    expect(await ex.pause("bsc")).toMatchObject({ ok: true, status: "already-paused" });
  });

  it("an EnforcedPause claim that the RPCs do not confirm is a failure (A2)", async () => {
    const sender = new FakeSender();
    for (let i = 0; i < 3; i++) sender.failures.push(new Error("execution reverted: custom error 0xd93c0665"));
    const { ex } = mk(new FakeReader(false), sender);
    const r = await ex.pause("bsc");
    expect(r).toMatchObject({ ok: false, status: "failed", attempts: 3 });
    expect(r.error).toMatch(/not confirmed/);
  });

  it("an unconfirmed paused() reading (RPCs disagree → null) is not 'already paused': pause() is sent", async () => {
    const reader = new FakeReader(false);
    let n = 0;
    reader.paused = async () => (n++ === 0 ? null : true);
    const { ex, sender } = mk(reader);
    expect(await ex.pause("bsc")).toMatchObject({ ok: true, status: "paused" });
    expect(sender.sent).toHaveLength(1);
  });

  it("treats a reverted receipt as success when the bridge is paused afterwards", async () => {
    const reader = new FakeReader(false, "reverted");
    const { ex } = mk(reader);
    reader.waitReceipt = async () => {
      reader.isPaused = true;
      return "reverted";
    };
    expect(await ex.pause("bsc")).toMatchObject({ ok: true, status: "already-paused" });
  });

  it("retries transient failures and finally reports failure", async () => {
    const sender = new FakeSender();
    sender.failures.push(new Error("timeout"), new Error("timeout"));
    const { ex } = mk(new FakeReader(false), sender);
    expect(await ex.pause("bsc")).toMatchObject({ ok: true, status: "paused", attempts: 3 });

    const s2 = new FakeSender();
    s2.failures.push(new Error("a"), new Error("b"), new Error("c"));
    const { ex: ex2 } = mk(new FakeReader(false), s2);
    const r = await ex2.pause("bsc");
    expect(r).toMatchObject({ ok: false, status: "failed", attempts: 3 });
    expect(r.error).toContain("c");
  });

  it("a reverted receipt while still unpaused is retried then fails", async () => {
    const reader = new FakeReader(false, "reverted");
    reader.waitReceipt = async () => "reverted";
    const { ex } = mk(reader);
    expect(await ex.pause("bsc")).toMatchObject({ ok: false, status: "failed" });
  });
});
