import { bridgeTimelockAbi } from "@bridge/abi";
import { getAbiItem, type Abi, type AbiEvent, type Address, type Hex, type Log, type PublicClient } from "viem";
import { ALERT_LEVELS, AlertManager, type AlertCode, type AlertSink } from "./alerts.js";
import type { WatcherConfig } from "./config.js";
import { PAUSER_ROLE, bridgeAbiOf, computeEventKey, decodeLog, describeCall, erc20Abi, type DecodedLog } from "./events.js";
import type { Heartbeat, RelayerProbe } from "./heartbeat.js";
import type { PauseExecutor } from "./pauser.js";
import { errText, redact } from "./redact.js";
import { stableStringify, type MultiRpc } from "./rpc.js";
import { clone, initialDerived, type StateStore } from "./state.js";
import {
  CHAINS,
  type ChainDerived,
  type ChainName,
  type CheckKind,
  type Clock,
  type Cursor,
  type PendingCheck,
  type State,
} from "./types.js";
import { SOURCE_CHAIN, Verifier } from "./verifier.js";

export interface WatcherDeps {
  config: WatcherConfig;
  rpc: Record<ChainName, MultiRpc>;
  store: StateStore;
  /** One or more independent alert channels (e.g. log + IM + phone). */
  sink: AlertSink | AlertSink[];
  pauser: PauseExecutor;
  heartbeat: Heartbeat;
  clock: Clock;
  relayerProbe?: RelayerProbe;
}

export interface TickReport {
  paused: ChainName[];
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DAY = 86_400;
const MAX_SNAPSHOTS = 16;

const KEY_CHANGE_EVENTS = new Set([
  "RoleGranted",
  "RoleRevoked",
  "RoleAdminChanged",
  "WhitelistManagerTransferStarted",
  "WhitelistManagerTransferCancelled",
  "WhitelistManagerChanged",
  "WhitelistRecoveryStarted",
  "WhitelistRecoveryCancelled",
  "AdminTransferStarted",
  "AdminTransferred",
  "AdminRecoveryStarted",
  "AdminRecoveryCancelled",
]);

const addSum = (s: Record<string, string>, k: string, v: unknown): void => {
  s[k] = (BigInt(s[k] ?? "0") + BigInt(String(v))).toString();
};
const sumOf = (s: Record<string, string>, k: string): bigint => BigInt(s[k] ?? "0");
const lc = (a: string): string => a.toLowerCase();
const errMsg = errText;

/**
 * DESIGN §9 independent watcher. One `tick()` = verify WANTOS cursor hash (rollback) → advance both
 * chains to their safe heads (BSC `finalized`, WANTOS latest−N) → run due §9.1 checks → timelock
 * reminders → periodic jobs (§9.2 reconciliation, heartbeat, gas, legacy nonces) → persist.
 * It never reads the relayer's database and never depends on `@bridge/relayer`.
 */
export class Watcher {
  state!: State;
  readonly alerts: AlertManager;
  private readonly verifier: Verifier;
  private readonly cfg: WatcherConfig;
  private newOps: string[] = [];
  private paramsDirty = true;
  private decimals: Partial<Record<ChainName, number>> = {};
  /** Safe head computed this tick, per chain. */
  private heads: Partial<Record<ChainName, bigint>> = {};

  constructor(private readonly d: WatcherDeps) {
    this.cfg = d.config;
    this.alerts = new AlertManager(d.sink, () => this.state.meta, d.clock);
    this.verifier = new Verifier(d.config, d.rpc, () => this.state.derived);
  }

  async init(): Promise<void> {
    this.state = await this.d.store.load();
    if (this.d.store.restoredFromBackup)
      await this.raise("STATE_RESTORED_FROM_BACKUP", "状态文件损坏，已从 .bak 恢复（可能少处理最后一轮，游标会补扫）");
    await this.assertWiring();
  }

  /**
   * B6 / B5: an RPC serving another chain is DROPPED with a level-1 alert; the watcher refuses to start
   * only if fewer than minRpcAgreement verified RPCs remain on a chain. Token decimals: the value agreed
   * by ≥ minRpcAgreement RPCs wins (dissenters dropped); the two chains' tokens must be equal.
   */
  private async assertWiring(): Promise<void> {
    for (const c of CHAINS) {
      const verified = await this.checkChainIds(c);
      const rpc = this.d.rpc[c];
      if (verified < rpc.minAgree) throw new Error(`watcher: only ${verified} ${c} RPC(s) verified chainId ${this.cfg.chains[c].chainId}; need ${rpc.minAgree}`);
    }
    const dec = async (c: ChainName): Promise<number> => {
      const cfg = this.cfg.chains[c];
      const rpc = this.d.rpc[c];
      const r = await rpc.all(async (cl) => Number(await cl.readContract({ address: cfg.token, abi: erc20Abi, functionName: "decimals" })));
      const counts = new Map<number, string[]>();
      for (const x of r.ok) counts.set(x.value, [...(counts.get(x.value) ?? []), x.label]);
      const best = [...counts.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      if (!best || best[1].length < rpc.minAgree) throw new Error(`watcher: ${c} token decimals not agreed by ≥${rpc.minAgree} RPCs (${JSON.stringify([...counts])})`);
      for (const [v, labels] of counts)
        if (v !== best[0])
          for (const label of labels) {
            rpc.drop(label);
            await this.raise("RPC_MISCONFIGURED", `${c} RPC ${label} 报告的代币 decimals=${v} 与多数（${best[0]}）不符，已剔除`, { chain: c, detail: { label, decimals: v, majority: best[0] }, key: `misconf:${c}:${label}:decimals` });
          }
      return best[0];
    };
    const [b, w] = [await dec("bsc"), await dec("wantos")];
    if (b !== w) throw new Error(`watcher: token decimals differ (bsc ${b}, wantos ${w}); raw-amount comparison would be wrong`);
    this.decimals = { bsc: b, wantos: w };
  }

  /** Drops RPCs that serve another chain (level-1 alert); returns how many RPCs verified the chainId. */
  private async checkChainIds(c: ChainName): Promise<number> {
    const rpc = this.d.rpc[c];
    const want = this.cfg.chains[c].chainId;
    const r = await rpc.all((cl) => cl.getChainId());
    for (const x of r.ok.filter((y) => y.value !== want)) {
      rpc.drop(x.label);
      await this.raise("RPC_MISCONFIGURED", `${c} RPC ${x.label} 服务的是 chainId ${x.value}（应为 ${want}），已剔除`, { chain: c, detail: { label: x.label, chainId: x.value, expected: want }, key: `misconf:${c}:${x.label}:chainId` });
    }
    const verified = r.ok.filter((y) => y.value === want).length;
    if (verified >= rpc.minAgree) this.alerts.resolvePrefix(`misconf:${c}:quorum:`);
    if (verified < rpc.minAgree)
      await this.raise("RPC_MISCONFIGURED", `${c} 通过 chainId 校验的 RPC 只有 ${verified} 个（需要 ${rpc.minAgree}）`, { chain: c, detail: { verified, failed: r.failed }, key: `misconf:${c}:quorum:${Math.floor(this.now() / 3600)}` });
    return verified;
  }

  private now(): number {
    return this.d.clock();
  }

  /** S-3: while handling an UNCONFIRMED log, alerts are collected here and folded into the range's level-2 RPC_DISAGREE. */
  private unconfirmedAlerts: Array<{ code: string; title: string }> | null = null;

  /** A-α: set while handling a contested log (attested by ≥ minAgree RPCs, content disputed). */
  private contested: (Record<string, unknown> & { chain: ChainName; log: string }) | null = null;

  private raise(code: AlertCode, title: string, o: { chain?: ChainName; detail?: Record<string, unknown>; key?: string } = {}): Promise<boolean> {
    if (this.contested !== null && ALERT_LEVELS[code] === 1) {
      const ctx = this.contested;
      return this.alerts.raise("EVENT_CONTESTED", {
        title: `${ctx.chain} 一级事件内容有争议（≥${this.d.rpc[ctx.chain].minAgree} 个 RPC 上报、内容不一致），未改状态，请人工核对：${title}`,
        chain: ctx.chain,
        detail: { originalCode: code, originalTitle: title, ...ctx },
        key: `contested:${ctx.chain}:${ctx.log}`,
      });
    }
    if (this.unconfirmedAlerts !== null) {
      this.unconfirmedAlerts.push({ code, title });
      return Promise.resolve(true);
    }
    return this.alerts.raise(code, { title, ...o });
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = { paused: [] };
    await this.alerts.flushOutbox(); // B2: deliver alerts that failed earlier
    await this.alerts.flushDaily(); // close the previous UTC day before collecting this tick's entries
    await this.checkClockSkew();
    const wantosOk = await this.checkWantosRollback(report);
    for (const c of CHAINS) if (c !== "wantos" || wantosOk) await this.advance(c);
    await this.evaluateChecks(report);
    await this.timelockReminders();
    await this.periodic();
    await this.reportDissent();
    await this.alerts.repeatDue();
    this.snapshot();
    await this.d.store.save(this.state);
    return report;
  }

  /** B4: grace periods use the system clock — compare it with BSC's latest block time every tick. */
  private async checkClockSkew(): Promise<void> {
    try {
      const b = await this.d.rpc.bsc.primary((cl) => cl.getBlock({ blockTag: "latest" }));
      const skew = this.now() - Number(b.timestamp);
      if (Math.abs(skew) > this.cfg.maxClockSkewSeconds)
        await this.raise("CLOCK_SKEW", `系统时钟与 BSC 最新块时间相差 ${skew}s`, { detail: { skew, block: b.number.toString() }, key: `skew:${Math.floor(this.now() / 3600)}` });
    } catch {
      /* unreachable RPCs are reported elsewhere */
    }
  }

  /** Close a state-type alert whose condition cleared: re-arm its key and stop 24h repeats (S-3). */
  private resolve(key: string): void {
    this.alerts.clearKey(key);
    this.alerts.ack(key);
  }

  /** r3 compromise: name an RPC that dissented ≥ rpcDissentThreshold times in a row (level 1); auto-close. */
  private async reportDissent(): Promise<void> {
    for (const c of CHAINS) {
      for (const e of this.d.rpc[c].endpoints) {
        const d = this.d.rpc[c].dissent.get(e.label);
        const key = `dissent:${c}:${e.label}`;
        if (d && d.count >= this.cfg.rpcDissentThreshold)
          await this.raise("RPC_DISSENTING", `${c} RPC「${e.label}」已连续 ${d.count} 次与多数不一致，请人工确认后从配置中剔除`, {
            chain: c,
            detail: { rpc: e.label, consecutive: d.count, lastDisagreement: redact(d.last) },
            key,
          });
        else if (this.state.meta.alertKeys[key] !== undefined) this.resolve(key);
      }
    }
  }

  // ------------------------------------------------------------------ §6.2 / §9.1-5 rollback guard
  private async checkWantosRollback(report: TickReport): Promise<boolean> {
    const cur = this.state.derived.wantos.cursor;
    if (!cur) return true;
    const rpc = this.d.rpc.wantos;
    const r = await rpc.consensus(async (c) => (await c.getBlock({ blockNumber: BigInt(cur.number) })).hash);
    if (!r.ok) {
      await this.raise("RPC_DISAGREE", `WANTOS 游标区块 ${cur.number} 的 hash 无法由 ≥2 个 RPC 一致确认，本轮不推进 WANTOS`, {
        chain: "wantos",
        detail: { cursor: cur, answers: r.answers },
        key: `cursorcheck:${cur.number}:${r.reason}`,
      });
      return false;
    }
    if (r.value === cur.hash) return true;
    const key = `reorg:${cur.number}:${cur.hash}`;
    await this.raise("WANTOS_REORG", `WANTOS 区块 ${cur.number} hash 变化（链回滚），自动暂停两条链`, {
      chain: "wantos",
      detail: { block: cur.number, was: cur.hash, now: r.value, agree: r.agree },
      key,
    });
    for (const c of ["bsc", "wantos"] as const) await this.autoPause(c, report, `${key}:${c}`, { reason: "WANTOS rollback", block: cur.number });
    await this.rewind();
    return true;
  }

  /** Restore the newest snapshot whose WANTOS cursor is still canonical (or start over). */
  private async rewind(): Promise<void> {
    const snaps = this.state.meta.snapshots;
    while (snaps.length > 0) {
      const s = snaps[snaps.length - 1]!;
      const wc = s.wantosCursor;
      let canonical = wc === null;
      if (wc) {
        // S-5: canonicity by consensus; anything not agreed counts as non-canonical (→ converge to full replay)
        const r = await this.d.rpc.wantos.consensus(async (c) => (await c.getBlock({ blockNumber: BigInt(wc.number) })).hash, `getBlock ${wc.number} (rewind)`);
        canonical = r.ok && r.value === wc.hash;
      }
      if (canonical) {
        this.state.derived = clone(s.derived);
        this.reopenAfter(s.takenAt ?? 0);
        await this.raise("STATE_REWOUND", `回滚后恢复到快照（WANTOS 区块 ${wc?.number ?? "起点"}）并重新摄取`, { detail: { restoredTo: wc?.number ?? null } });
        return;
      }
      snaps.pop();
    }
    this.state.derived = initialDerived();
    this.reopenAfter(0);
    await this.raise("STATE_REWOUND", "回滚后没有可验证的快照：从 startBlock 全量重放", { detail: { restoredTo: null } });
  }

  /**
   * B5: checks whose SOURCE is on WANTOS (w2b, depositRefund) and that were decided after the restore
   * point may have been satisfied by events that are now orphaned → forget those decisions so the
   * re-ingested target events are checked again. Other decisions stay (their targets are re-checked
   * only if their own blocks were orphaned, in which case they disappear anyway).
   */
  private reopenAfter(t: number): void {
    const d = this.state.meta.decided;
    for (const [id, at] of Object.entries(d))
      if ((id.startsWith("w2b:") || id.startsWith("depositRefund:")) && at >= t) {
        delete d[id];
        this.alerts.resolvePrefix(`autopause:${id}`); // r4: a re-opened check may auto-pause (and alert) again
      }
  }

  private snapshot(): void {
    const snaps = this.state.meta.snapshots;
    snaps.push({ wantosCursor: this.state.derived.wantos.cursor, derived: clone(this.state.derived), takenAt: this.now() });
    if (snaps.length > MAX_SNAPSHOTS) snaps.splice(0, snaps.length - MAX_SNAPSHOTS);
  }

  // ------------------------------------------------------------------ heads & ingestion
  /**
   * Liveness read (r3 compromise): safe head = the minAgree-th LARGEST value among the RPCs that
   * answered (BSC `finalized`, WANTOS latest − confirmations): at least minAgree RPCs vouch for it, so a
   * single lagging node cannot pin it and a single runaway node cannot pull it ahead. Fewer answers
   * than minAgree → wait and alert. A spread larger than maxLagBlocks → RPC_LAGGING (level 2).
   */
  private async safeHead(c: ChainName): Promise<bigint | null> {
    const cfg = this.cfg.chains[c];
    const rpc = this.d.rpc[c];
    const kth = (xs: bigint[]): bigint => [...xs].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))[rpc.minAgree - 1]!;
    const lagging = async (r: { ok: Array<{ label: string; value: bigint }> }) => {
      const vals = r.ok.map((x) => x.value);
      const spread = vals.reduce((a, b) => (b > a ? b : a)) - vals.reduce((a, b) => (b < a ? b : a));
      if (spread > BigInt(cfg.maxLagBlocks))
        await this.raise("RPC_LAGGING", `${c} 各 RPC 的区块高度相差 ${spread} 块`, { chain: c, detail: { heads: Object.fromEntries(r.ok.map((x) => [x.label, x.value.toString()])) }, key: `rpclag:${c}` });
      else this.alerts.clearKey(`rpclag:${c}`);
    };
    if (cfg.head.kind === "finalized") {
      const r = await rpc.all(async (cl) => (await cl.getBlock({ blockTag: "finalized" })).number);
      if (r.ok.length < rpc.minAgree) {
        await this.raise("BSC_NO_FINALIZED", `${c} 取不到 finalized 区块（仅 ${r.ok.length} 个 RPC 返回），等待`, { chain: c, detail: { failed: r.failed }, key: `nofinal:${c}` });
        return null;
      }
      this.alerts.clearKey(`nofinal:${c}`);
      await lagging(r);
      return kth(r.ok.map((x) => x.value));
    }
    const r = await rpc.all((cl) => cl.getBlockNumber({ cacheTime: 0 }));
    if (r.ok.length < rpc.minAgree) {
      await this.raise("RPC_UNREACHABLE", `${c} 可用 RPC 不足（${r.ok.length}/${rpc.endpoints.length}）`, { chain: c, detail: { failed: r.failed }, key: `unreach:${c}` });
      return null;
    }
    this.alerts.clearKey(`unreach:${c}`);
    await lagging(r);
    const latest = kth(r.ok.map((x) => x.value));
    const m = this.state.meta;
    const now = this.now();
    if (!m.wantosHead || BigInt(m.wantosHead.number) !== latest) {
      if (m.wantosHead) this.alerts.clearKey(`stall:${m.wantosHead.number}`);
      m.wantosHead = { number: latest.toString(), seenAt: now };
    } else if (now - m.wantosHead.seenAt > this.cfg.wantosStallSeconds) {
      await this.raise("WANTOS_STALLED", `WANTOS 出块停滞：${now - m.wantosHead.seenAt}s 无新块`, { chain: c, detail: { head: m.wantosHead.number }, key: `stall:${m.wantosHead.number}` });
    }
    const safe = latest - BigInt(cfg.head.confirmations);
    return safe < 0n ? null : safe;
  }

  private async advance(c: ChainName): Promise<void> {
    const cfg = this.cfg.chains[c];
    const head = await this.safeHead(c);
    if (head === null) {
      await this.checkStuck(c, null);
      return;
    }
    this.heads[c] = head;
    const der = this.state.derived[c];
    let from = der.cursor ? BigInt(der.cursor.number) + 1n : cfg.startBlock;
    for (let i = 0; i < this.cfg.maxRangesPerTick && from <= head; i++) {
      const to = from + BigInt(cfg.maxBlockRange) - 1n < head ? from + BigInt(cfg.maxBlockRange) - 1n : head;
      try {
        await this.ingestRange(c, from, to);
      } catch (e) {
        await this.raise("RPC_UNREACHABLE", `${c} 拉取区块 ${from}-${to} 失败，下轮按游标重试`, { chain: c, detail: { error: errMsg(e) }, key: `ingest:${c}:${from}` });
        break;
      }
      from = to + 1n;
    }
    const curC = this.state.derived[c].cursor;
    const cur = curC ? BigInt(curC.number) : cfg.startBlock - 1n;
    if (head - cur > BigInt(cfg.maxLagBlocks)) {
      await this.raise("INDEX_LAG", `${c} 监控落后 ${head - cur} 块`, { chain: c, detail: { head: head.toString(), cursor: cur.toString() }, key: `lag:${c}` });
    } else this.alerts.clearKey(`lag:${c}`);
    await this.checkStuck(c, head);
  }

  /**
   * B1 / A-2 (r3): level-1 CURSOR_STUCK when (a) the cursor has neither moved nor been caught up for
   * longer than cursorStallSeconds, or (b) the safe head itself has not advanced for that long (a frozen
   * head would otherwise look "caught up" forever).
   */
  private async checkStuck(c: ChainName, head: bigint | null): Promise<void> {
    const m = this.state.meta;
    const now = this.now();
    const stall = this.cfg.cursorStallSeconds;
    const cur = this.state.derived[c].cursor?.number ?? null;
    const caughtUp = head !== null && cur !== null && BigInt(cur) >= head;
    const prev = m.cursorProgress[c];
    if (!prev || prev.number !== cur || caughtUp) m.cursorProgress[c] = { number: cur, at: now };
    const hp = m.headProgress[c];
    if (head !== null && (!hp || hp.head !== head.toString())) m.headProgress[c] = { head: head.toString(), at: now };
    const cp = m.cursorProgress[c]!;
    const hp2 = m.headProgress[c];
    const cursorStalled = now - cp.at > stall;
    const headStalled = head !== null && hp2 !== undefined && now - hp2.at > stall;
    if (!cursorStalled && !headStalled) {
      this.alerts.resolvePrefix(`stuck:${c}:`); // S-3: progress → close
      return;
    }
    const since = Math.min(cursorStalled ? cp.at : now, headStalled ? hp2!.at : now);
    await this.raise("CURSOR_STUCK", `${c} 监控已 ${Math.round((now - since) / 60)} 分钟无进展（${headStalled ? "安全高度不再前进" : "游标不前进"}），监控处于失明状态`, {
      chain: c,
      detail: { cursor: cur, head: head?.toString() ?? null, cursorSince: cp.at, headSince: hp2?.at ?? null },
      key: `stuck:${c}:${since}`,
    });
  }

  private legacyOn(c: ChainName): Address[] {
    return this.cfg.legacyAddresses.filter((l) => l.chain === c).map((l) => l.address);
  }

  private async fetchLogs(cl: PublicClient, c: ChainName, fromBlock: bigint, toBlock: bigint): Promise<Array<{ source: DecodedLog["source"]; log: Log }>> {
    const cfg = this.cfg.chains[c];
    const out: Array<{ source: DecodedLog["source"]; log: Log }> = [];
    for (const log of await cl.getLogs({ address: [cfg.bridge, cfg.timelock], fromBlock, toBlock })) {
      out.push({ source: lc(log.address) === lc(cfg.bridge) ? "bridge" : "timelock", log });
    }
    const transfer = getAbiItem({ abi: erc20Abi, name: "Transfer" }) as AbiEvent;
    const watched = this.legacyOn(c);
    const fromSet = [...(c === "wantos" ? [ZERO as Address] : []), ...watched];
    const seen = new Set<string>();
    const pushToken = (logs: Log[]) => {
      for (const log of logs) {
        const k = `${log.transactionHash}:${log.logIndex}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ source: "token", log });
      }
    };
    if (fromSet.length > 0) pushToken(await cl.getLogs({ address: cfg.token, event: transfer, args: { from: fromSet } as never, fromBlock, toBlock }));
    if (watched.length > 0) pushToken(await cl.getLogs({ address: cfg.token, event: transfer, args: { to: watched } as never, fromBlock, toBlock }));
    const legacy = this.legacyOn(c);
    if (legacy.length > 0) for (const log of await cl.getLogs({ address: legacy, fromBlock, toBlock })) out.push({ source: "legacy", log });
    out.sort((a, b) => (a.log.blockNumber! === b.log.blockNumber! ? a.log.logIndex! - b.log.logIndex! : a.log.blockNumber! < b.log.blockNumber! ? -1 : 1));
    return out;
  }

  /**
   * DESIGN §9 "至少两个 RPC 订阅": every range is fetched from EVERY RPC and the union is processed
   * (dedup by txHash:logIndex). A log missing from some RPC is reported; a fabricated log is filtered
   * later by the Verifier's existence consensus. ≥ minRpcAgreement RPCs must answer and agree on the
   * range-end block hash, otherwise the cursor does not move.
   */
  private async ingestRange(c: ChainName, from: bigint, to: bigint): Promise<void> {
    const rpc = this.d.rpc[c];
    const res = await rpc.all((cl) => this.fetchLogs(cl, c, from, to));
    if (res.ok.length < rpc.minAgree) throw new Error(`only ${res.ok.length} RPC(s) answered getLogs ${from}-${to}: ${res.failed.map((f) => `${f.label}: ${f.error}`).join("; ")}`);
    type Entry = { source: DecodedLog["source"]; log: Log };
    // A-1 (r3): count DISTINCT RPCs per variant; a duplicate entry inside one RPC's answer is ignored
    // for counting and reported.
    const union = new Map<string, { variants: Map<string, { entry: Entry; labels: Set<string> }>; labels: Set<string> }>();
    const dupes: Array<Record<string, unknown>> = [];
    for (const { label, value } of res.ok) {
      const seen = new Set<string>();
      for (const entry of value) {
        const k = `${entry.log.transactionHash}:${entry.log.logIndex}`;
        if (seen.has(k)) {
          dupes.push({ log: k, duplicatedBy: label });
          continue;
        }
        seen.add(k);
        const sig = stableStringify({ a: lc(entry.log.address), t: entry.log.topics, d: entry.log.data, h: entry.log.blockHash, b: String(entry.log.blockNumber), s: entry.source });
        const u = union.get(k) ?? { variants: new Map(), labels: new Set<string>() };
        const v = u.variants.get(sig) ?? { entry, labels: new Set<string>() };
        v.labels.add(label);
        u.variants.set(sig, v);
        u.labels.add(label);
        union.set(k, u);
      }
    }
    // Block hash + timestamp of the range end and of every block that carries a log, by consensus (concurrently).
    const blockNums = new Set<bigint>([to]);
    for (const u of union.values()) for (const v of u.variants.values()) blockNums.add(v.entry.log.blockNumber!);
    const blocks = new Map<bigint, { hash: Hex; timestamp: number }>();
    await Promise.all(
      [...blockNums].map(async (n) => {
        const b = await rpc.consensus(async (cl) => {
          const x = await cl.getBlock({ blockNumber: n });
          return { hash: x.hash, timestamp: Number(x.timestamp) };
        }, `getBlock ${n}`);
        if (!b.ok) throw new Error(`block ${n} not confirmed by ≥${rpc.minAgree} RPCs (${b.reason})`);
        blocks.set(n, b.value);
      }),
    );
    const end = blocks.get(to)!;
    // A log is confirmed iff exactly one variant exists at its position and ≥ minAgree RPCs reported it
    // (a 1-vs-1 tie is NOT confirmed). Logs whose block hash is not the agreed one (stale fork) are dropped.
    const logs: Array<Entry & { confirmed: boolean; attested: boolean; contest: Record<string, unknown> & { log: string } }> = [];
    const suspicious: Array<Record<string, unknown>> = [...dupes];
    const unconfirmed: Array<Record<string, unknown>> = [];
    for (const [k, u] of union) {
      // B-1: drop variants on a non-agreed block hash (stale fork) FIRST, then count confirmations
      const variants = [...u.variants.values()].filter((v) => {
        if (v.entry.log.blockHash === blocks.get(v.entry.log.blockNumber!)!.hash) return true;
        suspicious.push({ log: k, staleBlockHash: v.entry.log.blockHash, reportedBy: [...v.labels] });
        return false;
      });
      if (variants.length === 0) continue;
      const confirmed = variants.length === 1 && variants[0]!.labels.size >= rpc.minAgree;
      // A-α (r4): reported by ≥ minAgree RPCs in total (a single liar cannot fabricate that) but with
      // differing content → "contested": still no state change, but its level-1 meaning is NOT folded away.
      const attested = new Set(variants.flatMap((v) => [...v.labels])).size >= rpc.minAgree;
      const contest = { log: k, variants: variants.map((v) => ({ reportedBy: [...v.labels], topics: v.entry.log.topics, data: v.entry.log.data })) };
      if (!confirmed || u.labels.size < res.ok.length) suspicious.push({ log: k, reportedBy: [...u.labels], variants: variants.length });
      for (const v of variants) {
        if (!confirmed)
          unconfirmed.push({ log: k, block: String(v.entry.log.blockNumber), address: v.entry.log.address, topic0: v.entry.log.topics[0], data: v.entry.log.data, reportedBy: [...v.labels] });
        logs.push({ ...v.entry, confirmed, attested, contest });
      }
    }
    // r3: per-RPC dissent on logs — missing a confirmed log or reporting an unconfirmed/stale variant
    const confirmedKeys = new Set(logs.filter((l) => l.confirmed).map((l) => `${l.log.transactionHash}:${l.log.logIndex}`));
    for (const { label, value } of res.ok) {
      const mine = new Set(value.map((e) => `${e.log.transactionHash}:${e.log.logIndex}`));
      const missed = [...confirmedKeys].some((k) => !mine.has(k));
      const odd = [...union.entries()].some(([k, u]) => u.labels.has(label) && !confirmedKeys.has(k)) || dupes.some((d) => d["duplicatedBy"] === label);
      if (missed || odd) rpc.noteDissent(label, `getLogs ${from}-${to}`);
      else if (value.length > 0) rpc.noteAgree(label); // r4: an empty answer agreeing on "nothing" is neutral
    }
    logs.sort((a, b) => (a.log.blockNumber! === b.log.blockNumber! ? a.log.logIndex! - b.log.logIndex! : a.log.blockNumber! < b.log.blockNumber! ? -1 : 1));
    // B2: apply the whole range atomically — on any error restore the pre-range state, so a retry
    // from the unchanged cursor cannot double-count sums.
    const before = clone(this.state.derived);
    const newOpsBefore = this.newOps.length;
    try {
      const abiFor = (s: DecodedLog["source"]): Abi => (s === "bridge" ? bridgeAbiOf(c) : s === "timelock" ? (bridgeTimelockAbi as Abi) : (erc20Abi as Abi));
      const folded: Array<{ code: string; title: string }> = [];
      for (const { source, log, confirmed, attested, contest } of logs) {
        this.unconfirmedAlerts = confirmed || attested ? null : folded;
        this.contested = !confirmed && attested ? { chain: c, ...contest } : null;
        const meta = { address: log.address, block: log.blockNumber!, blockHash: log.blockHash!, txHash: log.transactionHash!, logIndex: log.logIndex!, timestamp: blocks.get(log.blockNumber!)!.timestamp, confirmed, attested };
        if (source === "legacy") {
          await this.onLegacyLog(c, { source, name: "log", args: { topic0: log.topics[0] }, ...meta });
          continue;
        }
        const dec = decodeLog(abiFor(source), log);
        if (!dec) continue;
        const l: DecodedLog = { source, ...dec, ...meta };
        if (source === "bridge") await this.onBridge(c, l);
        else if (source === "timelock") await this.onTimelock(c, l);
        else await this.onTransfer(c, l);
      }
      this.unconfirmedAlerts = null;
      this.contested = null;
      if (suspicious.length > 0)
        await this.raise("RPC_DISAGREE", `${c} 区块 ${from}-${to}：各 RPC 返回的事件不一致（${suspicious.length} 处）；未确认的事件只建核对项、其告警并入本条（二级），不改状态`, {
          chain: c,
          // R12: the unconfirmed logs (not counted in sums) are listed for manual reconciliation
          detail: { range: `${from}-${to}`, answered: res.ok.map((x) => x.label), items: suspicious.slice(0, 50), unconfirmed: unconfirmed.slice(0, 50), foldedAlerts: folded.slice(0, 50) },
          key: `logdiff:${c}:${from}-${to}`,
        });
    } catch (e) {
      this.unconfirmedAlerts = null;
      this.contested = null;
      this.state.derived = before;
      this.newOps.splice(newOpsBefore);
      throw e;
    }
    const cursor: Cursor = { number: to.toString(), hash: end.hash, timestamp: end.timestamp };
    this.state.derived[c].cursor = cursor;
    for (const id of this.newOps.splice(0)) {
      const op = this.state.derived.timelockOps[id];
      if (!op) continue;
      await this.raise("TIMELOCK_PROPOSED", `新的时间锁提议（${op.chain}）：${op.calls.map((x) => x.fn).join(", ")}，可执行时间 ${new Date(op.readyAt * 1000).toISOString()}`, {
        chain: op.chain,
        detail: { id: op.id, readyAt: op.readyAt, calls: op.calls },
        key: `tl:${id}`,
      });
    }
  }

  // ------------------------------------------------------------------ event handlers
  private evKey(c: ChainName, l: DecodedLog): string {
    return `ev:${c}:${l.txHash}:${l.logIndex}`;
  }

  private evDetail(l: DecodedLog): Record<string, unknown> {
    return { event: l.name, args: l.args, block: l.block.toString(), txHash: l.txHash, logIndex: l.logIndex };
  }

  private async onBridge(c: ChainName, l: DecodedLog): Promise<void> {
    const der: ChainDerived = this.state.derived[c];
    // A-1: only confirmed logs may change state
    const add = (sums: Record<string, string>, k: string, v: unknown): void => {
      if (l.confirmed) addSum(sums, k, v);
    };
    const a = l.args;
    const key = this.evKey(c, l);
    const g = this.cfg.grace;
    switch (l.name) {
      case "BridgeOut":
        add(der.sums, "bridgeOut", a["amount"]);
        return;
      case "Deposited":
        add(der.sums, "deposited", a["amount"]);
        if (l.confirmed) this.state.derived.depositBlocks[String(a["nonce"])] ??= l.block.toString(); // first confirmed write wins
        return;
      case "Funded":
        add(der.sums, "funded", a["amount"]);
        return;
      case "Withdrawn":
        add(der.sums, "withdrawn", a["amount"]);
        await this.raise("WITHDRAWN", `${c} 储备提取已执行（时间锁）`, { chain: c, detail: this.evDetail(l), key });
        return;
      case "Released":
        add(der.sums, "released", a["amount"]);
        // A-2: a Released is already paid → "executable" at its own time, so an undecidable check escalates at grace end
        if (c === "bsc") this.addCheck("w2b", c, l, a["srcEventNonce"], a["to"], a["amount"], a["eventKey"], l.timestamp + g.w2bSeconds, l.timestamp);
        return;
      case "ReleaseQueued": {
        const eta = Number(a["executableAt"]);
        if (c === "bsc") this.addCheck("w2b", c, l, a["srcEventNonce"], a["to"], a["amount"], a["eventKey"], l.timestamp + g.w2bSeconds, eta);
        else this.addCheck("b2w", c, l, a["srcEventNonce"], a["to"], a["amount"], a["eventKey"], eta - g.b2wBeforeEtaSeconds, eta);
        this.alerts.daily({ kind: "RELEASE_QUEUED", chain: c, id: key, data: { nonce: String(a["srcEventNonce"]), to: a["to"], amount: String(a["amount"]), executableAt: eta } });
        return;
      }
      case "RefundRequested":
        this.addCheck("refund", c, l, a["orderId"], a["user"], a["amount"], a["eventKey"], Number(a["executableAt"]) - g.refundBeforeExecSeconds, Number(a["executableAt"]));
        this.alerts.daily({ kind: "REFUND_REQUESTED", chain: c, id: key, data: { orderId: String(a["orderId"]), amount: String(a["amount"]) } });
        return;
      case "DepositRefundRequested":
        this.addCheck("depositRefund", c, l, a["nonce"], a["from"], a["amount"], a["eventKey"], Number(a["executableAt"]) - g.depositRefundBeforeExecSeconds, Number(a["executableAt"]));
        this.alerts.daily({ kind: "DEPOSIT_REFUND_REQUESTED", chain: c, id: key, data: { nonce: String(a["nonce"]), amount: String(a["amount"]) } });
        return;
      // RefundCancelled / DepositRefundCancelled no longer drop checks (A-1): the Verifier's consensus
      // read of the order / deposit status decides whether the refund was withdrawn.
      case "Refunded":
        add(der.sums, "refunded", a["amount"]);
        return;
      case "DepositRefunded":
        add(der.sums, "depositRefunded", a["amount"]);
        return;
      case "LegacyPaid":
        add(der.sums, "legacyPaid", a["amount"]);
        this.alerts.daily({ kind: "LEGACY_PAID", chain: c, id: key, data: { oldKey: a["oldKey"], to: a["to"], amount: String(a["amount"]) } });
        return;
      case "SourceVoided":
        this.alerts.daily({ kind: "SOURCE_VOIDED", chain: c, id: key, data: { nonce: String(a["srcEventNonce"]), by: a["by"] } });
        await this.checkFutureVoid(c, l);
        return;
      case "Paused":
        await this.raise("PAUSED", `${c} 桥已暂停（by ${String(a["account"])}）`, { chain: c, detail: this.evDetail(l), key });
        return;
      case "Unpaused":
        if (l.confirmed) this.noteUnpause(der, l.block, l.timestamp);
        await this.raise("UNPAUSED", `${c} 桥已解除暂停（by ${String(a["account"])}）；此前事件视为已确认`, { chain: c, detail: this.evDetail(l), key });
        return;
      case "Upgraded":
        await this.raise("UPGRADE_EXECUTED", `${c} 桥合约升级已执行 → ${String(a["implementation"])}`, { chain: c, detail: this.evDetail(l), key });
        return;
      case "ParamsUpdated":
        this.paramsDirty = true;
        await this.raise("PARAMS_UPDATED", `${c} 参数已更新`, { chain: c, detail: this.evDetail(l), key });
        return;
      case "SupplyCeilingUpdated":
        await this.raise("SUPPLY_CEILING_UPDATED", `${c} supplyCeiling ${String(a["previous"])} → ${String(a["current"])}`, { chain: c, detail: this.evDetail(l), key });
        return;
      case "WhitelistFrozen":
      case "WhitelistUnfrozen":
        await this.raise("WHITELIST_FROZEN", `${c} 白名单写入${l.name === "WhitelistFrozen" ? "已冻结" : "已解冻"}`, { chain: c, detail: this.evDetail(l), key });
        return;
      case "WhitelistBatchApplied":
        this.alerts.daily({ kind: "WHITELIST_BATCH", chain: c, id: key, data: { listHash: a["listHash"], allowed: a["allowed"], nonce: String(a["nonce"]), count: String(a["count"]), txHash: l.txHash } });
        return;
      case "WhitelistEmergencyRemoval":
        this.alerts.daily({ kind: "EMERGENCY_REMOVAL", chain: c, id: key, data: { by: a["by"], listHash: a["listHash"], count: String(a["count"]), txHash: l.txHash } });
        return;
      default:
        if (KEY_CHANGE_EVENTS.has(l.name)) await this.onKeyChange(c, l);
    }
  }

  private async onKeyChange(c: ChainName, l: DecodedLog): Promise<void> {
    const key = this.evKey(c, l);
    if (l.name === "RoleRevoked" && lc(String(l.args["role"])) === PAUSER_ROLE) {
      await this.raise("PAUSER_REVOKED", `${c} 暂停钥匙已吊销：${String(l.args["account"])}`, { chain: c, detail: this.evDetail(l), key });
      return;
    }
    await this.raise("KEY_CHANGE", `${c} 角色 / 交接 / 恢复变化：${l.name}`, { chain: c, detail: this.evDetail(l), key });
  }

  private async onTimelock(c: ChainName, l: DecodedLog): Promise<void> {
    const a = l.args;
    const id = `${c}:${String(a["id"])}`;
    const ops = this.state.derived.timelockOps;
    switch (l.name) {
      case "CallScheduled": {
        // S-4: an unconfirmed proposal creates no op (it would linger forever). If it is CONTESTED
        // (attested by ≥ minAgree RPCs, content disputed) it is still pushed at level 1 (A-α);
        // if only < minAgree RPCs report it, it is just listed in the range's RPC_DISAGREE.
        if (!l.confirmed) {
          if (l.attested) await this.raise("TIMELOCK_PROPOSED", `${c} 时间锁提议（内容有争议）`, { chain: c, detail: this.evDetail(l) });
          return;
        }
        const cfg = this.cfg.chains[c];
        const op = (ops[id] ??= { chain: c, id: a["id"] as Hex, readyAt: l.timestamp + Number(a["delay"]), calls: [], remindersSent: [] });
        const call = describeCall(a["target"] as Address, a["data"] as Hex, cfg.bridge, cfg.timelock, c);
        op.calls.push({ target: a["target"] as Address, ...call });
        if (!this.newOps.includes(id)) this.newOps.push(id);
        return;
      }
      case "CallExecuted":
        if (l.confirmed) delete ops[id];
        return;
      case "Cancelled":
        if (l.confirmed) delete ops[id];
        await this.raise("TIMELOCK_CANCELLED", `${c} 时间锁提议已取消 ${String(a["id"])}`, { chain: c, detail: this.evDetail(l), key: this.evKey(c, l) });
        return;
      case "MinDelayChange":
        await this.raise("PARAMS_UPDATED", `${c} 时间锁延迟变更`, { chain: c, detail: this.evDetail(l), key: this.evKey(c, l) });
        return;
      default:
        if (KEY_CHANGE_EVENTS.has(l.name)) await this.onKeyChange(c, l);
    }
  }

  private async onTransfer(c: ChainName, l: DecodedLog): Promise<void> {
    const from = lc(String(l.args["from"]));
    const to = lc(String(l.args["to"]));
    const value = BigInt(String(l.args["value"]));
    const key = this.evKey(c, l);
    if (c === "wantos" && from === ZERO) {
      // §9.1-6 / decision 14: gross mint, persisted, never reset, never pauses.
      // A-1: an unconfirmed mint is alerted but never added to the persisted gross total
      const total = BigInt(this.state.derived.mintTotal) + (l.confirmed ? value : 0n);
      if (l.confirmed) this.state.derived.mintTotal = total.toString();
      const detail = { to: l.args["to"], value: value.toString(), grossTotal: total.toString(), threshold: this.cfg.mintAlertThreshold.toString(), txHash: l.txHash, confirmed: l.confirmed };
      if (total > this.cfg.mintAlertThreshold) await this.raise("MINT_EXCESS", `WANTOS-USDT 增发过量：累计 ${total} > 阈值（只告警，不暂停）`, { chain: c, detail, key });
      else await this.raise("MINT", `WANTOS-USDT 增发 ${value}（累计 ${total}，只告警）`, { chain: c, detail, key });
    }
    const legacy = new Set(this.legacyOn(c).map(lc));
    if (legacy.has(from) || legacy.has(to)) {
      await this.raise("LEGACY_ACTIVITY", `${c} 旧桥地址有资金动作`, { chain: c, detail: this.evDetail(l), key: `${key}:legacy` });
    }
  }

  private async onLegacyLog(c: ChainName, l: DecodedLog): Promise<void> {
    await this.raise("LEGACY_ACTIVITY", `${c} 旧桥合约 ${l.address} 发出事件`, { chain: c, detail: this.evDetail(l), key: this.evKey(c, l) });
  }

  /** PR1-NOTES §5.11a-2: voiding a not-yet-existing source nonce may mean a stolen WL wallet. */
  private async checkFutureVoid(c: ChainName, l: DecodedLog): Promise<void> {
    const nonce = BigInt(String(l.args["srcEventNonce"]));
    const peer = c === "bsc" ? "wantos" : "bsc";
    const pcfg = this.cfg.chains[peer];
    try {
      const last = (await this.d.rpc[peer].primary((cl) =>
        cl.readContract({ address: pcfg.bridge, abi: bridgeAbiOf(peer), functionName: peer === "wantos" ? "orderNonce" : "depositNonce" }),
      )) as bigint;
      if (nonce > last)
        await this.raise("VOID_FUTURE_SOURCE", `${c} 作废了尚不存在的来源编号 ${nonce}（${peer} 当前最大 ${last}），白名单钱包可能被盗`, {
          chain: c,
          detail: this.evDetail(l),
          key: this.evKey(c, l),
        });
    } catch (e) {
      await this.raise("RPC_UNREACHABLE", `${peer} 读取来源编号失败`, { chain: peer, detail: { error: errMsg(e) }, key: `futurevoid:${this.evKey(c, l)}` });
    }
  }

  // ------------------------------------------------------------------ §9.1 checks
  private addCheck(kind: CheckKind, c: ChainName, l: DecodedLog, nonce: unknown, to: unknown, amount: unknown, eventKey: unknown, decideAt: number, executableAt?: number): void {
    const id = `${kind}:${c}:${l.txHash}:${l.logIndex}`;
    if (this.state.meta.decided[id] !== undefined || this.state.derived.pending.some((p) => p.id === id)) return;
    this.state.derived.pending.push({
      id,
      kind,
      targetChain: c,
      eventName: l.name,
      block: l.block.toString(),
      timestamp: l.timestamp,
      txHash: l.txHash,
      logIndex: l.logIndex,
      nonce: String(nonce),
      to: to as Address,
      amount: String(amount),
      eventKey: eventKey as Hex,
      decideAt,
      ...(executableAt !== undefined ? { executableAt } : {}),
    });
  }

  private decide(p: PendingCheck): void {
    this.resolve(`overdue:${p.id}`); // S-3: CHECK_OVERDUE closes with the check
    this.state.meta.decided[p.id] = this.now();
    this.state.derived.pending = this.state.derived.pending.filter((x) => x.id !== p.id);
  }

  private async evaluateChecks(report: TickReport): Promise<void> {
    for (const p of [...this.state.derived.pending]) {
      if (this.now() < p.decideAt) continue; // ③ grace period
      const src = SOURCE_CHAIN[p.kind];
      const srcCursor = this.state.derived[src].cursor;
      if (!srcCursor || srcCursor.timestamp < p.timestamp) {
        // ① the watcher's own view of the source chain has not passed the target event yet
        await this.raise("CHECK_DEFERRED", `${p.kind} 核对暂缓：监控的 ${src} 进度未越过目标交易`, {
          chain: p.targetChain,
          detail: { check: p, sourceCursor: srcCursor },
          key: `deferred:${p.id}`,
        });
        p.blindAt ??= this.now();
        await this.overdue(p, "监控源链进度未越过目标交易");
        continue;
      }
      const v = await this.verifier.verdict(p); // ② ≥2 RPCs agree, inside
      if (v.kind === "match" || v.kind === "cancelled") {
        this.decide(p);
        continue;
      }
      if (v.kind === "undecided") {
        await this.raise("RPC_DISAGREE", `${p.kind} 核对无法由 ≥2 个 RPC 一致确认，不暂停`, { chain: p.targetChain, detail: { check: p, verdict: v }, key: `disagree:${p.id}` });
        p.blindAt ??= this.now();
        await this.overdue(p, "RPC 结果不一致");
        continue;
      }
      if (v.kind === "no-target") {
        await this.raise("RPC_DISAGREE", `${p.kind} 目标事件经 ≥2 个 RPC 确认不存在（主 RPC 数据有误或已回滚），丢弃`, { chain: p.targetChain, detail: { check: p }, key: `notarget:${p.id}` });
        this.decide(p);
        continue;
      }
      await this.onMismatch(p, v.reason, v.observed, report);
    }
  }

  /** B4: a check still undecidable when its target becomes executable → level 1 (never pauses by itself). */
  private async overdue(p: PendingCheck, why: string): Promise<void> {
    if (p.executableAt === undefined || this.now() < p.executableAt) return;
    await this.raise("CHECK_OVERDUE", `${p.kind} 核对在目标可执行时间仍无法判定（${why}），请人工核查`, { chain: p.targetChain, detail: { check: p }, key: `overdue:${p.id}` });
  }

  private async onMismatch(p: PendingCheck, reason: string, observed: unknown, report: TickReport): Promise<void> {
    const c = p.targetChain;
    await this.refreshUnpauseMarker(c);
    const lu = this.state.derived[c].lastUnpaused;
    const detail = { reason, observed, check: p };
    // GATE2 A3: acknowledged only if the owner unpaused AFTER this event's grace period ended
    // (i.e. when the watcher could already have flagged it) and the event is not newer than the unpause.
    if (p.blindAt === undefined && lu !== null && BigInt(p.block) <= BigInt(lu.block) && lu.timestamp >= p.decideAt) {
      await this.raise("MISMATCH_ACKNOWLEDGED", `${p.kind} 不符，但负责人已在其宽限期结束后解除暂停（区块 ${lu.block}），视为已确认，只告警不暂停`, { chain: c, detail, key: `ack:${p.id}` });
      this.decide(p);
      return;
    }
    const advice =
      p.kind === "b2w" ? "处置：先吊销被怀疑的付款钥匙 → 取消可疑排队项（cancelRelease / voidSource）→ 再解除暂停" : "处置：先吊销被怀疑的付款钥匙 → 取消可疑排队项 → 再解除暂停";
    const ok = await this.autoPause(c, report, `autopause:${p.id}`, { ...detail, advice }, (p.firstPauseFailAt ??= this.now()));
    if (ok) this.decide(p);
    else p.pauseFailures = (p.pauseFailures ?? 0) + 1;
  }

  private noteUnpause(der: ChainDerived, block: bigint, timestamp: number): void {
    if (der.lastUnpaused === null || block > BigInt(der.lastUnpaused.block)) der.lastUnpaused = { block: block.toString(), timestamp };
  }

  /**
   * Look ahead from the cursor to this tick's SAFE head (BSC finalized / WANTOS confirmed) for an
   * `Unpaused` not yet ingested (e.g. maxRangesPerTick cut the catch-up short). Consensus reads only.
   */
  private async refreshUnpauseMarker(c: ChainName): Promise<void> {
    const cfg = this.cfg.chains[c];
    const der = this.state.derived[c];
    const head = this.heads[c];
    const fromBlock = der.cursor ? BigInt(der.cursor.number) + 1n : cfg.startBlock;
    if (head === undefined || fromBlock > head) return;
    const ev = getAbiItem({ abi: bridgeAbiOf(c), name: "Unpaused" }) as AbiEvent;
    const r = await this.d.rpc[c].all(async (cl) => {
      const logs = await cl.getLogs({ address: cfg.bridge, event: ev, fromBlock, toBlock: head });
      const last = logs[logs.length - 1];
      if (!last) return null;
      return { block: last.blockNumber!, timestamp: Number((await cl.getBlock({ blockNumber: last.blockNumber! })).timestamp) };
    });
    // S-2: "an Unpaused exists" is accepted when ≥ minAgree RPCs report the SAME one; an RPC that sees
    // nothing is not a dissent (confirming an unpause can only prevent a pause, and blindAt still applies).
    const groups = new Map<string, { v: { block: bigint; timestamp: number }; labels: string[] }>();
    for (const x of r.ok) {
      if (x.value === null) continue;
      const k = stableStringify(x.value);
      const g = groups.get(k) ?? { v: x.value, labels: [] };
      g.labels.push(x.label);
      groups.set(k, g);
    }
    const best = [...groups.values()].filter((g) => g.labels.length >= this.d.rpc[c].minAgree).sort((a, b) => (a.v.block > b.v.block ? -1 : 1))[0];
    if (best) this.noteUnpause(der, best.v.block, best.v.timestamp);
    else if (groups.size > 0)
      await this.raise("RPC_DISAGREE", `${c} 向前补查 Unpaused：各 RPC 结果不一致，未采用`, {
        chain: c,
        detail: { range: `${fromBlock}-${head}`, answers: [...groups.values()].map((g) => ({ block: g.v.block.toString(), reportedBy: g.labels })), failed: r.failed },
        key: `unpause-lookahead:${c}:${fromBlock}-${head}`,
      });
  }

  private async autoPause(c: ChainName, report: TickReport, key: string, detail: Record<string, unknown>, failSince = 0): Promise<boolean> {
    const out = await this.d.pauser.pause(c);
    if (out.ok) {
      if (!report.paused.includes(c)) report.paused.push(c);
      await this.raise("AUTO_PAUSE", `监控已自动暂停 ${c}${out.status === "already-paused" ? "（链上已处于暂停）" : ""}：${String(detail["reason"] ?? "")}`, {
        chain: c,
        detail: { ...detail, outcome: out },
        key,
      });
      return true;
    }
    await this.raise("PAUSE_FAILED", out.ownTxMined ? `自动暂停 ${c}：自己的暂停交易已上链成功（${out.txHash}），等待第二个 RPC 确认；请核对链上 paused()` : `自动暂停 ${c} 失败（已重试 ${out.attempts} 次），请手动暂停`, { chain: c, detail: { ...detail, outcome: out }, key: `${key}:failed:${Math.floor((this.now() - failSince) / 3600)}` }); // B1: at most one per hour
    return false;
  }

  // ------------------------------------------------------------------ timelock reminders (24h / 6h)
  private async timelockReminders(): Promise<void> {
    const now = this.now();
    for (const [id, op] of Object.entries(this.state.derived.timelockOps)) {
      for (const r of this.cfg.timelockRemindersSeconds) {
        if (op.remindersSent.includes(r) || now < op.readyAt - r || now >= op.readyAt) continue;
        op.remindersSent.push(r);
        await this.raise("TIMELOCK_REMINDER", `时间锁提议 ${op.id} 将在 ${Math.round((op.readyAt - now) / 3600)}h 后可执行（${op.chain}）：${op.calls.map((x) => x.fn).join(", ")}`, {
          chain: op.chain,
          detail: { id: op.id, readyAt: op.readyAt, calls: op.calls },
          key: `tlrem:${id}:${r}`,
        });
      }
    }
  }

  // ------------------------------------------------------------------ periodic jobs
  private async periodic(): Promise<void> {
    const m = this.state.meta;
    const now = this.now();
    if (now - m.lastReconcileAt >= this.cfg.reconcile.intervalSeconds) {
      m.lastReconcileAt = now;
      await this.reconcile();
    } else if (this.paramsDirty) await this.checkParams();
    if (now - m.lastHeartbeatAt >= this.cfg.heartbeatIntervalSeconds) {
      m.lastHeartbeatAt = now;
      await this.beat();
    }
    if (now - m.lastGasCheckAt >= this.cfg.gasCheckIntervalSeconds) {
      m.lastGasCheckAt = now;
      for (const c of CHAINS) await this.checkChainIds(c); // B5: runtime re-check
      await this.checkGas();
      await this.checkLegacyNonces();
    }
  }

  private async beat(): Promise<void> {
    try {
      await this.d.heartbeat.beat({
        at: this.now(),
        cursors: { bsc: this.state.derived.bsc.cursor?.number ?? null, wantos: this.state.derived.wantos.cursor?.number ?? null },
        pendingChecks: this.state.derived.pending.length,
      });
      this.alerts.clearKey("heartbeat");
    } catch (e) {
      await this.raise("HEARTBEAT_FAILED", "向外部心跳服务报到失败", { detail: { error: errMsg(e) }, key: "heartbeat" });
    }
    if (this.d.relayerProbe) {
      let alive = false;
      try {
        alive = await this.d.relayerProbe.isAlive();
      } catch {
        alive = false;
      }
      if (alive) this.resolve("relayer-down");
      else await this.raise("RELAYER_UNREACHABLE", "付款程序失联", { key: "relayer-down" });
    }
  }

  private async checkGas(): Promise<void> {
    for (const g of this.cfg.gasWatch) {
      const k = `gas:${g.chain}:${lc(g.address)}`;
      try {
        const bal = await this.d.rpc[g.chain].primary((c) => c.getBalance({ address: g.address }));
        if (bal < g.minWei) await this.raise("GAS_LOW", `${g.chain} ${g.label} gas 不足：${bal} < ${g.minWei}`, { chain: g.chain, detail: { address: g.address, balance: bal.toString() }, key: k });
        else this.alerts.clearKey(k);
      } catch (e) {
        await this.raise("RPC_UNREACHABLE", `${g.chain} 读取 gas 余额失败`, { chain: g.chain, detail: { error: errMsg(e) }, key: `${k}:err` });
      }
    }
  }

  private async checkLegacyNonces(): Promise<void> {
    for (const l of this.cfg.legacyAddresses) {
      const k = `${l.chain}:${lc(l.address)}`;
      try {
        const n = await this.d.rpc[l.chain].primary((c) => c.getTransactionCount({ address: l.address, blockTag: "latest" }));
        const prev = this.state.meta.watchedNonces[k];
        this.state.meta.watchedNonces[k] = String(n);
        if (prev !== undefined && BigInt(n) > BigInt(prev))
          await this.raise("LEGACY_ACTIVITY", `${l.chain} ${l.label} 发出了新交易（nonce ${prev} → ${n}）`, { chain: l.chain, detail: { address: l.address, from: prev, to: n }, key: `nonce:${k}:${n}` });
      } catch (e) {
        await this.raise("RPC_UNREACHABLE", `${l.chain} 读取 ${l.label} nonce 失败`, { chain: l.chain, detail: { error: errMsg(e) }, key: `nonce:${k}:err` });
      }
    }
  }

  // ------------------------------------------------------------------ §9.2 reconciliation + reserves + params
  private expected(c: ChainName): bigint {
    const s = this.state.derived[c].sums;
    return c === "wantos"
      ? sumOf(s, "funded") + sumOf(s, "bridgeOut") - sumOf(s, "released") - sumOf(s, "refunded") - sumOf(s, "withdrawn")
      : sumOf(s, "funded") + sumOf(s, "deposited") - sumOf(s, "released") - sumOf(s, "depositRefunded") - sumOf(s, "withdrawn") - sumOf(s, "legacyPaid");
  }

  private async reconcile(): Promise<void> {
    const now = this.now();
    const day = Math.floor(now / DAY);
    for (const c of CHAINS) {
      const cfg = this.cfg.chains[c];
      const cur = this.state.derived[c].cursor;
      if (!cur) continue;
      const at = BigInt(cur.number);
      const abi = bridgeAbiOf(c);
      const r = await this.d.rpc[c].consensus(async (cl) => {
        const [balance, params, today] = await Promise.all([
          cl.readContract({ address: cfg.token, abi: erc20Abi, functionName: "balanceOf", args: [cfg.bridge], blockNumber: at }),
          cl.readContract({ address: cfg.bridge, abi, functionName: "params", blockNumber: at }) as Promise<Record<string, bigint>>,
          cl.readContract({ address: cfg.bridge, abi, functionName: "currentDay", blockNumber: at }) as Promise<bigint>,
        ]);
        const used = (await cl.readContract({ address: cfg.bridge, abi, functionName: "dailyUsed", args: [today], blockNumber: at })) as bigint;
        return { balance, params, used };
      });
      if (!r.ok) {
        await this.raise("RECONCILE_FAILED", `${c} 对账失败：RPC ${r.reason}`, { chain: c, detail: { answers: r.answers }, key: `recfail:${c}:${Math.floor(now / 3600)}` });
        continue;
      }
      const { balance, params, used } = r.value;
      const expected = this.expected(c);
      const tol = this.cfg.reconcile.toleranceWei[c];
      const detail = { block: cur.number, balance: balance.toString(), expected: expected.toString(), tolerance: tol.toString(), sums: this.state.derived[c].sums };
      if (balance + tol < expected) {
        await this.raise("RECONCILE_SHORTFALL", `${c} 对账短缺：余额 ${balance} < 应有 ${expected} − 容差`, { chain: c, detail, key: `short:${c}:${cur.number}` });
      } else if (balance > expected) {
        this.alerts.daily({ kind: "RECONCILE_SURPLUS", chain: c, id: `${c}:${day}`, data: { ...detail, unregistered: (balance - expected).toString() } });
      }
      const cap = c === "bsc" ? params["dailyCap"]! : params["b2wDailyCap"]!;
      if (c === "bsc") {
        if (balance * 2n < cap) await this.raise("RESERVE_CRITICAL", `BSC 储备不足 0.5 天：${balance} < dailyCap/2`, { chain: c, detail: { balance: balance.toString(), dailyCap: cap.toString() }, key: `reserve-crit:${day}` });
        else if (balance < cap) await this.raise("RESERVE_LOW", `BSC 储备不足 1 天：${balance} < dailyCap`, { chain: c, detail: { balance: balance.toString(), dailyCap: cap.toString() }, key: `reserve-low:${day}` });
      } else {
        const low = this.cfg.reconcile.wantosLowBalanceWei ?? cap;
        if (balance < low) await this.raise("WANTOS_BALANCE_LOW", `WANTOS 桥余额偏低：${balance} < ${low}`, { chain: c, detail: { balance: balance.toString(), threshold: low.toString() }, key: `wlow:${day}` });
      }
      if (used * 10_000n >= cap * BigInt(this.cfg.dailyCapReportRatioBps))
        this.alerts.daily({ kind: "DAILY_CAP_70", chain: c, id: `${c}:${day}`, data: { used: used.toString(), cap: cap.toString() } });
    }
    await this.checkParams();
  }

  /** §5.5 cross-chain consistency: BSC perAddrDailyCap ≥ WANTOS w2bPerAddrDailyCap; BSC maxDepositPerTx ≤ WANTOS b2wDailyCap. */
  private async checkParams(): Promise<void> {
    this.paramsDirty = false;
    try {
      const read = async (c: ChainName) => {
        const cfg = this.cfg.chains[c];
        return this.d.rpc[c].primary(async (cl) => {
          this.decimals[c] ??= Number(await cl.readContract({ address: cfg.token, abi: erc20Abi, functionName: "decimals" }));
          return (await cl.readContract({ address: cfg.bridge, abi: bridgeAbiOf(c), functionName: "params" })) as Record<string, bigint>;
        });
      };
      const [b, w] = await Promise.all([read("bsc"), read("wantos")]);
      const sb = 10n ** BigInt(this.decimals.wantos!);
      const sw = 10n ** BigInt(this.decimals.bsc!);
      const problems: string[] = [];
      if (b["perAddrDailyCap"]! * sb < w["w2bPerAddrDailyCap"]! * sw) problems.push("BSC perAddrDailyCap < WANTOS w2bPerAddrDailyCap");
      if (b["maxDepositPerTx"]! * sb > w["b2wDailyCap"]! * sw) problems.push("BSC maxDepositPerTx > WANTOS b2wDailyCap");
      const k = `params:${problems.join("|")}:${b["perAddrDailyCap"]}:${w["w2bPerAddrDailyCap"]}:${b["maxDepositPerTx"]}:${w["b2wDailyCap"]}`;
      if (problems.length > 0) await this.raise("PARAMS_INCONSISTENT", `跨链参数不一致：${problems.join("；")}`, { detail: { bsc: b, wantos: w, problems }, key: k });
    } catch (e) {
      this.paramsDirty = true;
      await this.raise("RPC_UNREACHABLE", "读取参数失败", { detail: { error: errMsg(e) }, key: `params-err:${Math.floor(this.now() / 3600)}` });
    }
  }
}
