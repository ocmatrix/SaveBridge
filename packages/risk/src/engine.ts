import type { Db } from "@bridge/relayer/src/db/types";
import type { Order } from "@bridge/relayer/src/orders";
import type { RiskContext, RiskDecision, RiskEngine } from "@bridge/relayer/src/risk";
import type { ReviewLevel } from "@bridge/relayer/src/stateMachine";
import type { Address } from "@bridge/relayer/src/types";
import { toBig } from "@bridge/relayer/src/bytes";
import { ZERO_ADDRESS, type RiskConfig } from "./config";
import { b, getState } from "./store";
import type { RiskAlertSink } from "./alerts";
import { errText } from "@bridge/relayer/src/redact";

export interface Finding {
  level: ReviewLevel;
  /** Internal only — stored in orders.reason, never shown to users (§7 对外不公开). */
  reason: "controlled_source" | "fresh_funds" | "common_funder";
  detail?: Record<string, string | number | string[]>;
}
export type Assessment = { kind: "WAIT"; why: string } | { kind: "OK"; findings: Finding[] };

export interface SourceRiskOpts {
  db: Db;
  /** The PR-3 on-chain checks (DefaultRiskEngine): paused, whitelists, quotas, reserve, largeThreshold. */
  inner: RiskEngine;
  cfg: RiskConfig;
  alerts?: RiskAlertSink;
  now?: () => Date;
}

const RANK: Record<ReviewLevel, number> = { audit: 1, freeze: 2 };
const INDEX_WAIT: RiskDecision = { kind: "WAIT", reason: "index" };

/**
 * PR-4 risk engine (DESIGN §7). Wraps the PR-3 engine and adds fund-source tracing and behaviour rules
 * for W2B (WANTOS → BSC); B2W is passed through unchanged.
 *
 *  - inner WAIT → returned as is (on-chain gates first; nothing else can override them).
 *  - index unavailable / behind / not yet covering the order → WAIT("index") (§7 降级: never relaxes).
 *  - findings and an inner REVIEW are merged into ONE REVIEW: level = the highest, reason = all reasons
 *    sorted and joined with "+". An owner approval covers exactly that level+reason (processor, Gate2
 *    A1), so a new finding (or a higher level) always voids an older approval.
 *  - otherwise the inner AUTO / DELAY.
 * Read-only on the database; the only side effect is the §7 "并告警" alert of the common-funder rule.
 */
export class SourceRiskEngine implements RiskEngine {
  private readonly now: () => Date;
  constructor(private readonly o: SourceRiskOpts) {
    this.now = o.now ?? (() => new Date());
  }

  async evaluate(order: Order, ctx: RiskContext): Promise<RiskDecision> {
    const d = await this.o.inner.evaluate(order, ctx);
    if (order.direction !== "W2B" || d.kind === "WAIT") return d;
    let a: Assessment;
    try {
      a = await this.assess(order);
    } catch (e) {
      await this.o.alerts?.emit({ kind: "INDEX_ERROR", key: "risk-assess", message: `risk assessment failed: ${errText(e)}` }).catch(() => undefined);
      return INDEX_WAIT;
    }
    if (a.kind === "WAIT") return INDEX_WAIT;
    return merge(d, a.findings);
  }

  /** Fund-source + behaviour assessment of a W2B order from the self-built index only. */
  async assess(order: Order): Promise<Assessment> {
    const { db, cfg } = this.o;
    const p = cfg.params;
    const st = await getState(db);
    if (!st || st.broken) return { kind: "WAIT", why: st?.broken ?? "no index" };
    if (!st.checkedAt || this.now().getTime() - st.checkedAt.getTime() > p.indexStaleMs) return { kind: "WAIT", why: "index stale" };
    if (st.headBlock !== null && st.headBlock - st.lastBlock > BigInt(p.indexMaxLagBlocks)) return { kind: "WAIT", why: "index behind head" };
    if (order.srcBlockNumber === null || st.lastBlock < order.srcBlockNumber) return { kind: "WAIT", why: "index below order block" };
    // Anchor time = block time of the order's own bridge-out (its USDT transfer to the bridge).
    const tr = await db.query<{ block_time: Date | string }>("select block_time from risk_flows where tx_hash = $1 order by log_index limit 1", [b(order.srcTxHash)]);
    if (!tr.rows[0]) return { kind: "WAIT", why: "order tx not in index" };
    const t = new Date(tr.rows[0].block_time).getTime();
    const user = order.userAddr;
    const stop = [user, ZERO_ADDRESS, cfg.bridge, ...cfg.exempt].map(b);

    const findings: Finding[] = [];
    const ratio = await this.controlledRatio(user, t, stop);
    if (ratio.total > 0n) {
      const lhs = ratio.controlled * 10_000n;
      if (lhs >= ratio.total * BigInt(p.freezeBps)) findings.push({ level: "freeze", reason: "controlled_source", detail: ratio.detail });
      else if (lhs >= ratio.total * BigInt(p.auditBps)) findings.push({ level: "audit", reason: "controlled_source", detail: ratio.detail });
    }

    if (order.amountWei >= p.freshMinAmount) {
      // first receipt = first movement at/above the per-asset minimum (0-amount / dust cannot pre-age an address)
      const r = await db.query<{ first: Date | string | null }>(
        `select min(x.block_time) as first from risk_flows x ${this.minJoin(3)}
          where x.to_addr = $1 and x.from_addr <> x.to_addr and x.block_time <= $2`,
        [b(user), new Date(t), ...this.minParams()],
      );
      const first = r.rows[0]?.first;
      if (first && t - new Date(first).getTime() <= p.freshWindowMs) findings.push({ level: "audit", reason: "fresh_funds" });
    }

    const funder = await this.commonFunder(user, t, stop);
    if (funder) {
      findings.push({ level: "audit", reason: "common_funder", detail: funder });
      await this.o.alerts
        ?.emit({ kind: "COMMON_FUNDER", key: `common_funder:${funder.funder}`, message: `one source funded ${funder.addresses.length} addresses that bridge out within 24h`, data: funder })
        .catch(() => undefined);
    }
    return { kind: "OK", findings };
  }

  /**
   * §7 tracing over USDT inflows in (t − 30d, t], two hops:
   *  hop 1: inflow whose effective source (the tx sender for pool outputs) is controlled → fully controlled;
   *  hop 2: inflow from an uncontrolled source S → controlled in proportion to S's own controlled share
   *         of its USDT inflows in the same window (hop-1 rule applied to S).
   * Exempt sources (bridge, mint, exchanges…) and the user itself are not traced through.
   */
  private async controlledRatio(user: Address, t: number, stop: Uint8Array[]) {
    const p = this.o.cfg.params;
    const start = new Date(t - p.lookbackMs);
    const end = new Date(t);
    const agg = `select x.to_addr, x.src, sum(x.value_usdt) as v,
        sum(case when c.addr is not null and (c.effective_from is null or c.effective_from <= x.block_time) then x.value_usdt else 0 end) as cv
      from risk_flows x left join controlled_set c on c.addr = x.src
      where x.asset = 'USDT' and x.from_addr <> x.to_addr and x.block_time > $2 and x.block_time <= $3`;
    const hop1 = await this.o.db.query<{ src: Uint8Array; v: string; cv: string }>(`${agg} and x.to_addr = $1 group by x.to_addr, x.src`, [b(user), start, end]);
    let total = 0n;
    let direct = 0n;
    const uncontrolled = new Map<string, bigint>();
    const stopHex = new Set(stop.map(hexOf));
    for (const r of hop1.rows) {
      const v = toBig(r.v);
      const cv = toBig(r.cv);
      total += v;
      direct += cv;
      if (v > cv && !stopHex.has(hexOf(r.src))) uncontrolled.set(hexOf(r.src), v - cv);
    }
    let attributed = 0n;
    if (uncontrolled.size > 0) {
      const srcs = [...uncontrolled.keys()].map((h) => b(`0x${h}`));
      const hop2 = await this.o.db.query<{ to_addr: Uint8Array; v: string; cv: string }>(
        `select to_addr, sum(v) as v, sum(cv) as cv from (${agg} and x.to_addr = any($1::bytea[]) group by x.to_addr, x.src) s group by to_addr`,
        [srcs, start, end],
      );
      for (const r of hop2.rows) {
        const tot = toBig(r.v);
        const ctl = toBig(r.cv);
        if (tot > 0n && ctl > 0n) attributed += (uncontrolled.get(hexOf(r.to_addr))! * ctl) / tot;
      }
    }
    const controlled = direct + attributed;
    return { total, controlled, detail: { total: total.toString(), direct: direct.toString(), hop2: attributed.toString() } };
  }

  /** SQL join keeping only movements ≥ funderMinAmount[asset]; params $at = assets[], $at+1 = mins[]. */
  private minJoin(at: number, alias = "x"): string {
    return `join unnest($${at}::text[], $${at + 1}::numeric[]) as mn_${alias}(asset, mn) on mn_${alias}.asset = ${alias}.asset and ${alias}.amount >= mn_${alias}.mn`;
  }
  private minParams(): [string[], string[]] {
    const e = Object.entries(this.o.cfg.params.funderMinAmount);
    return [e.map(([k]) => k), e.map(([, v]) => v.toString())];
  }

  /** §7: one source funded ≥ N distinct addresses within 24h that bridged out (window ±24h around t). */
  private async commonFunder(user: Address, t: number, stop: Uint8Array[]): Promise<{ funder: string; addresses: string[] } | null> {
    const p = this.o.cfg.params;
    const w0 = new Date(t - p.funderWindowMs);
    const w1 = new Date(t);
    const w2 = new Date(t + p.funderWindowMs);
    const r = await this.o.db.query<{ src: Uint8Array; addrs: string[] }>(
      `select f.src, array_agg(distinct encode(f.to_addr, 'hex')) as addrs
         from risk_flows f ${this.minJoin(7, "f")}
        where f.src in (select x.src from risk_flows x ${this.minJoin(7)}
                         where x.to_addr = $1 and x.block_time > $2 and x.block_time <= $3)
          and f.src <> all($5::bytea[]) and f.to_addr <> f.src and f.block_time > $2 and f.block_time <= $3
          and exists (select 1 from orders o join risk_flows r on r.tx_hash = o.src_tx_hash
                       where o.direction = 'W2B' and o.user_addr = f.to_addr and r.block_time > $2 and r.block_time <= $4)
        group by f.src
       having count(distinct f.to_addr) >= $6
        order by count(distinct f.to_addr) desc, f.src
        limit 1`,
      [b(user), w0, w1, w2, stop, p.funderMinAddrs, ...this.minParams()],
    );
    const x = r.rows[0];
    if (!x) return null;
    return { funder: `0x${hexOf(x.src)}`, addresses: [...x.addrs].sort().map((h) => `0x${h}`) };
  }
}

const hexOf = (u: Uint8Array): string => Buffer.from(u).toString("hex");

/** Merge the inner decision with findings into one decision (see class comment). */
export function merge(d: RiskDecision, findings: Finding[]): RiskDecision {
  const reviews: { level: ReviewLevel; reason?: string }[] = findings.map((f) => ({ level: f.level, reason: f.reason }));
  if (d.kind === "REVIEW") reviews.push({ level: d.level, reason: d.reason });
  if (reviews.length === 0) return d;
  const level = reviews.reduce<ReviewLevel>((acc, r) => (RANK[r.level] > RANK[acc] ? r.level : acc), "audit");
  const reasons = [...new Set(reviews.map((r) => r.reason).filter((x): x is string => !!x))].sort();
  return reasons.length > 0 ? { kind: "REVIEW", level, reason: reasons.join("+") } : { kind: "REVIEW", level };
}
