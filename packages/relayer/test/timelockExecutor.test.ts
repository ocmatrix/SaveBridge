import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, parseEther, toHex, pad, type Abi, type PublicClient } from "viem";
import { bscVaultV2Abi, bridgeTimelockAbi } from "@bridge/abi";
import { startWorld, type World } from "./helpers/system";
import { newKey, U, write } from "./helpers/deploy";
import { newMigratedDb } from "./helpers/db";
import { MemoryAlertSink } from "../src/alerts";
import { SafetyState } from "../src/safety";
import { LocalTestSigner } from "../src/signer";
import { TxSender } from "../src/chain/sender";
import { TimelockExecutor, runTimelockTicks } from "../src/timelockExecutor";
import type { Db } from "../src/db/types";
import type { Hex } from "../src/types";

const H = 3600n;
const ZERO = pad("0x00", { size: 32 }) as Hex;

describe("submission service: timelock auto-execute + 24h/6h reminders (§6.4, §4.1)", () => {
  let world: World;
  let snap: Hex;
  let db: Db, alerts: MemoryAlertSink, exec: TimelockExecutor, sender: TxSender;
  const params = (dailyCap: bigint) =>
    encodeFunctionData({
      abi: bscVaultV2Abi as Abi,
      functionName: "setParams",
      args: [{ dailyCap, perAddrDailyCap: 2000n * U, largeThreshold: 1000n * U, releaseDelay: 12n * H, minDeposit: 10n * U, maxDepositPerTx: 2000n * U }],
    });
  const schedule = (data: Hex, salt: Hex) =>
    write(world.bsc, world.act.admin, world.b.timelock, bridgeTimelockAbi as Abi, "schedule", [world.b.bridge, 0n, data, ZERO, salt, 48n * H]);
  const dailyCap = async () => ((await world.bsc.publicClient.readContract({ address: world.b.bridge, abi: bscVaultV2Abi as Abi, functionName: "params" })) as { dailyCap: bigint }).dailyCap;
  const warp = async (s: bigint) => {
    await world.bsc.testClient.increaseTime({ seconds: Number(s) });
    await world.bsc.testClient.mine({ blocks: 1 });
  };

  beforeAll(async () => {
    world = await startWorld();
  });
  afterAll(async () => world?.stop());
  beforeEach(async () => {
    snap = await world.bsc.testClient.snapshot();
    db = await newMigratedDb();
    alerts = new MemoryAlertSink();
    const signer = new LocalTestSigner(newKey()); // submitter hot key: no role on any contract
    await world.bsc.testClient.setBalance({ address: signer.address, value: parseEther("1") });
    sender = new TxSender({
      chainId: world.bsc.chain.id,
      client: world.bsc.publicClient as unknown as PublicClient,
      signer,
      db,
      alerts,
      safety: new SafetyState(alerts),
      cfg: { replaceByFee: true, stuckAfterMs: 60_000, feeBumpPercent: 15, maxFeeBumps: 3 },
    });
    exec = new TimelockExecutor({
      chainId: world.bsc.chain.id,
      timelock: world.b.timelock,
      client: world.bsc.publicClient as unknown as PublicClient,
      sender,
      db,
      alerts,
      fromBlock: 0n,
    });
    await sender.recover();
  });
  afterEach(async () => {
    await world.bsc.testClient.revert({ id: snap });
  });

  it("reminds at 24h and 6h before ready, then executes once ready", async () => {
    await schedule(params(6000n * U), pad(toHex(1), { size: 32 }));
    await exec.tick();
    expect(alerts.byKind("TIMELOCK_REMINDER")).toHaveLength(0);
    await warp(24n * H + 1n);
    await exec.tick();
    await exec.tick();
    expect(alerts.byKind("TIMELOCK_REMINDER").map((a) => a.data?.window)).toEqual(["24h"]);
    await warp(18n * H);
    await exec.tick();
    expect(alerts.byKind("TIMELOCK_REMINDER").map((a) => a.data?.window)).toEqual(["24h", "6h"]);
    expect(await dailyCap()).toBe(5000n * U);
    await warp(6n * H);
    await exec.tick();
    await sender.tick();
    expect(await dailyCap()).toBe(6000n * U);
    await exec.tick();
    await sender.tick();
    const n = await db.query<{ n: number }>("select count(*)::int as n from tx_attempts where action = 'timelock.execute'");
    expect(n.rows[0]!.n).toBe(1);
  });

  it("restart does not repeat reminders (persisted)", async () => {
    await schedule(params(6000n * U), pad(toHex(2), { size: 32 }));
    await warp(24n * H + 1n);
    await exec.tick();
    const again = new TimelockExecutor({ chainId: world.bsc.chain.id, timelock: world.b.timelock, client: world.bsc.publicClient as unknown as PublicClient, sender, db, alerts, fromBlock: 0n });
    await again.tick();
    expect(alerts.byKind("TIMELOCK_REMINDER")).toHaveLength(1);
  });

  it("cancelled proposals are never executed", async () => {
    await schedule(params(6000n * U), pad(toHex(3), { size: 32 }));
    const id = (await world.bsc.publicClient.readContract({
      address: world.b.timelock,
      abi: bridgeTimelockAbi as Abi,
      functionName: "hashOperation",
      args: [world.b.bridge, 0n, params(6000n * U), ZERO, pad(toHex(3), { size: 32 })],
    })) as Hex;
    await write(world.bsc, world.act.wl, world.b.timelock, bridgeTimelockAbi as Abi, "cancel", [id]);
    await warp(49n * H);
    await exec.tick();
    expect(await dailyCap()).toBe(5000n * U);
    const n = await db.query<{ n: number }>("select count(*)::int as n from tx_attempts");
    expect(n.rows[0]!.n).toBe(0);
  });

  it("expired proposals (> ready + 14d) are skipped without even simulating", async () => {
    await schedule(params(6000n * U), pad(toHex(4), { size: 32 }));
    await warp(48n * H + 15n * 24n * H);
    const spy = vi.spyOn(sender, "send");
    await exec.tick();
    expect(await dailyCap()).toBe(5000n * U);
    expect(spy).not.toHaveBeenCalled();
    expect(alerts.byKind("TIMELOCK_EXEC_BLOCKED")).toHaveLength(0);
  });

  it("B7: proposals from a previous admin epoch (after an admin recovery) are skipped without simulating", async () => {
    await schedule(params(6000n * U), pad(toHex(8), { size: 32 }));
    // WL starts an admin recovery; after 14 days the candidate accepts → epoch + 1
    await write(world.bsc, world.act.wl, world.b.timelock, bridgeTimelockAbi as Abi, "startAdminRecovery", [world.act.user2.address]);
    await warp(14n * 24n * H + 1n);
    await write(world.bsc, world.act.user2, world.b.timelock, bridgeTimelockAbi as Abi, "acceptAdmin", []);
    expect(await world.bsc.publicClient.readContract({ address: world.b.timelock, abi: bridgeTimelockAbi as Abi, functionName: "epoch" })).toBe(1n);
    const spy = vi.spyOn(sender, "send");
    await exec.tick();
    expect(spy).not.toHaveBeenCalled();
    expect(alerts.byKind("TIMELOCK_EXEC_BLOCKED")).toHaveLength(0);
    expect(await dailyCap()).toBe(5000n * U);
  });

  it("batch proposals are executed with executeBatch", async () => {
    await write(world.bsc, world.act.admin, world.b.timelock, bridgeTimelockAbi as Abi, "scheduleBatch", [
      [world.b.bridge, world.b.bridge],
      [0n, 0n],
      [params(6000n * U), params(7000n * U)],
      ZERO,
      pad(toHex(5), { size: 32 }),
      48n * H,
    ]);
    await warp(48n * H);
    await exec.tick();
    await sender.tick();
    expect(await dailyCap()).toBe(7000n * U);
  });

  it("a ready proposal whose execution reverts (e.g. paused) is alerted once and not sent", async () => {
    await schedule(params(6000n * U), pad(toHex(6), { size: 32 }));
    await write(world.bsc, world.act.pauser, world.b.bridge, bscVaultV2Abi as Abi, "pause", []);
    await warp(48n * H);
    await exec.tick();
    await exec.tick();
    expect(alerts.byKind("TIMELOCK_EXEC_BLOCKED")).toHaveLength(1);
    const n = await db.query<{ n: number }>("select count(*)::int as n from tx_attempts");
    expect(n.rows[0]!.n).toBe(0);
  });

  it("B4: scans with a persisted cursor in bounded ranges (RPC getLogs range limit), and keeps working", async () => {
    const ranges: [bigint, bigint][] = [];
    const LIMIT = 5n;
    const client = new Proxy(world.bsc.publicClient as any, {
      get(t, p) {
        if (p === "getLogs") {
          return async (args: { fromBlock: bigint; toBlock: bigint | string }) => {
            const to = typeof args.toBlock === "bigint" ? args.toBlock : await t.getBlockNumber();
            if (typeof args.toBlock !== "bigint" || to - args.fromBlock + 1n > LIMIT) throw new Error("block range too large");
            ranges.push([args.fromBlock, to]);
            return t.getLogs(args);
          };
        }
        return t[p];
      },
    });
    const ex = new TimelockExecutor({ chainId: world.bsc.chain.id, timelock: world.b.timelock, client, sender, db, alerts, fromBlock: 0n, maxBlockRange: Number(LIMIT) });
    await schedule(params(6000n * U), pad(toHex(7), { size: 32 }));
    await ex.tick();
    const head = await world.bsc.publicClient.getBlockNumber();
    expect(ranges.every(([f, t]) => t - f + 1n <= LIMIT)).toBe(true);
    expect(ranges[ranges.length - 1]![1]).toBe(head);
    ranges.length = 0;
    await warp(24n * H + 1n);
    const ex2 = new TimelockExecutor({ chainId: world.bsc.chain.id, timelock: world.b.timelock, client, sender, db, alerts, fromBlock: 0n, maxBlockRange: Number(LIMIT) });
    await ex2.tick(); // restart: resumes from the cursor, does not rescan from fromBlock
    expect(ranges[0]![0]).toBe(head + 1n);
    expect(alerts.byKind("TIMELOCK_REMINDER")).toHaveLength(1);
  });

  it("B4: executor failures are alerted, never swallowed", async () => {
    const broken = new TimelockExecutor({
      chainId: world.bsc.chain.id,
      timelock: world.b.timelock,
      client: new Proxy(world.bsc.publicClient as any, { get: (t, p) => (p === "getLogs" ? async () => { throw new Error("upstream https://rpc.example.com/v2/KEY failed"); } : t[p]) }),
      sender,
      db,
      alerts,
      fromBlock: 0n,
    });
    await expect(broken.tick()).rejects.toThrow();
    await runTimelockTicks([broken], alerts);
    const a = alerts.byKind("TIMELOCK_EXECUTOR_ERROR");
    expect(a).toHaveLength(1);
    expect(a[0]!.message).not.toContain("KEY");
  });
});
