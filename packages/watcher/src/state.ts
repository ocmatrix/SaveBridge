import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { ChainDerived, DerivedState, State } from "./types.js";

const emptyChain = (): ChainDerived => ({ cursor: null, lastUnpaused: null, sums: {} });

export const initialDerived = (): DerivedState => ({
  bsc: emptyChain(),
  wantos: emptyChain(),
  mintTotal: "0",
  pending: [],
  timelockOps: {},
  depositBlocks: {},
  maxOrderId: "0",
  maxDepositNonce: "0",
});

export const initialState = (): State => ({
  version: 1,
  derived: initialDerived(),
  meta: {
    decided: {},
    alertKeys: {},
    openLevel1: {},
    daily: { day: 0, entries: [] },
    lastReconcileAt: 0,
    lastHeartbeatAt: 0,
    lastGasCheckAt: 0,
    wantosHead: null,
    watchedNonces: {},
    controlledSetHash: null,
    controlledSet: [],
    snapshots: [],
    outbox: [],
  },
});

/** State is plain JSON: bigints (e.g. decoded event args kept for alert details) are stored as decimal strings. */
const replacer = (_k: string, x: unknown): unknown => (typeof x === "bigint" ? x.toString() : x);
export const toJson = (v: unknown): string => JSON.stringify(v, replacer);
export const clone = <T>(v: T): T => JSON.parse(toJson(v)) as T;

export interface StateStore {
  load(): Promise<State>;
  save(state: State): Promise<void>;
}

/** In-process store (tests). */
export class MemoryStateStore implements StateStore {
  private s: State = initialState();
  async load(): Promise<State> {
    return clone(this.s);
  }
  async save(state: State): Promise<void> {
    this.s = clone(state);
  }
}

/**
 * Single JSON file, replaced atomically (write temp + rename) on every tick.
 * Everything in `derived` can be rebuilt by replaying the chains from `startBlock`
 * (delete the file → full rescan); see PR7-NOTES §运维.
 */
export class FileStateStore implements StateStore {
  constructor(readonly path: string) {}

  async load(): Promise<State> {
    if (!existsSync(this.path)) return initialState();
    let parsed: State;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8")) as State;
    } catch (e) {
      // B8: a torn / corrupt main file → fall back to the previous good version
      if (!existsSync(`${this.path}.bak`)) throw e;
      parsed = JSON.parse(readFileSync(`${this.path}.bak`, "utf8")) as State;
    }
    if (parsed.version !== 1) throw new Error(`unsupported state file version ${String(parsed.version)}`);
    return parsed;
  }

  /** Write temp → fsync → keep the current file as `.bak` → atomic rename. */
  async save(state: State): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, toJson(state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existsSync(this.path)) copyFileSync(this.path, `${this.path}.bak`);
    renameSync(tmp, this.path);
  }
}
