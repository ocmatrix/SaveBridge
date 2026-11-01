import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, parseEther, toHex, pad, type Abi, type PublicClient } from "viem";
import { bscVaultV2Abi, bridgeTimelockAbi } from "@bridge/abi";
import { startWorld, type World } from "./helpers/system";
import { newKey, U, write } from "./helpers/deploy";
import { newMigratedDb } from "./helpers/db";
import { MemoryAlertSink } from "../src/alerts";
import { SafetyState } from "../src/safety";
import { LocalTestSigner } from "../src/signer";
import { TxSender } from "../src/chain/sender";
import { TimelockExecutor } from "../src/timelockExecutor";
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

  it("expired proposals (> ready + 14d) are skipped", async () => {
    await schedule(params(6000n * U), pad(toHex(4), { size: 32 }));
    await warp(48n * H + 15n * 24n * H);
    await exec.tick();
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
});
