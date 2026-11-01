import { bridgeTimelockAbi } from "@bridge/abi";
import { getAbiItem, type Abi, type AbiEvent, type Address, type Hex, type Log, type PublicClient } from "viem";
import { AlertManager, type AlertCode, type AlertSink } from "./alerts.js";
import type { ControlledEntry, WatcherConfig } from "./config.js";
import { PAUSER_ROLE, bridgeAbiOf, computeEventKey, decodeLog, describeCall, erc20Abi, type DecodedLog } from "./events.js";
import type { Heartbeat, RelayerProbe } from "./heartbeat.js";
import type { PauseExecutor } from "./pauser.js";
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
  sink: AlertSink;
  pauser: PauseExecutor;
  heartbeat: Heartbeat;
  clock: Clock;
  controlledSet?: { load(): Promise<ControlledEntry[]> };
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

const add = (s: Record<string, string>, k: string, v: unknown): void => {
  s[k] = (BigInt(s[k] ?? "0") + BigInt(String(v))).toString();
};
const sumOf = (s: Record<string, string>, k: string): bigint => BigInt(s[k] ?? "0");
const lc = (a: string): string => a.toLowerCase();
const errMsg = (e: unknown): string => (e instanceof Error ? e.message.split("\n")[0]! : String(e));

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

  constructor(private readonly d: WatcherDeps) {
    this.cfg = d.config;
    this.alerts = new AlertManager(d.sink, () => this.state.meta, d.clock);
    this.verifier = new Verifier(d.config, d.rpc, () => this.state.derived);
  }

  async init(): Promise<void> {
    this.state = await this.d.store.load();
    await this.refreshControlledSet(false);
  }

  private now(): number {
    return this.d.clock();
  }

  private raise(code: AlertCode, title: string, o: { chain?: ChainName; detail?: Record<string, unknown>; key?: string } = {}): Promise<boolean> {
    return this.alerts.raise(code, { title, ...o });
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = { paused: [] };
    await this.alerts.flushDaily(); // close the previous UTC day before collecting this tick's entries
    const wantosOk = await this.checkWantosRollback(report);
    for (const c of CHAINS) if (c !== "wantos" || wantosOk) await this.advance(c);
    await this.evaluateChecks(report);
    await this.timelockReminders();
    await this.periodic();
    await this.alerts.repeatDue();
    this.snapshot();
    await this.d.store.save(this.state);
    return report;
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
        try {
          const b = await this.d.rpc.wantos.primary((c) => c.getBlock({ blockNumber: BigInt(wc.number) }));
          canonical = b.hash === wc.hash;
        } catch {
          canonical = false;
        }
      }
      if (canonical) {
        this.state.derived = clone(s.derived);
        return;
      }
      snaps.pop();
    }
    this.state.derived = initialDerived();
  }

  private snapshot(): void {
    const snaps = this.state.meta.snapshots;
    snaps.push({ wantosCursor: this.state.derived.wantos.cursor, derived: clone(this.state.derived) });
    if (snaps.length > MAX_SNAPSHOTS) snaps.splice(0, snaps.length - MAX_SNAPSHOTS);
  }

  // ------------------------------------------------------------------ heads & ingestion
  /**
   * Safe head = MIN over the RPCs that answered (BSC `finalized`, WANTOS latest − confirmations);
   * at least `minRpcAgreement` RPCs must answer, otherwise wait and alert.
   */
  private async safeHead(c: ChainName): Promise<bigint | null> {
    const cfg = this.cfg.chains[c];
    const rpc = this.d.rpc[c];
    const min = (xs: bigint[]): bigint => xs.reduce((a, b) => (b < a ? b : a));
    if (cfg.head.kind === "finalized") {
      const r = await rpc.all(async (cl) => (await cl.getBlock({ blockTag: "finalized" })).number);
      if (r.ok.length < rpc.minAgree) {
        await this.raise("BSC_NO_FINALIZED", `${c} 取不到 finalized 区块（仅 ${r.ok.length} 个 RPC 返回），等待`, { chain: c, detail: { failed: r.failed }, key: `nofinal:${c}` });
        return null;
      }
      this.alerts.clearKey(`nofinal:${c}`);
      return min(r.ok.map((x) => x.value));
    }
    const r = await rpc.all((cl) => cl.getBlockNumber({ cacheTime: 0 }));
    if (r.ok.length < rpc.minAgree) {
      await this.raise("RPC_UNREACHABLE", `${c} 可用 RPC 不足（${r.ok.length}/${rpc.endpoints.length}）`, { chain: c, detail: { failed: r.failed }, key: `unreach:${c}` });
      return null;
    }
    this.alerts.clearKey(`unreach:${c}`);
    const latest = min(r.ok.map((x) => x.value));
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
    if (head === null) return;
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
    const cur = der.cursor ? BigInt(der.cursor.number) : cfg.startBlock - 1n;
    if (head - cur > BigInt(cfg.maxLagBlocks)) {
      await this.raise("INDEX_LAG", `${c} 监控落后 ${head - cur} 块`, { chain: c, detail: { head: head.toString(), cursor: cur.toString() }, key: `lag:${c}` });
    } else this.alerts.clearKey(`lag:${c}`);
  }

  private legacyOn(c: ChainName): Address[] {
    return this.cfg.legacyAddresses.filter((l) => l.chain === c).map((l) => l.address);
  }

  private controlledOn(c: ChainName): Address[] {
    return c === "wantos" ? (this.state.meta.controlledSet as Address[]) : [];
  }

  private async fetchLogs(cl: PublicClient, c: ChainName, fromBlock: bigint, toBlock: bigint): Promise<Array<{ source: DecodedLog["source"]; log: Log }>> {
    const cfg = this.cfg.chains[c];
    const out: Array<{ source: DecodedLog["source"]; log: Log }> = [];
    for (const log of await cl.getLogs({ address: [cfg.bridge, cfg.timelock], fromBlock, toBlock })) {
      out.push({ source: lc(log.address) === lc(cfg.bridge) ? "bridge" : "timelock", log });
    }
    const transfer = getAbiItem({ abi: erc20Abi, name: "Transfer" }) as AbiEvent;
    const watched = [...this.legacyOn(c), ...this.controlledOn(c)];
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
    const union = new Map<string, { variants: Map<string, { entry: Entry; n: number }>; labels: Set<string> }>();
    for (const { label, value } of res.ok) {
      for (const entry of value) {
        const k = `${entry.log.transactionHash}:${entry.log.logIndex}`;
        const sig = stableStringify({ a: lc(entry.log.address), t: entry.log.topics, d: entry.log.data, h: entry.log.blockHash, s: entry.source });
        const u = union.get(k) ?? { variants: new Map(), labels: new Set<string>() };
        const v = u.variants.get(sig) ?? { entry, n: 0 };
        v.n++;
        u.variants.set(sig, v);
        u.labels.add(label);
        union.set(k, u);
      }
    }
    for (const [k, u] of union) {
      if (u.labels.size < res.ok.length || u.variants.size > 1)
        await this.raise("RPC_DISAGREE", `${c} 各 RPC 返回的事件不一致（${k}），已按并集处理，假事件由逐笔共识复核过滤`, {
          chain: c,
          detail: { log: k, reportedBy: [...u.labels], answered: res.ok.map((x) => x.label), variants: u.variants.size },
          key: `logdiff:${c}:${k}`,
        });
    }
    // same position, different content → keep the variant reported by most RPCs (also alerted above)
    const logs = [...union.values()].map((u) => [...u.variants.values()].reduce((a, b) => (b.n > a.n ? b : a)).entry);
    logs.sort((a, b) => (a.log.blockNumber! === b.log.blockNumber! ? a.log.logIndex! - b.log.logIndex! : a.log.blockNumber! < b.log.blockNumber! ? -1 : 1));
    const endC = await rpc.consensus(async (cl) => {
      const b = await cl.getBlock({ blockNumber: to });
      return { hash: b.hash, timestamp: Number(b.timestamp) };
    });
    if (!endC.ok) throw new Error(`block ${to} not confirmed by ≥${rpc.minAgree} RPCs (${endC.reason})`);
    const end = endC.value;
    const times = new Map<bigint, number>([[to, end.timestamp]]);
    for (const { log } of logs) {
      const n = log.blockNumber!;
      if (times.has(n)) continue;
      const t = await rpc.consensus(async (cl) => Number((await cl.getBlock({ blockNumber: n })).timestamp));
      if (!t.ok) throw new Error(`timestamp of block ${n} not confirmed (${t.reason})`);
      times.set(n, t.value);
    }
    const abiFor = (s: DecodedLog["source"]): Abi => (s === "bridge" ? bridgeAbiOf(c) : s === "timelock" ? (bridgeTimelockAbi as Abi) : (erc20Abi as Abi));
    for (const { source, log } of logs) {
      const meta = { address: log.address, block: log.blockNumber!, blockHash: log.blockHash!, txHash: log.transactionHash!, logIndex: log.logIndex!, timestamp: times.get(log.blockNumber!)! };
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
    const a = l.args;
    const key = this.evKey(c, l);
    const g = this.cfg.grace;
    switch (l.name) {
      case "BridgeOut":
        add(der.sums, "bridgeOut", a["amount"]);
        if (BigInt(String(a["orderId"])) > BigInt(this.state.derived.maxOrderId)) this.state.derived.maxOrderId = String(a["orderId"]);
        return;
      case "Deposited":
        add(der.sums, "deposited", a["amount"]);
        this.state.derived.depositBlocks[String(a["nonce"])] = l.block.toString();
        if (BigInt(String(a["nonce"])) > BigInt(this.state.derived.maxDepositNonce)) this.state.derived.maxDepositNonce = String(a["nonce"]);
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
        if (c === "bsc") this.addCheck("w2b", c, l, a["srcEventNonce"], a["to"], a["amount"], a["eventKey"], l.timestamp + g.w2bSeconds);
        return;
      case "ReleaseQueued": {
        const eta = Number(a["executableAt"]);
        if (c === "bsc") this.addCheck("w2b", c, l, a["srcEventNonce"], a["to"], a["amount"], a["eventKey"], l.timestamp + g.w2bSeconds);
        else this.addCheck("b2w", c, l, a["srcEventNonce"], a["to"], a["amount"], a["eventKey"], eta - g.b2wBeforeEtaSeconds);
        this.alerts.daily({ kind: "RELEASE_QUEUED", chain: c, id: key, data: { nonce: String(a["srcEventNonce"]), to: a["to"], amount: String(a["amount"]), executableAt: eta } });
        return;
      }
      case "RefundRequested":
        this.addCheck("refund", c, l, a["orderId"], a["user"], a["amount"], a["eventKey"], Number(a["executableAt"]) - g.refundBeforeExecSeconds);
        this.alerts.daily({ kind: "REFUND_REQUESTED", chain: c, id: key, data: { orderId: String(a["orderId"]), amount: String(a["amount"]) } });
        return;
      case "DepositRefundRequested":
        this.addCheck("depositRefund", c, l, a["nonce"], a["from"], a["amount"], a["eventKey"], Number(a["executableAt"]) - g.depositRefundBeforeExecSeconds);
        this.alerts.daily({ kind: "DEPOSIT_REFUND_REQUESTED", chain: c, id: key, data: { nonce: String(a["nonce"]), amount: String(a["amount"]) } });
        return;
      case "RefundCancelled":
        this.dropChecks("refund", String(a["orderId"]));
        return;
      case "DepositRefundCancelled":
        this.dropChecks("depositRefund", String(a["nonce"]));
        return;
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
        der.lastUnpausedBlock = l.block.toString();
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
        const cfg = this.cfg.chains[c];
        const op = (ops[id] ??= { chain: c, id: a["id"] as Hex, readyAt: l.timestamp + Number(a["delay"]), calls: [], remindersSent: [] });
        const call = describeCall(a["target"] as Address, a["data"] as Hex, cfg.bridge, cfg.timelock, c);
        op.calls.push({ target: a["target"] as Address, ...call });
        if (!this.newOps.includes(id)) this.newOps.push(id);
        return;
      }
      case "CallExecuted":
        delete ops[id];
        return;
      case "Cancelled":
        delete ops[id];
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
      const total = BigInt(this.state.derived.mintTotal) + value;
      this.state.derived.mintTotal = total.toString();
      const detail = { to: l.args["to"], value: value.toString(), grossTotal: total.toString(), threshold: this.cfg.mintAlertThreshold.toString(), txHash: l.txHash };
      if (total > this.cfg.mintAlertThreshold) await this.raise("MINT_EXCESS", `WANTOS-USDT 增发过量：累计 ${total} > 阈值（只告警，不暂停）`, { chain: c, detail, key });
      else await this.raise("MINT", `WANTOS-USDT 增发 ${value}（累计 ${total}，只告警）`, { chain: c, detail, key });
    }
    const legacy = new Set(this.legacyOn(c).map(lc));
    const controlled = new Set(this.controlledOn(c).map(lc));
    if (legacy.has(from) || legacy.has(to)) {
      await this.raise("LEGACY_ACTIVITY", `${c} 旧桥地址有资金动作`, { chain: c, detail: this.evDetail(l), key: `${key}:legacy` });
    }
    if (controlled.has(from) || controlled.has(to)) {
      await this.raise("CONTROLLED_FUNDS_MOVED", `${c} 受控地址有资金动作`, { chain: c, detail: this.evDetail(l), key: `${key}:controlled` });
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
  private addCheck(kind: CheckKind, c: ChainName, l: DecodedLog, nonce: unknown, to: unknown, amount: unknown, eventKey: unknown, decideAt: number): void {
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
    });
  }

  private dropChecks(kind: CheckKind, nonce: string): void {
    this.state.derived.pending = this.state.derived.pending.filter((p) => !(p.kind === kind && p.nonce === nonce));
  }

  private decide(p: PendingCheck): void {
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
        continue;
      }
      const v = await this.verifier.verdict(p); // ② ≥2 RPCs agree, inside
      if (v.kind === "match" || v.kind === "cancelled") {
        this.decide(p);
        continue;
      }
      if (v.kind === "undecided") {
        await this.raise("RPC_DISAGREE", `${p.kind} 核对无法由 ≥2 个 RPC 一致确认，不暂停`, { chain: p.targetChain, detail: { check: p, verdict: v }, key: `disagree:${p.id}` });
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

  private async onMismatch(p: PendingCheck, reason: string, observed: unknown, report: TickReport): Promise<void> {
    const c = p.targetChain;
    await this.refreshUnpauseMarker(c);
    const ack = this.state.derived[c].lastUnpausedBlock;
    const detail = { reason, observed, check: p };
    if (ack !== null && BigInt(p.block) <= BigInt(ack)) {
      await this.raise("MISMATCH_ACKNOWLEDGED", `${p.kind} 不符，但事件早于解除暂停（区块 ${ack}），只告警不暂停`, { chain: c, detail, key: `ack:${p.id}` });
      this.decide(p);
      return;
    }
    const advice =
      p.kind === "b2w" ? "处置：先吊销被怀疑的付款钥匙 → 取消可疑排队项（cancelRelease / voidSource）→ 再解除暂停" : "处置：先吊销被怀疑的付款钥匙 → 取消可疑排队项 → 再解除暂停";
    const ok = await this.autoPause(c, report, `autopause:${p.id}`, { ...detail, advice });
    if (ok) this.decide(p);
    else p.pauseFailures = (p.pauseFailures ?? 0) + 1;
  }

  /** Look ahead (past the safe head) for an `Unpaused` so a just-unpaused chain is not re-paused for old events. */
  private async refreshUnpauseMarker(c: ChainName): Promise<void> {
    const cfg = this.cfg.chains[c];
    const der = this.state.derived[c];
    const fromBlock = der.cursor ? BigInt(der.cursor.number) + 1n : cfg.startBlock;
    try {
      const ev = getAbiItem({ abi: bridgeAbiOf(c), name: "Unpaused" }) as AbiEvent;
      const logs = await this.d.rpc[c].primary(async (cl) => {
        const latest = await cl.getBlockNumber({ cacheTime: 0 });
        return fromBlock > latest ? [] : cl.getLogs({ address: cfg.bridge, event: ev, fromBlock, toBlock: latest });
      });
      for (const l of logs) {
        if (der.lastUnpausedBlock === null || l.blockNumber! > BigInt(der.lastUnpausedBlock)) der.lastUnpausedBlock = l.blockNumber!.toString();
      }
    } catch {
      /* best effort; the ingested marker still applies */
    }
  }

  private async autoPause(c: ChainName, report: TickReport, key: string, detail: Record<string, unknown>): Promise<boolean> {
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
    await this.raise("PAUSE_FAILED", `自动暂停 ${c} 失败（已重试 ${out.attempts} 次），请手动暂停`, { chain: c, detail: { ...detail, outcome: out }, key: `${key}:failed:${this.now()}` });
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
      await this.checkGas();
      await this.checkLegacyNonces();
      await this.refreshControlledSet(true);
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
      if (alive) this.alerts.clearKey("relayer-down");
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

  private async refreshControlledSet(alertOnChange: boolean): Promise<void> {
    if (!this.d.controlledSet) return;
    const list = [...new Set((await this.d.controlledSet.load()).map((e) => lc(e.address)))].sort();
    const m = this.state.meta;
    const hash = list.join(",");
    if (m.controlledSetHash === hash) return;
    const before = new Set(m.controlledSet);
    const after = new Set(list);
    if (alertOnChange && m.controlledSetHash !== null)
      await this.raise("CONTROLLED_SET_CHANGED", "受控集合已变更", {
        detail: { added: list.filter((a) => !before.has(a)), removed: m.controlledSet.filter((a) => !after.has(a)) },
      });
    m.controlledSet = list;
    m.controlledSetHash = hash;
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
