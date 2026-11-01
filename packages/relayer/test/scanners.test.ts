import { beforeEach, describe, expect, it } from "vitest";
import { FakeChain, bridgeOutLog, depositedLog, type FakeReader } from "./helpers/fakeChain";
import { newMigratedDb } from "./helpers/db";
import { MemoryAlertSink } from "../src/alerts";
import { SafetyState } from "../src/safety";
import { WantosScanner } from "../src/chain/wantosScanner";
import { BscScanner } from "../src/chain/bscScanner";
import { OrderRepo } from "../src/orders";
import { CursorRepo } from "../src/chain/cursor";
import { w2bEventKey, b2wEventKey } from "../src/eventKey";
import type { Db } from "../src/db/types";
import type { Address } from "../src/types";

const WANTOS_BRIDGE: Address = "0x1111111111111111111111111111111111111111";
const BSC_VAULT: Address = "0x1111111111111111111111111111111111111111"; // same address on both chains (§5.1)
const OTHER: Address = "0x9999999999999999999999999999999999999999";
const USER: Address = "0x00000000000000000000000000000000000000aa";
const WANTOS_ID = 13555;
const BSC_ID = 56;

describe("WANTOS scanner (DESIGN §6.2)", () => {
  let chain: FakeChain, primary: FakeReader, cross: FakeReader, db: Db, alerts: MemoryAlertSink, safety: SafetyState;
  const mk = () =>
    new WantosScanner({
      chainId: WANTOS_ID,
      bridge: WANTOS_BRIDGE,
      primary,
      crossChecks: [cross],
      confirmations: 6,
      db,
      alerts,
      safety,
      rescanBlocks: 100,
      maxBlockRange: 2000,
      startBlock: 0n,
    });

  beforeEach(async () => {
    chain = new FakeChain(5);
    primary = chain.reader("primary");
    cross = chain.reader("cross");
    db = await newMigratedDb();
    alerts = new MemoryAlertSink();
    safety = new SafetyState(alerts);
  });

  it("ingests BridgeOut only after 6 confirmations, with the PR1 eventKey", async () => {
    const { topics, data } = bridgeOutLog(1n, USER, 100n);
    chain.addEvent(WANTOS_BRIDGE, topics, data);
    chain.mine(5); // 5 confirmations only
    const s = mk();
    await s.scanOnce();
    const repo = new OrderRepo(db);
    expect(await repo.count()).toBe(0);
    chain.mine(1);
    await s.scanOnce();
    const key = w2bEventKey({ wantosChainId: BigInt(WANTOS_ID), wantosBridge: WANTOS_BRIDGE, orderId: 1n });
    const o = await repo.get(key);
    expect(o).toMatchObject({ direction: "W2B", status: "DETECTED", srcEventNonce: 1n, amountWei: 100n });
    expect(o!.userAddr.toLowerCase()).toBe(USER);
    expect(o!.toAddr.toLowerCase()).toBe(USER);
  });

  it("ignores logs whose address is not this chain's bridge, even if an RPC returns them", async () => {
    const { topics, data } = bridgeOutLog(1n, USER, 100n);
    const foreign = chain.addEvent(OTHER, topics, data);
    primary.logsOverride = (ls) => [...ls, { ...foreign }];
    chain.mine(6);
    await mk().scanOnce();
    expect(await new OrderRepo(db).count()).toBe(0);
  });

  it("requires the cross-check receipt to agree (mismatch -> no processing, cursor held, alert)", async () => {
    const { topics, data } = bridgeOutLog(1n, USER, 100n);
    const log = chain.addEvent(WANTOS_BRIDGE, topics, data);
    chain.mine(6);
    cross.receiptOverride = (_h, r) => (r ? { ...r, logs: [] } : r);
    const s = mk();
    await s.scanOnce();
    expect(await new OrderRepo(db).count()).toBe(0);
    expect(alerts.byKind("RPC_MISMATCH")).toHaveLength(1);
    const cur = await new CursorRepo(db).get(WANTOS_ID);
    expect(cur === null || cur.block < log.blockNumber).toBe(true);
    cross.receiptOverride = undefined;
    await s.scanOnce();
    expect(await new OrderRepo(db).count()).toBe(1);
  });

  it("cross-check receipt with a different block hash is a mismatch", async () => {
    const { topics, data } = bridgeOutLog(1n, USER, 100n);
    chain.addEvent(WANTOS_BRIDGE, topics, data);
    chain.mine(6);
    cross.receiptOverride = (_h, r) => (r ? { ...r, blockHash: ("0x" + "ee".repeat(32)) as `0x${string}` } : r);
    await mk().scanOnce();
    expect(await new OrderRepo(db).count()).toBe(0);
    expect(alerts.byKind("RPC_MISMATCH").length).toBeGreaterThan(0);
  });

  it("network: cross-check down -> waits with alert; primary down -> waits; all down -> no crash; recovers after", async () => {
    const { topics, data } = bridgeOutLog(1n, USER, 100n);
    chain.addEvent(WANTOS_BRIDGE, topics, data);
    chain.mine(6);
    const s = mk();
    cross.down = true;
    expect((await s.scanOnce()).status).toBe("waiting");
    expect(alerts.byKind("RPC_UNAVAILABLE").length).toBeGreaterThan(0);
    primary.down = true;
    expect((await s.scanOnce()).status).toBe("waiting");
    cross.down = false;
    expect((await s.scanOnce()).status).toBe("waiting");
    primary.down = false;
    expect((await s.scanOnce()).status).toBe("ok");
    expect(await new OrderRepo(db).count()).toBe(1);
  });

  it("block hash change at the cursor -> WANTOS_REORG level-1 alert, reorg listener, halt", async () => {
    chain.mine(10);
    const s = mk();
    const seen: string[] = [];
    safety.onReorg((side) => seen.push(side));
    await s.scanOnce();
    const cur = await new CursorRepo(db).get(WANTOS_ID);
    expect(cur).not.toBeNull();
    chain.reorgFrom(cur!.block - 2n);
    const r = await s.scanOnce();
    expect(r.status).toBe("halted");
    expect(alerts.byKind("WANTOS_REORG")).toHaveLength(1);
    expect(alerts.byKind("WANTOS_REORG")[0]!.level).toBe(1);
    expect(seen).toEqual(["wantos"]);
    expect(safety.isHalted("wantos")).toBe(true);
    // stays halted until an operator clears it
    chain.mine(3);
    expect((await s.scanOnce()).status).toBe("halted");
    expect(alerts.byKind("WANTOS_REORG")).toHaveLength(1);
  });

  it("duplicate events (rescan / restart) never create duplicate orders", async () => {
    for (let i = 1n; i <= 3n; i++) {
      const { topics, data } = bridgeOutLog(i, USER, 10n * i);
      chain.addEvent(WANTOS_BRIDGE, topics, data);
    }
    chain.mine(6);
    await mk().scanOnce();
    await mk().scanOnce(); // fresh process: rescans last 100 blocks
    await mk().scanOnce();
    expect(await new OrderRepo(db).count()).toBe(3);
  });

  it("restart rescans 100 blocks back from the cursor", async () => {
    chain.mine(300);
    await mk().scanOnce();
    const cur = (await new CursorRepo(db).get(WANTOS_ID))!;
    chain.mine(1);
    primary.calls.length = 0;
    await mk().scanOnce();
    const getLogs = primary.calls.find((c) => c.method === "getLogs")!.args as { fromBlock: bigint };
    expect(getLogs.fromBlock).toBe(cur.block - 100n + 1n);
  });

  it("scans in bounded ranges", async () => {
    chain.mine(30);
    const s = new WantosScanner({ chainId: WANTOS_ID, bridge: WANTOS_BRIDGE, primary, crossChecks: [cross], confirmations: 6, db, alerts, safety, rescanBlocks: 100, maxBlockRange: 10, startBlock: 0n });
    await s.scanOnce();
    expect((await new CursorRepo(db).get(WANTOS_ID))!.block).toBe(9n);
  });
});

describe("BSC scanner (DESIGN §6.2: >=2 RPCs, finalized only)", () => {
  let chain: FakeChain, a: FakeReader, b: FakeReader, db: Db, alerts: MemoryAlertSink, safety: SafetyState;
  const mk = () =>
    new BscScanner({ chainId: BSC_ID, vault: BSC_VAULT, readers: [a, b], db, alerts, safety, rescanBlocks: 100, maxBlockRange: 5000, startBlock: 0n });

  beforeEach(async () => {
    chain = new FakeChain(5);
    a = chain.reader("bsc-a");
    b = chain.reader("bsc-b");
    db = await newMigratedDb();
    alerts = new MemoryAlertSink();
    safety = new SafetyState(alerts);
  });

  it("rejects construction with fewer than 2 readers", () => {
    expect(() => new BscScanner({ chainId: BSC_ID, vault: BSC_VAULT, readers: [a], db, alerts, safety, rescanBlocks: 100, maxBlockRange: 10, startBlock: 0n })).toThrow(/2/);
  });

  it("processes Deposited only once finalized; eventKey uses BSC chain id + vault + nonce", async () => {
    const { topics, data } = depositedLog(1n, USER, OTHER, 50n);
    chain.addEvent(BSC_VAULT, topics, data);
    chain.mine(10); // not finalized yet (lag 64)
    const s = mk();
    await s.scanOnce();
    expect(await new OrderRepo(db).count()).toBe(0);
    chain.mine(64);
    await s.scanOnce();
    const key = b2wEventKey({ bscChainId: BigInt(BSC_ID), bscVault: BSC_VAULT, depositNonce: 1n });
    const o = await new OrderRepo(db).get(key);
    expect(o).toMatchObject({ direction: "B2W", status: "DETECTED", amountWei: 50n });
    expect(o!.userAddr.toLowerCase()).toBe(USER);
    expect(o!.toAddr.toLowerCase()).toBe(OTHER);
  });

  it("finalized unavailable on one RPC -> waits (no degradation) and alerts", async () => {
    const { topics, data } = depositedLog(1n, USER, OTHER, 50n);
    chain.addEvent(BSC_VAULT, topics, data);
    chain.mine(80);
    b.noFinalized = true;
    const s = mk();
    expect((await s.scanOnce()).status).toBe("waiting");
    expect(alerts.byKind("BSC_FINALIZED_UNAVAILABLE")).toHaveLength(1);
    expect(await new OrderRepo(db).count()).toBe(0);
    b.noFinalized = false;
    b.down = true;
    expect((await s.scanOnce()).status).toBe("waiting");
    b.down = false;
    expect((await s.scanOnce()).status).toBe("ok");
    expect(await new OrderRepo(db).count()).toBe(1);
  });

  it("uses the lower of the two finalized heights", async () => {
    chain.mine(200);
    b.blockHashOverride = undefined;
    const s = mk();
    const fin = await s.agreedFinalized();
    expect(fin!.number).toBe(chain.head - 64n);
  });

  it("finalized block hash disagreement between RPCs -> waits with RPC_MISMATCH", async () => {
    chain.mine(100);
    b.blockHashOverride = (_n, h) => (("0x" + "ab".repeat(32)) as `0x${string}`);
    expect((await mk().scanOnce()).status).toBe("waiting");
    expect(alerts.byKind("RPC_MISMATCH").length).toBeGreaterThan(0);
  });

  it("log sets disagreeing between RPCs -> waits with RPC_MISMATCH", async () => {
    const { topics, data } = depositedLog(1n, USER, OTHER, 50n);
    chain.addEvent(BSC_VAULT, topics, data);
    chain.mine(80);
    b.logsOverride = () => [];
    expect((await mk().scanOnce()).status).toBe("waiting");
    expect(await new OrderRepo(db).count()).toBe(0);
    expect(alerts.byKind("RPC_MISMATCH").length).toBeGreaterThan(0);
  });

  it("BSC reorg below the stored cursor -> BSC_REORG alert and halt", async () => {
    chain.mine(100);
    const s = mk();
    await s.scanOnce();
    const cur = (await new CursorRepo(db).get(BSC_ID))!;
    chain.reorgFrom(cur.block);
    expect((await s.scanOnce()).status).toBe("halted");
    expect(alerts.byKind("BSC_REORG")).toHaveLength(1);
    expect(safety.isHalted("bsc")).toBe(true);
  });

  it("ignores foreign-address Deposited logs", async () => {
    const { topics, data } = depositedLog(1n, USER, OTHER, 50n);
    const foreign = chain.addEvent(OTHER, topics, data);
    a.logsOverride = (ls) => [...ls, { ...foreign }];
    b.logsOverride = (ls) => [...ls, { ...foreign }];
    chain.mine(80);
    await mk().scanOnce();
    expect(await new OrderRepo(db).count()).toBe(0);
  });
});
