import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseEther, type Abi, type PublicClient } from "viem";
import { startWorld, whitelistBoth, buildRelayer, bridgeOut, confirmWantos, WANTOS_ID, BSC_ID, type World } from "@bridge/relayer/test/helpers/system";
import { U, tokenAbi, write } from "@bridge/relayer/test/helpers/deploy";
import { newMigratedDb } from "@bridge/relayer/test/helpers/db";
import { MemoryAlertSink } from "@bridge/relayer/src/alerts";
import { BridgeView } from "@bridge/relayer/src/chain/bridges";
import { DefaultRiskEngine } from "@bridge/relayer/src/risk";
import { w2bEventKey } from "@bridge/relayer/src/eventKey";
import { OrderRepo } from "@bridge/relayer/src/orders";
import { reviewMessage } from "@bridge/relayer/src/review";
import type { Hex } from "@bridge/relayer/src/types";
import { defaultParams, parseRiskConfig } from "../src/config";
import { migrateRisk } from "../src/migrations";
import { TxIndexer, ViemIndexReader } from "../src/indexer";
import { SourceRiskEngine } from "../src/engine";
import { upsertControlled } from "../src/store";
import { A } from "./helpers/fx";

/** Local anvil only (127.0.0.1): real logs/blocks through ViemIndexReader + the PR-3 processor. */
describe("e2e: index on anvil + SourceRiskEngine inside the PR-3 relayer", () => {
  let world: World;
  let snaps: { w: Hex; b: Hex };
  const wKey = (id: bigint) => w2bEventKey({ wantosChainId: BigInt(WANTOS_ID), wantosBridge: world.w.bridge, orderId: id });
  const actions = async (db: { query: Function }) => ((await (db as any).query("select action from tx_attempts order by id")).rows as { action: string }[]).map((r) => r.action);
  const transfer = (from: World["act"]["user"], to: Hex, amount: bigint) => write(world.wantos, from, world.w.token, tokenAbi as Abi, "transfer", [to, amount]);

  beforeAll(async () => {
    world = await startWorld();
    await whitelistBoth(world, [world.act.user.address, world.act.user2.address]);
  });
  afterAll(async () => world?.stop());
  beforeEach(async () => {
    snaps = { w: await world.wantos.testClient.snapshot(), b: await world.bsc.testClient.snapshot() };
  });
  afterEach(async () => {
    await world.wantos.testClient.revert({ id: snaps.w });
    await world.bsc.testClient.revert({ id: snaps.b });
  });

  async function build() {
    const db = await newMigratedDb();
    await migrateRisk(db);
    const cfg = parseRiskConfig({
      usdt: world.w.token,
      otherTokens: [],
      pairs: [{ address: A("9a10"), usdtIndex: 1 }],
      bridge: world.w.bridge,
      exempt: [],
      params: { ...defaultParams(18), freshMinAmount: 10n ** 30n }, // all fixture funds are minutes old
    });
    const wc = world.wantos.publicClient as unknown as PublicClient;
    const bc = world.bsc.publicClient as unknown as PublicClient;
    const ix = new TxIndexer({ db, reader: new ViemIndexReader(wc), cfg, confirmations: 6, startBlock: 0n, maxBlockRange: 5000, indexNative: true });
    const alerts = new MemoryAlertSink();
    const inner = new DefaultRiskEngine(new BridgeView("wantos", wc, world.w.bridge), new BridgeView("bsc", bc, world.b.bridge), alerts);
    const risk = new SourceRiskEngine({ db, inner, cfg });
    const sys = await buildRelayer(world, { db, alerts, risk });
    const approve = async (key: Hex) => {
      const exp = BigInt(Math.floor(sys.clock.now / 1000) + 600);
      const sig = await world.act.admin.signMessage({ message: reviewMessage({ chainId: BSC_ID, eventKey: key, decision: "approve", expires: exp }) });
      await sys.relayer.review.decide({ eventKey: key, decision: "approve", expires: exp, signature: sig });
    };
    return { db, ix, sys, approve, repo: new OrderRepo(db) };
  }

  it("controlled funds (23%) → REVIEW(freeze, controlled_source); native transfers are indexed", async () => {
    const { db, ix, sys, repo } = await build();
    await upsertControlled(db, "test", { addr: world.act.funder.address });
    await transfer(world.act.funder, world.act.user.address, 30_000n * U); // user: 100k minted + 30k controlled
    await world.wantos.walletClient.sendTransaction({ account: world.act.funder, to: world.act.user2.address, value: parseEther("1"), chain: world.wantos.chain });
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await ix.tick();
    await sys.relayer.tick();
    expect(await repo.get(wKey(1n))).toMatchObject({ status: "REVIEW", reviewLevel: "freeze", reason: "controlled_source" });
    expect(await actions(db)).toEqual([]);
    const n = await db.query<{ n: string }>("select count(*)::text n from risk_flows where asset = 'NATIVE' and value_usdt = 0");
    expect(Number(n.rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it("index not caught up → WAITING(index); once indexed and clean → AUTO release", async () => {
    const { db, ix, sys, repo } = await build();
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await sys.relayer.tick();
    expect(await repo.get(wKey(1n))).toMatchObject({ status: "WAITING", reason: "index" });
    await ix.tick();
    await sys.relayer.tick();
    expect(await actions(db)).toEqual(["release"]);
  });

  it("approved REVIEW for the same level+reason proceeds as DELAY (queueRelease)", async () => {
    const { db, ix, sys, repo, approve } = await build();
    await upsertControlled(db, "test", { addr: world.act.funder.address });
    await transfer(world.act.funder, world.act.user.address, 10_000n * U); // 10k / 110k = 9% → audit
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await ix.tick();
    await sys.relayer.tick();
    expect(await repo.get(wKey(1n))).toMatchObject({ status: "REVIEW", reviewLevel: "audit", reason: "controlled_source" });
    await approve(wKey(1n));
    await ix.tick();
    await sys.relayer.tick();
    expect(await actions(db)).toEqual(["queueRelease"]);
  });

  it("a new finding after approval (level audit → freeze) voids the approval; nothing is sent", async () => {
    const { db, ix, sys, repo, approve } = await build();
    await upsertControlled(db, "test", { addr: world.act.funder.address });
    await transfer(world.act.funder, world.act.user.address, 10_000n * U);
    await transfer(world.act.user2, world.act.user.address, 20_000n * U);
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await ix.tick();
    await sys.relayer.tick();
    expect(await repo.get(wKey(1n))).toMatchObject({ status: "REVIEW", reviewLevel: "audit", reason: "controlled_source" }); // 10/130 = 7.7%
    await approve(wKey(1n));
    await upsertControlled(db, "test", { addr: world.act.user2.address }); // now 30/130 = 23%
    await ix.tick();
    await sys.relayer.tick();
    await sys.relayer.tick();
    const o = (await repo.get(wKey(1n)))!;
    expect(o).toMatchObject({ status: "REVIEW", reviewLevel: "freeze", reason: "controlled_source" });
    expect(o.approvedAt).toBeNull();
    expect(await actions(db)).toEqual([]);
  });
});
