import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeTimelockAbi, bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import { encodeFunctionData, keccak256, toHex, type Abi, type Account, type Address, type Hex } from "viem";
import { tokenAbi, type Chain } from "./chain";
import type { RehearsalConfig } from "./config";
import type { Side } from "./guard";
import type { Keys, Role } from "./keys";

export const U = 10n ** 18n;
export const tok = (n: number | bigint): bigint => BigInt(n) * U;
export const abiOf = (side: Side): Abi => (side === "bsc" ? bscVaultV2Abi : wantosBridgeV2Abi) as Abi;
export const TL_ABI = bridgeTimelockAbi as Abi;

export interface Deployment {
  deployer: Address;
  timelock: Address;
  implementation: Address;
  proxy: Address;
  token: Record<Side, Address>;
  deployBlock: Record<Side, string>;
  supplyCeiling: string;
}

/** Persisted across invocations (re-run of single stages with --run-dir). */
export interface RunState {
  deployment?: Deployment;
  /** Current holder of each changeable role (rotations in the role drills update these). */
  current: { admin: Role; wl: Role; pauser: Role; wantosRelayer: Role; bscRelayer: Role };
  /** Free-form per-stage results (orders created, salts used, ...). */
  data: Record<string, unknown>;
}

export interface Check {
  id: string;
  title: string;
  pass: boolean;
  detail: string;
  ms: number;
}

export interface StageResult {
  stage: string;
  checks: Check[];
  ms: number;
  notes: string[];
}

export class Ctx {
  state: RunState;
  results: StageResult[] = [];
  private cur: StageResult | null = null;
  private stepStart = Date.now();
  /** Chain-time "clock" used by the relayer / watcher (seconds). */
  clockSec = Math.floor(Date.now() / 1000);

  constructor(
    readonly cfg: RehearsalConfig,
    readonly runDir: string,
    readonly chains: Record<Side, Chain>,
    readonly keys: Keys,
  ) {
    const p = join(runDir, "state.json");
    this.state = existsSync(p)
      ? (JSON.parse(readFileSync(p, "utf8")) as RunState)
      : { current: { admin: "admin", wl: "wl", pauser: "pauser", wantosRelayer: "wantosRelayer", bscRelayer: "bscRelayer" }, data: {} };
  }

  save(): void {
    writeFileSync(join(this.runDir, "state.json"), JSON.stringify(this.state, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
  }

  get d(): Deployment {
    if (!this.state.deployment) throw new Error("not deployed yet: run the deploy stage first");
    return this.state.deployment;
  }

  acct(r: keyof RunState["current"]): Account {
    return this.keys.role(this.state.current[r]);
  }

  log(msg: string): void {
    const line = `[${new Date().toISOString()}] ${this.cur ? `${this.cur.stage}: ` : ""}${msg}`;
    console.log(line);
    appendFileSync(join(this.runDir, "rehearse.log"), `${line}\n`);
  }

  begin(stage: string): void {
    this.cur = { stage, checks: [], ms: 0, notes: [] };
    this.stepStart = Date.now();
    this.log("── stage start");
  }

  end(): StageResult {
    const r = this.cur!;
    r.ms = r.checks.reduce((s, c) => s + c.ms, 0);
    this.results.push(r);
    this.cur = null;
    return r;
  }

  note(s: string): void {
    this.cur?.notes.push(s);
    this.log(`note: ${s}`);
  }

  /** Records one pass/fail criterion; a failure throws (fail fast, log location printed by main). */
  check(id: string, title: string, pass: boolean, detail = ""): void {
    const now = Date.now();
    const c: Check = { id, title, pass, detail, ms: now - this.stepStart };
    this.stepStart = now;
    this.cur!.checks.push(c);
    this.log(`${pass ? "PASS" : "FAIL"} ${id} ${title}${detail ? ` — ${detail}` : ""}`);
    if (!pass) throw new Error(`check ${id} failed: ${title}${detail ? ` — ${detail}` : ""}`);
  }

  // ------------------------------------------------------------------ time
  /** Advances both chains to at least `ts` (warp) or waits for real block time to pass it. */
  private timeLock: Promise<void> = Promise.resolve();
  /** Serialized: parallel per-chain drills may wait for the same instant without double-warping. */
  waitUntil(ts: number, why: string): Promise<void> {
    const run = this.timeLock.then(() => this.waitUntilInner(ts, why));
    this.timeLock = run.catch(() => undefined);
    return run;
  }

  private async waitUntilInner(ts: number, why: string): Promise<void> {
    const [w, b] = await Promise.all([this.chains.wantos.latest(), this.chains.bsc.latest()]);
    if (Math.min(w.timestamp, b.timestamp) >= ts) return;
    if (this.cfg.waitMode === "warp") {
      const t = Math.max(ts, w.timestamp + 1, b.timestamp + 1);
      await Promise.all([this.chains.wantos.setNextTimestamp(t), this.chains.bsc.setNextTimestamp(t)]);
      this.log(`warp → ${t} (${why})`);
    } else {
      this.log(`waiting for chain time ${ts} (${why}) …`);
      for (;;) {
        const [a, c] = await Promise.all([this.chains.wantos.latest(), this.chains.bsc.latest()]);
        if (Math.min(a.timestamp, c.timestamp) >= ts) break;
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    await this.syncClock();
  }

  async advance(sec: number, why: string): Promise<void> {
    const [w, b] = await Promise.all([this.chains.wantos.latest(), this.chains.bsc.latest()]);
    await this.waitUntil(Math.max(w.timestamp, b.timestamp) + sec, why);
  }

  /** Keeps both local chains on the same clock (independent anvils drift with their own mining). */
  async alignChains(): Promise<void> {
    if (this.cfg.waitMode !== "warp") return;
    const [w, b] = await Promise.all([this.chains.wantos.latest(), this.chains.bsc.latest()]);
    const t = Math.max(w.timestamp, b.timestamp) + 1;
    await Promise.all([this.chains.wantos.setNextTimestamp(t), this.chains.bsc.setNextTimestamp(t)]);
  }

  async syncClock(): Promise<number> {
    const [w, b] = await Promise.all([this.chains.wantos.latest(), this.chains.bsc.latest()]);
    // chain time drives relayer / watcher clocks (≈ wall clock on a live testnet; correct after a local checkpoint restore)
    this.clockSec = Math.max(w.timestamp, b.timestamp);
    return this.clockSec;
  }

  // ------------------------------------------------------------------ contract helpers
  bridge(side: Side): { c: Chain; at: Address; abi: Abi } {
    return { c: this.chains[side], at: this.d.proxy, abi: abiOf(side) };
  }

  async call(side: Side, who: Account, fn: string, args: unknown[] = []): Promise<Hex> {
    const { c, at, abi } = this.bridge(side);
    return (await c.write(who, at, abi, fn, args)).hash;
  }

  async view<T>(side: Side, fn: string, args: unknown[] = []): Promise<T> {
    const { c, at, abi } = this.bridge(side);
    return c.read<T>(at, abi, fn, args);
  }

  /** Expect a revert (simulation only; nothing is broadcast). Returns the revert name. */
  async reverts(side: Side, who: Account | Address, fn: string, args: unknown[] = [], to?: Address, abi?: Abi): Promise<string> {
    const { c, at, abi: a } = this.bridge(side);
    return c.simulateRevert(who, to ?? at, abi ?? a, fn, args);
  }

  async tokenBalance(side: Side, who: Address): Promise<bigint> {
    return this.chains[side].read<bigint>(this.d.token[side], tokenAbi as Abi, "balanceOf", [who]);
  }

  // ------------------------------------------------------------------ timelock
  private saltCounter = 0;
  /** Admin wallet schedules `target.data` on `side`'s timelock with the minimum delay. */
  async propose(side: Side, target: Address, data: Hex, admin?: Account): Promise<{ salt: Hex; id: Hex; readyAt: number }> {
    const c = this.chains[side];
    const salt = keccak256(toHex(`pr9:${this.runDir}:${Date.now()}:${++this.saltCounter}`));
    const delay = await c.read<bigint>(this.d.timelock, TL_ABI, "getMinDelay");
    await c.write(admin ?? this.acct("admin"), this.d.timelock, TL_ABI, "schedule", [target, 0n, data, `0x${"00".repeat(32)}`, salt, delay]);
    const id = await c.read<Hex>(this.d.timelock, TL_ABI, "hashOperation", [target, 0n, data, `0x${"00".repeat(32)}`, salt]);
    const readyAt = Number(await c.read<bigint>(this.d.timelock, TL_ABI, "getTimestamp", [id]));
    return { salt, id, readyAt };
  }

  async executeProposal(side: Side, target: Address, data: Hex, salt: Hex, who?: Account): Promise<Hex> {
    return (await this.chains[side].write(who ?? this.keys.role("submitter"), this.d.timelock, TL_ABI, "execute", [target, 0n, data, `0x${"00".repeat(32)}`, salt])).hash;
  }

  executeReverts(side: Side, target: Address, data: Hex, salt: Hex): Promise<string> {
    return this.chains[side].simulateRevert(this.keys.role("submitter"), this.d.timelock, TL_ABI, "execute", [target, 0n, data, `0x${"00".repeat(32)}`, salt]);
  }

  /** propose → wait MIN_DELAY → execute (submission service key). */
  async viaTimelock(side: Side, fn: string, args: unknown[], target?: Address, abi?: Abi): Promise<void> {
    const t = target ?? this.d.proxy;
    const data = encodeFunctionData({ abi: abi ?? abiOf(side), functionName: fn, args } as never);
    const p = await this.propose(side, t, data);
    await this.waitUntil(p.readyAt, `timelock ${fn}`);
    await this.executeProposal(side, t, data, p.salt);
  }
}
