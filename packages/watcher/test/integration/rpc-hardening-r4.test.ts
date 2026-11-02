/**
 * GATE2 round 4 (fable limited re-review): A-α contested logs, autopause re-alert after reopen,
 * stalled RPC named by RPC_DISSENTING, retry of a failed range.
 */
import { bridgeTimelockAbi } from "@bridge/abi";
import { encodeFunctionData, getAbiItem, keccak256, toEventSelector, toHex, type Abi, type AbiEvent, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCOUNTS, BSC_PARAMS, E, startHarness, type Harness } from "../helpers/harness.js";
import { honest, logRewriter, makeWatcher, stalledNode, tamperedClient } from "../helpers/watcher.js";

const RELAYER_ROLE = keccak256(toHex("RELAYER_ROLE"));
const ZERO32 = `0x${"00".repeat(32)}` as Hex;

describe("round-4 hardening", () => {
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
  const level1 = (t: Awaited<ReturnType<typeof makeWatcher>>) => t.sink.alerts.filter((a) => a.level === 1);

  describe("A-α: a log reported by ≥ minAgree RPCs but with a tampered variant is CONTESTED → level 1", () => {
    it("① a real RoleRevoked whose topics one RPC rewrites still produces a level-1 alert", async () => {
      let X: bigint | null = null;
      const sel = toEventSelector(getAbiItem({ abi: H.bsc.abi as Abi, name: "RoleRevoked" }) as AbiEvent);
      const liar = logRewriter(H.bsc, () => X, (l) => ((l["topics"] as Hex[])[0] === sel ? { ...l, topics: [...(l["topics"] as Hex[]).slice(0, 2), `0x${"00".repeat(12)}${"de".repeat(20)}`, ...(l["topics"] as Hex[]).slice(3)] } : l));
      const t = await makeWatcher(H, { endpoints: { bsc: three(liar) } });
      const w = await H.bsc.write(ACCOUNTS.admin, "revokeKey", [RELAYER_ROLE, ACCOUNTS.relayer.address]);
      X = w.block;
      await H.settle();
      await t.w.tick();
      const l1 = level1(t);
      expect(l1.length).toBeGreaterThanOrEqual(1);
      expect(l1.some((a) => a.code === "EVENT_CONTESTED")).toBe(true);
    });

    it("② a real CallScheduled whose data one RPC rewrites → level 1, but no timelock op is created", async () => {
      let X: bigint | null = null;
      const sel = toEventSelector(getAbiItem({ abi: bridgeTimelockAbi as Abi, name: "CallScheduled" }) as AbiEvent);
      const liar = logRewriter(H.bsc, () => X, (l) => ((l["topics"] as Hex[])[0] === sel ? { ...l, data: `${(l["data"] as string).slice(0, -2)}ff` } : l));
      const t = await makeWatcher(H, { endpoints: { bsc: three(liar) } });
      const call = encodeFunctionData({ abi: H.bsc.abi as Abi, functionName: "setParams", args: [BSC_PARAMS] } as never);
      const s = await H.bsc.write(ACCOUNTS.admin, "schedule", [H.bsc.bridge, 0n, call, ZERO32, ZERO32, 48n * 3600n], H.bsc.timelock);
      X = s.block;
      await H.settle();
      await t.w.tick();
      expect(level1(t).some((a) => a.code === "EVENT_CONTESTED")).toBe(true);
      expect(Object.keys(t.w.state.derived.timelockOps)).toHaveLength(0);
    });
  });
});
