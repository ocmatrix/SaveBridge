import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import type { Db } from "@bridge/relayer/src/db/types";
import { addrFromBytes, fromBytes } from "@bridge/relayer/src/bytes";
import { A, MG, PAIR, USDT, U, newRiskDb, testConfig } from "./helpers/fx";
import { FakeIndexChain, swapLog, transferLog } from "./helpers/fakeChain";
import { TxIndexer } from "../src/indexer";
import { getState } from "../src/store";
import { MemoryRiskAlerts } from "../src/alerts";
import { migrateRisk } from "../src/migrations";

const C = A("c001");
const X = A("a001");
const Y = A("a002");
const ROUTER = A("707e");

async function setup(o: { native?: boolean; range?: number; keep?: number; start?: bigint } = {}) {
  const db = await newRiskDb();
  const chain = new FakeIndexChain();
  const alerts = new MemoryRiskAlerts();
  const ix = new TxIndexer({ db, reader: chain, cfg: testConfig(), confirmations: 6, startBlock: o.start ?? 1n, maxBlockRange: o.range ?? 1000, indexNative: o.native ?? true, keepCheckpoints: o.keep, alerts, now: () => new Date(1_800_000_000_000) });
  return { db, chain, alerts, ix };
}

async function flows(db: Db) {
  const r = await db.query<Record<string, any>>("select * from risk_flows order by block_number, log_index");
  return r.rows.map((x) => ({
    block: Number(x.block_number),
    asset: x.asset as string,
    from: addrFromBytes(x.from_addr),
    to: addrFromBytes(x.to_addr),
    src: addrFromBytes(x.src),
    amount: BigInt(x.amount),
    value: BigInt(x.value_usdt),
    li: Number(x.log_index),
  }));
}

describe("TxIndexer", () => {
  it("indexes token transfers, native transfers and swaps; pool outputs take the tx sender as source and the Swap amount as value", async () => {
    const { db, chain, ix } = await setup();
    chain.add([
      { from: C, to: USDT, logs: [(t) => transferLog(USDT, C, X, 100n * U, t)] },
      { from: C, to: X, value: 5n * U }, // native
      { from: C, to: MG, logs: [(t) => transferLog(MG, C, Y, 7n, t)] },
    ]);
    // C swaps MG→USDT through the router, to = X: MG C→PAIR, USDT PAIR→X, Swap(PAIR, out1 = 40 USDT)
    chain.add([
      {
        from: C,
        to: ROUTER,
        logs: [
          (t) => transferLog(MG, C, PAIR, 9n, t),
          (t) => transferLog(USDT, PAIR, X, 40n * U, t),
          (t) => swapLog(PAIR, ROUTER, X, [9n, 0n, 0n, 40n * U], t),
        ],
      },
    ]);
    chain.mine(6);
    await ix.tick();
    const st = (await getState(db))!;
    expect(st.lastBlock).toBe(2n); // head 8 − 6 confirmations
    expect(st.headBlock).toBe(8n);
    expect(await flows(db)).toEqual([
      { block: 1, asset: "NATIVE", from: C, to: X, src: C, amount: 5n * U, value: 0n, li: -1 },
      { block: 1, asset: "USDT", from: C, to: X, src: C, amount: 100n * U, value: 100n * U, li: 0 },
      { block: 1, asset: "MG", from: C, to: Y, src: C, amount: 7n, value: 0n, li: 1 },
      { block: 2, asset: "MG", from: C, to: PAIR, src: C, amount: 9n, value: 0n, li: 0 },
      { block: 2, asset: "USDT", from: PAIR, to: X, src: C, amount: 40n * U, value: 40n * U, li: 1 },
    ]);
    const sw = await db.query<Record<string, any>>("select * from risk_swaps");
    expect(sw.rows.length).toBe(1);
    expect(getAddress(fromBytes(sw.rows[0]!.tx_from)!)).toBe(C);
  });

  it("B2: pair output is valued at the transfer amount; Swap is kept for cross-checks only", async () => {
    const { db, chain, ix } = await setup();
    chain.add([{ from: C, to: ROUTER, logs: [(t) => transferLog(USDT, PAIR, X, 41n, t), (t) => swapLog(PAIR, ROUTER, X, [9n, 0n, 0n, 40n], t)] }]);
    chain.add([{ from: C, to: ROUTER, logs: [(t) => transferLog(USDT, PAIR, X, 41n, t)] }]); // no Swap (e.g. LP burn) → transfer amount
    chain.add([{ from: C, to: ROUTER, logs: [(t) => transferLog(USDT, PAIR, Y, 41n, t), (t) => swapLog(PAIR, ROUTER, X, [9n, 0n, 0n, 40n], t)] }]); // Swap to someone else
    chain.mine(6);
    await ix.tick();
    expect((await flows(db)).map((f) => f.value)).toEqual([41n, 41n, 41n]);
  });

  it("B2: a skim followed by a tiny swap in the same tx keeps the skimmed value (no Swap mis-pairing)", async () => {
    const { db, chain, ix } = await setup({ native: false });
    chain.add([
      {
        from: C,
        to: ROUTER,
        logs: [
          (t) => transferLog(USDT, C, PAIR, 10_000n * U, t),
          (t) => transferLog(USDT, PAIR, X, 10_000n * U, t), // skim
          (t) => transferLog(USDT, PAIR, X, 1n, t), // tiny swap output
          (t) => swapLog(PAIR, ROUTER, X, [1n, 0n, 0n, 1n], t),
        ],
      },
    ]);
    chain.mine(6);
    await ix.tick();
    expect((await flows(db)).filter((f) => f.to === X).map((f) => [f.amount, f.value, f.src])).toEqual([
      [10_000n * U, 10_000n * U, C],
      [1n, 1n, C],
    ]);
  });

  it("A1: 0-amount Transfer events are not indexed", async () => {
    const { db, chain, ix } = await setup();
    chain.add([
      { from: A("bad1"), to: USDT, logs: [(t) => transferLog(USDT, C, X, 0n, t)] }, // transferFrom(C, X, 0) by anyone
      { from: C, to: MG, logs: [(t) => transferLog(MG, C, X, 0n, t)] },
      { from: C, to: USDT, logs: [(t) => transferLog(USDT, C, X, 1n, t)] },
    ]);
    chain.mine(6);
    await ix.tick();
    expect((await flows(db)).map((f) => [f.asset, f.amount])).toEqual([["USDT", 1n]]);
  });

  it("indexNative: a broken parentHash link inside the range aborts the tick without writing", async () => {
    const { db, chain, ix } = await setup({ native: true });
    chain.add([{ from: C, to: USDT, logs: [(t) => transferLog(USDT, C, X, 1n, t)] }]); // 1
    chain.mine(10);
    chain.blocks[3]!.parentHash = `0x${"ab".repeat(32)}`; // 3 does not follow 2
    await expect(ix.tick()).rejects.toThrow(/parent/);
    expect(await flows(db)).toEqual([]);
    expect((await getState(db))!.lastBlock).toBe(0n);
  });

  it("indexer alerts carry redacted error text", async () => {
    const { chain, alerts, ix } = await setup();
    chain.mine(10);
    chain.getLogs = async () => {
      throw new Error("request to https://u:pw@rpc.example.invalid/key/ABCDEF?token=SECRET failed");
    };
    await ix.runTick();
    expect(alerts.alerts[0]!.message).toContain("rpc.example.invalid");
    expect(alerts.alerts[0]!.message).not.toMatch(/pw@|ABCDEF|SECRET/);
  });

  it("skips reverted native transfers, zero-value txs, contract creations and non-ERC20 Transfer logs", async () => {
    const { db, chain, ix } = await setup();
    const bad = chain.tx();
    chain.failed.add(bad);
    chain.add([
      { tx: bad, from: C, to: X, value: 1n },
      { from: C, to: X, value: 0n },
      { from: C, to: null, value: 3n },
      { from: C, to: C, value: 3n },
      { from: C, to: USDT, logs: [(t) => ({ ...transferLog(USDT, C, X, 1n, t), topics: [...transferLog(USDT, C, X, 1n, t).topics, `0x${"00".repeat(32)}`] })] },
    ]);
    chain.mine(6);
    await ix.tick();
    expect(await flows(db)).toEqual([]);
  });

  it("indexNative=false fetches only blocks with logs (and the range end)", async () => {
    const { db, chain, ix } = await setup({ native: false });
    chain.mine(3);
    chain.add([{ from: C, to: X, value: 1n }, { from: C, to: USDT, logs: [(t) => transferLog(USDT, C, X, 1n, t)] }]);
    chain.mine(10);
    await ix.tick();
    expect((await flows(db)).map((f) => f.asset)).toEqual(["USDT"]);
    expect(chain.calls.getBlock).toBe(4); // init(0) + cursor check(0) + block 4 (logs) + range end 8 — not blocks 1..8
  });

  it("respects maxBlockRange and continues from the cursor", async () => {
    const { db, chain, ix } = await setup({ range: 3 });
    chain.mine(20);
    expect(await ix.tick()).toEqual({ from: 1n, to: 3n });
    expect(await ix.tick()).toEqual({ from: 4n, to: 6n });
    expect((await getState(db))!.lastBlock).toBe(6n);
  });

  it("caught up: refreshes head/checkedAt only", async () => {
    const { db, chain, ix } = await setup();
    chain.mine(8);
    await ix.tick();
    expect(await ix.tick()).toBeNull();
    expect((await getState(db))!.lastBlock).toBe(2n);
  });

  it("a reorg at the cursor rewinds to the newest canonical checkpoint and re-indexes the new branch", async () => {
    const { db, chain, alerts, ix } = await setup({ range: 2 });
    chain.add([{ from: C, to: USDT, logs: [(t) => transferLog(USDT, C, X, 1n, t)] }]); // 1
    chain.add([{ from: C, to: USDT, logs: [(t) => transferLog(USDT, C, X, 2n, t)] }]); // 2
    chain.add([{ from: C, to: USDT, logs: [(t) => transferLog(USDT, C, X, 3n, t)] }]); // 3
    chain.mine(10);
    await ix.tick(); // 1..2
    await ix.tick(); // 3..4
    expect((await flows(db)).map((f) => f.amount)).toEqual([1n, 2n, 3n]);
    chain.reorgFrom(3n);
    chain.add([{ from: C, to: USDT, logs: [(t) => transferLog(USDT, C, Y, 33n, t)] }]); // new 3
    chain.mine(12);
    await ix.tick(); // detects, rewinds to 2
    expect((await getState(db))!.lastBlock).toBe(2n);
    expect((await flows(db)).map((f) => f.amount)).toEqual([1n, 2n]);
    expect(alerts.alerts.map((a) => a.kind)).toEqual(["INDEX_REORG"]);
    await ix.tick();
    expect((await flows(db)).map((f) => [f.amount, f.to])).toEqual([[1n, X], [2n, X], [33n, Y]]);
  });

  it("a same-height reorg while caught up is detected at the cursor", async () => {
    const { db, chain, alerts, ix } = await setup({ range: 2 });
    chain.add([{ from: C, to: USDT, logs: [(t) => transferLog(USDT, C, X, 1n, t)] }]); // 1
    chain.add([{ from: C, to: USDT, logs: [(t) => transferLog(USDT, C, X, 2n, t)] }]); // 2
    chain.mine(8); // head 10
    await ix.tick(); // 1..2
    await ix.tick(); // 3..4
    chain.reorgFrom(3n);
    chain.mine(8); // head 10 again, blocks 3.. have new hashes; nothing new to index
    await ix.tick();
    expect(alerts.alerts.map((a) => a.kind)).toEqual(["INDEX_REORG"]);
    expect((await getState(db))!.lastBlock).toBe(2n);
  });

  it("a reorg deeper than every checkpoint marks the index broken until rewindTo()", async () => {
    const { db, chain, alerts, ix } = await setup({ range: 2 });
    chain.mine(12);
    await ix.tick();
    await ix.tick();
    chain.reorgFrom(1n);
    chain.mine(14);
    await ix.tick();
    expect((await getState(db))!.broken).toMatch(/reorg/);
    expect(await ix.tick()).toBeNull(); // stays broken
    expect(alerts.alerts.map((a) => a.kind)).toEqual(["INDEX_BROKEN", "INDEX_BROKEN"]);
    await ix.rewindTo(0n);
    expect((await getState(db))!.broken).toBeNull();
    await ix.tick();
    expect((await getState(db))!.lastBlock).toBe(2n);
  });

  it("parent-hash discontinuity at the start of a range is treated as a reorg", async () => {
    const { db, chain, ix } = await setup({ range: 2 });
    chain.mine(12);
    await ix.tick(); // 1..2
    // make block 3 claim a different parent without changing block 2 (node inconsistency)
    chain.blocks[3]!.parentHash = `0x${"ab".repeat(32)}`;
    expect(await ix.tick()).toBeNull();
    expect((await getState(db))!.broken).toMatch(/reorg/); // no older checkpoint → broken (never guesses)
  });

  it("log/block hash mismatch inside a range aborts the tick without writing", async () => {
    const { db, chain, ix } = await setup();
    chain.add([{ from: C, to: USDT, logs: [(t) => transferLog(USDT, C, X, 1n, t)] }]);
    chain.mine(8);
    const orig = chain.getLogs.bind(chain);
    chain.getLogs = async (a) => (await orig(a)).map((l) => ({ ...l, blockHash: `0x${"cd".repeat(32)}` }));
    await expect(ix.tick()).rejects.toThrow(/mismatch/);
    expect(await flows(db)).toEqual([]);
    expect((await getState(db))!.lastBlock).toBe(0n);
  });

  it("runTick never throws; failures are alerted and retried", async () => {
    const { db, chain, alerts, ix } = await setup();
    chain.mine(10);
    chain.failNext = "getLogs";
    await ix.runTick();
    expect(alerts.alerts.map((a) => a.kind)).toEqual(["INDEX_ERROR"]);
    await ix.runTick();
    expect((await getState(db))!.lastBlock).toBe(4n);
  });

  it("re-indexing the same range is idempotent; checkpoints are pruned", async () => {
    const { db, chain, ix } = await setup({ range: 1, keep: 3 });
    chain.add([{ from: C, to: USDT, logs: [(t) => transferLog(USDT, C, X, 1n, t)] }]);
    chain.mine(12);
    for (let i = 0; i < 5; i++) await ix.tick();
    await ix.rewindTo(0n);
    for (let i = 0; i < 5; i++) await ix.tick();
    expect((await flows(db)).length).toBe(1);
    const cps = await db.query<{ n: string }>("select block_number::text n from risk_index_checkpoints order by 1");
    expect(cps.rows.map((r) => r.n)).toEqual(["3", "4", "5"]);
  });

  it("startBlock > 0 anchors the cursor at startBlock − 1; validation of options", async () => {
    const { db, chain, ix } = await setup({ start: 3n });
    chain.mine(12);
    await ix.tick();
    expect((await getState(db))!.lastBlock).toBe(6n);
    const s2 = await setup({ start: 50n });
    await expect(s2.ix.tick()).rejects.toThrow(/unavailable/);
    expect(() => new TxIndexer({ db, reader: chain, cfg: testConfig(), confirmations: 5, startBlock: 0n, maxBlockRange: 1, indexNative: false })).toThrow();
    expect(() => new TxIndexer({ db, reader: chain, cfg: testConfig(), confirmations: 6, startBlock: 0n, maxBlockRange: 0, indexNative: false })).toThrow();
  });

  it("migrations are re-runnable", async () => {
    const { db } = await setup();
    await migrateRisk(db);
    await migrateRisk(db);
    const r = await db.query<{ v: number }>("select version v from schema_migrations where version >= 400");
    expect(r.rows.map((x) => x.v)).toEqual([401]);
  });
});
