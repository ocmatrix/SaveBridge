/**
 * §9.3 alert drills on local chains: each alert source fires with the documented level.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { bridgeTimelockAbi, bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import { ACCOUNTS, BSC_PARAMS, E, WANTOS_PARAMS, deployImpl, startHarness, whitelist, type Harness } from "../helpers/harness.js";
import { makeWatcher } from "../helpers/watcher.js";

const RELAYER_ROLE = keccak256(toHex("RELAYER_ROLE"));
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const H48 = 48n * 3600n;

describe("§9.3 alert drills", () => {
  let H: Harness;
  beforeAll(async () => {
    H = await startHarness();
  });
  afterAll(() => H?.stop());
  beforeEach(async () => {
    await H.reset();
  });

  const levelOf = (t: { sink: { alerts: Array<{ code: string; level: number }> } }, code: string) => t.sink.alerts.find((a) => a.code === code)?.level;

  it("timelock: new proposal (decoded) → level 1; 24h / 6h reminders; cancel → removed", async () => {
    const t = await makeWatcher(H);
    const loosen = encodeFunctionData({ abi: wantosBridgeV2Abi, functionName: "setParams", args: [{ ...WANTOS_PARAMS, b2wDailyCap: E(4000) }] });
    const s = await H.wantos.write(ACCOUNTS.admin, "schedule", [H.wantos.bridge, 0n, loosen, ZERO32, ZERO32, H48], H.wantos.timelock);
    await H.settle();
    await t.w.tick();
    const p = t.sink.alerts.find((a) => a.code === "TIMELOCK_PROPOSED")!;
    expect(p.level).toBe(1);
    expect(p.chain).toBe("wantos");
    expect((p.detail["calls"] as Array<{ fn: string }>)[0]!.fn).toBe("setParams");
    const readyAt = s.timestamp + 48 * 3600;
    expect(p.detail["readyAt"]).toBe(readyAt);

    t.clock.now = readyAt - 86_400;
    await t.w.tick();
    t.clock.now = readyAt - 21_600;
    await t.w.tick();
    await t.w.tick();
    expect(t.sink.alerts.filter((a) => a.code === "TIMELOCK_REMINDER")).toHaveLength(2);

    const id = (await H.wantos.pub.readContract({ address: H.wantos.timelock, abi: bridgeTimelockAbi, functionName: "hashOperation", args: [H.wantos.bridge, 0n, loosen, ZERO32, ZERO32] })) as Hex;
    await H.wantos.write(ACCOUNTS.wl, "cancel", [id], H.wantos.timelock); // WL wallet = cancel key (decision 6)
    await H.settle();
    await t.w.tick();
    expect(levelOf(t, "TIMELOCK_CANCELLED")).toBe(2);
    expect(Object.keys(t.w.state.derived.timelockOps)).toHaveLength(0);
  });

  it("timelock batch proposal → one level-1 alert listing every call; executed upgrade / withdraw / legacy batch → level 2 + sums", async () => {
    const t = await makeWatcher(H);
    const impl = await deployImpl(H.bsc);
    const oldKey = keccak256(toHex("old-tx-1"));
    const calls = [
      encodeFunctionData({ abi: bscVaultV2Abi, functionName: "upgradeToAndCall", args: [impl, "0x"] }),
      encodeFunctionData({ abi: bscVaultV2Abi, functionName: "setParams", args: [BSC_PARAMS] }),
      encodeFunctionData({ abi: bscVaultV2Abi, functionName: "withdraw", args: [ACCOUNTS.user3.address, E(5)] }),
      encodeFunctionData({ abi: bscVaultV2Abi, functionName: "payLegacyBatch", args: [[oldKey], [ACCOUNTS.user3.address], [E(10)]] }),
    ];
    const targets = calls.map(() => H.bsc.bridge);
    const values = calls.map(() => 0n);
    await H.bsc.write(ACCOUNTS.admin, "scheduleBatch", [targets, values, calls, ZERO32, ZERO32, H48], H.bsc.timelock);
    await H.settle();
    await t.w.tick();
    const p = t.sink.alerts.filter((a) => a.code === "TIMELOCK_PROPOSED");
    expect(p).toHaveLength(1);
    expect((p[0]!.detail["calls"] as Array<{ fn: string }>).map((c) => c.fn)).toEqual(["upgradeToAndCall", "setParams", "withdraw", "payLegacyBatch"]);

    await H.bsc.increaseTime(48 * 3600 + 1);
    await H.bsc.write(ACCOUNTS.attacker, "executeBatch", [targets, values, calls, ZERO32, ZERO32], H.bsc.timelock); // executor = anyone
    await H.settle();
    t.clock.now = (await H.bsc.latest()).timestamp;
    await t.w.tick();
    expect(levelOf(t, "UPGRADE_EXECUTED")).toBe(2);
    expect(levelOf(t, "WITHDRAWN")).toBe(2);
    expect(Object.keys(t.w.state.derived.timelockOps)).toHaveLength(0);
    expect(t.w.state.derived.bsc.sums["withdrawn"]).toBe(E(5).toString());
    expect(t.w.state.derived.bsc.sums["legacyPaid"]).toBe(E(10).toString());
    expect(t.w.state.meta.daily.entries.find((e) => e.kind === "LEGACY_PAID")!.data["oldKey"]).toBe(oldKey);
    expect(t.w.state.derived.pending).toHaveLength(0); // LegacyPaid is not a Released: no §9.1-1 check
  });

  it("key / handover / recovery changes → level 1 (incl. recovery start); PAUSER revoke → level 2", async () => {
    const t = await makeWatcher(H);
    await H.bsc.write(ACCOUNTS.admin, "revokeKey", [RELAYER_ROLE, ACCOUNTS.relayer.address]);
    await H.bsc.write(ACCOUNTS.admin, "startWhitelistRecovery", [ACCOUNTS.user3.address]);
    await H.wantos.write(ACCOUNTS.wl, "startAdminRecovery", [ACCOUNTS.user3.address], H.wantos.timelock);
    await H.wantos.write(ACCOUNTS.wl, "beginWhitelistManagerTransfer", [ACCOUNTS.attacker.address]).catch(() => undefined); // blocked by recovery: no event expected
    await H.settle();
    await t.w.tick();
    const kc = t.sink.alerts.filter((a) => a.code === "KEY_CHANGE");
    expect(kc.map((a) => (a.detail["event"] as string))).toEqual(expect.arrayContaining(["RoleRevoked", "WhitelistRecoveryStarted", "AdminRecoveryStarted"]));
    expect(kc.every((a) => a.level === 1)).toBe(true);
    await H.wantos.write(ACCOUNTS.admin, "revokeKey", ["0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a", ACCOUNTS.pauser.address]);
    await H.settle();
    await t.w.tick();
    expect(levelOf(t, "PAUSER_REVOKED")).toBe(2);
  });

  it("pause / unpause / freeze / params → level 2; cross-chain params inconsistency → level 2; voiding a future orderId → level 2", async () => {
    const t = await makeWatcher(H);
    await H.wantos.write(ACCOUNTS.pauser, "pause", []);
    await H.wantos.write(ACCOUNTS.admin, "unpause", []);
    await H.wantos.write(ACCOUNTS.admin, "freezeWhitelist", []);
    await H.bsc.write(ACCOUNTS.admin, "setParams", [{ ...BSC_PARAMS, perAddrDailyCap: E(1500) }]); // tighten BSC below WANTOS w2bPerAddrDailyCap
    await H.bsc.write(ACCOUNTS.admin, "voidSource", [999n]);
    await H.settle();
    await t.w.tick();
    for (const c of ["PAUSED", "UNPAUSED", "WHITELIST_FROZEN", "PARAMS_UPDATED", "PARAMS_INCONSISTENT", "VOID_FUTURE_SOURCE"]) expect(levelOf(t, c), c).toBe(2);
    expect(String(t.sink.alerts.find((a) => a.code === "PARAMS_INCONSISTENT")!.title)).toContain("perAddrDailyCap");
  });

  it("whitelist batches, emergency removals and queue/void summaries go to the level-3 daily report", async () => {
    const t = await makeWatcher(H);
    await whitelist(H.bsc, [ACCOUNTS.attacker.address]);
    await H.bsc.write(ACCOUNTS.admin, "freezeWhitelist", []);
    await H.bsc.write(ACCOUNTS.admin, "emergencyRemove", [[ACCOUNTS.attacker.address]]);
    await H.bsc.write(ACCOUNTS.relayer, "queueRelease", [1n, ACCOUNTS.user1.address, E(1500)]);
    await H.bsc.write(ACCOUNTS.wl, "voidSource", [1n]);
    await H.wantos.write(ACCOUNTS.user1, "approve", [H.wantos.bridge, E(20)], H.wantos.token);
    await H.wantos.write(ACCOUNTS.user1, "bridgeOut", [E(20)]);
    await H.wantos.write(ACCOUNTS.admin, "requestRefund", [1n]);
    await H.settle();
    await t.w.tick();
    const kinds = t.w.state.meta.daily.entries.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["WHITELIST_BATCH", "EMERGENCY_REMOVAL", "RELEASE_QUEUED", "SOURCE_VOIDED", "REFUND_REQUESTED"]));
    const wb = t.w.state.meta.daily.entries.find((e) => e.kind === "WHITELIST_BATCH")!;
    expect(wb.data).toMatchObject({ count: "1", allowed: true });
    expect(wb.data["txHash"]).toMatch(/^0x/);
    t.clock.now += 86_400;
    await t.w.tick();
    const r = t.sink.alerts.find((a) => a.code === "DAILY_REPORT")!;
    expect(r.level).toBe(3);
    expect((r.detail["counts"] as Record<string, number>)["WHITELIST_BATCH"]).toBe(1);
  });

  it("legacy vault / relayer activity and controlled-address fund moves → level 2; controlled set change → level 2", async () => {
    const t = await makeWatcher(H, {
      config: (c) => {
        c.legacyAddresses = [
          { chain: "wantos", address: ACCOUNTS.user3.address, label: "旧付款程序（模拟）" },
          { chain: "bsc", address: H.bsc.token, label: "旧金库合约（模拟）" },
        ];
      },
      controlled: [{ address: ACCOUNTS.attacker.address, label: "受控（模拟）" }],
    });
    await H.settle();
    await t.w.tick(); // baseline nonces
    await H.wantos.write(ACCOUNTS.user3, "transfer", [ACCOUNTS.user1.address, E(1)], H.wantos.token);
    await H.wantos.write(ACCOUNTS.user1, "transfer", [ACCOUNTS.attacker.address, E(1)], H.wantos.token);
    await H.bsc.write(ACCOUNTS.user1, "transfer", [ACCOUNTS.user2.address, E(1)], H.bsc.token);
    await H.settle();
    t.clock.now += 300;
    await t.w.tick();
    const legacy = t.sink.alerts.filter((a) => a.code === "LEGACY_ACTIVITY");
    expect(legacy.map((a) => a.chain).sort()).toEqual(["bsc", "wantos", "wantos"]); // bsc contract log, wantos transfer, wantos nonce
    expect(legacy.every((a) => a.level === 2)).toBe(true);
    expect(levelOf(t, "CONTROLLED_FUNDS_MOVED")).toBe(2);
    t.controlled.list = [{ address: ACCOUNTS.user2.address, label: "new" }];
    t.clock.now += 300;
    await t.w.tick();
    const ch = t.sink.alerts.find((a) => a.code === "CONTROLLED_SET_CHANGED")!;
    expect(ch.level).toBe(2);
    expect(ch.detail["added"]).toEqual([ACCOUNTS.user2.address.toLowerCase()]);
  });

  it("gas below threshold → level 2 (deduped, re-arms after recovery)", async () => {
    const t = await makeWatcher(H, {
      config: (c) => {
        c.gasWatch = [{ chain: "bsc", address: ACCOUNTS.admin.address, label: "管理钱包", minWei: 10n ** 30n }];
      },
    });
    await t.w.tick();
    t.clock.now += 300;
    await t.w.tick();
    expect(t.sink.alerts.filter((a) => a.code === "GAS_LOW")).toHaveLength(1);
    expect(levelOf(t, "GAS_LOW")).toBe(2);
    t.cfg.gasWatch[0]!.minWei = 1n;
    t.clock.now += 300;
    await t.w.tick();
    t.cfg.gasWatch[0]!.minWei = 10n ** 30n;
    t.clock.now += 300;
    await t.w.tick();
    expect(t.sink.alerts.filter((a) => a.code === "GAS_LOW")).toHaveLength(2);
  });

  it("heartbeat every 5 minutes; heartbeat failure → level 2; relayer unreachable → level 1", async () => {
    let alive = false;
    const t = await makeWatcher(H, { relayerProbe: { isAlive: async () => alive } });
    await t.w.tick();
    t.clock.now += 100;
    await t.w.tick();
    expect(t.hb.beats).toHaveLength(1);
    t.clock.now += 200;
    await t.w.tick();
    expect(t.hb.beats).toHaveLength(2);
    expect(levelOf(t, "RELAYER_UNREACHABLE")).toBe(1);
    expect(t.sink.alerts.filter((a) => a.code === "RELAYER_UNREACHABLE")).toHaveLength(1);
    t.hb.failNext = 1;
    alive = true;
    t.clock.now += 300;
    await t.w.tick();
    expect(levelOf(t, "HEARTBEAT_FAILED")).toBe(2);
  });

  it("WANTOS block production stall and index lag → level 2", async () => {
    const t = await makeWatcher(H, {
      config: (c) => {
        c.chains.wantos.maxBlockRange = 1;
        c.chains.wantos.maxLagBlocks = 2;
        c.maxRangesPerTick = 1;
      },
    });
    await H.settle();
    await H.wantos.mine(10);
    await t.w.tick();
    expect(levelOf(t, "INDEX_LAG")).toBe(2);
    t.clock.now += 61;
    await t.w.tick();
    expect(levelOf(t, "WANTOS_STALLED")).toBe(2);
  });

  it("level-1 alerts repeat after 24h until acknowledged", async () => {
    const t = await makeWatcher(H);
    await H.bsc.write(ACCOUNTS.admin, "revokeKey", [RELAYER_ROLE, ACCOUNTS.relayer.address]);
    await H.settle();
    await t.w.tick();
    t.clock.now += 86_400;
    await t.w.tick();
    const kc = t.sink.alerts.filter((a) => a.code === "KEY_CHANGE");
    expect(kc).toHaveLength(2);
    expect(kc[1]!.repeat).toBe(true);
    t.w.alerts.ack(kc[0]!.key!);
    t.clock.now += 86_400;
    await t.w.tick();
    expect(t.sink.alerts.filter((a) => a.code === "KEY_CHANGE")).toHaveLength(2);
  });
});
