import { getAddress, keccak256, toHex } from "viem";
import { PGlite } from "@electric-sql/pglite";
import { PgliteDb } from "@bridge/relayer/src/db/pglite";
import { migrate } from "@bridge/relayer/src/db/migrations";
import type { Db } from "@bridge/relayer/src/db/types";
import { OrderRepo, type Order } from "@bridge/relayer/src/orders";
import type { RiskDecision, RiskEngine } from "@bridge/relayer/src/risk";
import type { Address, Hex } from "@bridge/relayer/src/types";
import { defaultParams, parseRiskConfig, type RiskConfig, type RiskParams } from "../../src/config";
import { migrateRisk } from "../../src/migrations";
import { insertFlows, putState, upsertControlled } from "../../src/store";
import { SourceRiskEngine } from "../../src/engine";
import { MemoryRiskAlerts } from "../../src/alerts";

export const U = 10n ** 18n;
export const MIN = 60_000;
export const H = 60 * MIN;
export const DAY = 24 * H;
export const T0 = Date.UTC(2026, 9, 15); // 2026-10-15

export const A = (n: number | string): Address => getAddress(`0x${(typeof n === "number" ? n.toString(16) : n).padStart(40, "0")}`);
export const USDT = A("05d7");
export const MG = A("0306");
export const BRIDGE = A("b41d");
export const PAIR = A("9a10"); // MG/USDT, USDT = token1
export const EXCH = A("e8c4");

export async function newRiskDb(): Promise<Db> {
  const db = new PgliteDb(new PGlite());
  await migrate(db);
  await migrateRisk(db);
  return db;
}

export function testConfig(over: Partial<RiskParams> = {}): RiskConfig {
  return parseRiskConfig({
    usdt: USDT,
    otherTokens: [{ symbol: "MG", address: MG }],
    pairs: [{ address: PAIR, usdtIndex: 1 }],
    bridge: BRIDGE,
    exempt: [EXCH],
    params: { ...defaultParams(18), ...over },
  });
}

export class Fx {
  private n = 0;
  private orderNonce = 0n;
  readonly alerts = new MemoryRiskAlerts();
  inner: RiskDecision = { kind: "AUTO" };
  innerCalls = 0;
  clock = { now: T0 + 40 * DAY };
  engine: SourceRiskEngine;
  constructor(
    readonly db: Db,
    readonly cfg: RiskConfig,
  ) {
    const innerEngine: RiskEngine = {
      evaluate: async () => {
        this.innerCalls++;
        return this.inner;
      },
    };
    this.engine = new SourceRiskEngine({ db, inner: innerEngine, cfg, alerts: this.alerts, now: () => new Date(this.clock.now) });
  }

  static async create(over: Partial<RiskParams> = {}): Promise<Fx> {
    const fx = new Fx(await newRiskDb(), testConfig(over));
    await fx.healthy();
    return fx;
  }

  /** Index state: caught up far beyond any fixture block, checked "now". */
  async healthy(lastBlock = 10_000_000_000n): Promise<void> {
    await putState(this.db, { lastBlock, lastBlockHash: keccak256(toHex(lastBlock)), lastBlockTime: null, headBlock: lastBlock + 6n, checkedAt: new Date(this.clock.now), broken: null });
  }

  async controlled(addr: Address, effectiveFrom: Date | null = null): Promise<void> {
    await upsertControlled(this.db, "test", { addr, label: "t", effectiveFrom });
  }

  private nextTx(): Hex {
    return keccak256(toHex(`tx-${++this.n}`));
  }

  /** One value movement. `txFrom` defaults to `from`; pair outputs take src = txFrom (as the indexer does). */
  async flow(o: { from: Address; to: Address; amount: bigint; at: number; asset?: string; txFrom?: Address; value?: bigint; tx?: Hex; logIndex?: number }): Promise<Hex> {
    const asset = o.asset ?? "USDT";
    const txFrom = o.txFrom ?? o.from;
    const tx = o.tx ?? this.nextTx();
    const isPair = o.from.toLowerCase() === PAIR.toLowerCase();
    await insertFlows(this.db, [
      {
        txHash: tx,
        logIndex: o.logIndex ?? 0,
        blockNumber: BigInt(Math.floor(o.at / 1000)),
        blockHash: keccak256(toHex(`b-${Math.floor(o.at / 1000)}`)),
        blockTime: new Date(o.at),
        asset,
        from: o.from,
        to: o.to,
        txFrom,
        src: isPair ? txFrom : o.from,
        amount: o.amount,
        valueUsdt: o.value ?? (asset === "USDT" ? o.amount : 0n),
      },
    ]);
    return tx;
  }

  /** A W2B order by `user` at time `at`: its USDT transfer to the bridge in the index + the orders row. */
  async bridgeOut(user: Address, amount: bigint, at: number): Promise<Order> {
    const tx = await this.flow({ from: user, to: BRIDGE, amount, at });
    const id = ++this.orderNonce;
    const key = keccak256(toHex(`order-${id}-${user}`));
    const repo = new OrderRepo(this.db);
    await repo.insertDetected({
      eventKey: key,
      direction: "W2B",
      srcChain: 31337,
      srcEventNonce: id,
      srcTxHash: tx,
      srcBlockNumber: BigInt(Math.floor(at / 1000)),
      srcBlockHash: keccak256(toHex(`b-${Math.floor(at / 1000)}`)),
      userAddr: user,
      toAddr: user,
      amountWei: amount,
    });
    return (await repo.get(key))!;
  }

  evaluate(o: Order) {
    return this.engine.evaluate(o, { outstandingWei: 0n });
  }

  async counts(): Promise<string> {
    const r = await this.db.query<{ t: string; n: string }>(
      `select 'flows' t, count(*)::text n from risk_flows union all select 'swaps', count(*)::text from risk_swaps
       union all select 'state', count(*)::text from risk_index_state union all select 'orders', count(*)::text from orders
       union all select 'audit', count(*)::text from audit_log union all select 'cs', count(*)::text from controlled_set`,
    );
    return JSON.stringify(r.rows);
  }
}
