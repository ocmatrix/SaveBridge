import { getAddress, isAddress, type Address } from "viem";
import type { ChainName } from "./types.js";

export type HeadPolicy = { kind: "finalized" } | { kind: "confirmations"; confirmations: number };

export interface ChainConfig {
  name: ChainName;
  chainId: number;
  rpcUrls: string[];
  bridge: Address;
  timelock: Address;
  token: Address;
  startBlock: bigint;
  head: HeadPolicy;
  maxBlockRange: number;
  maxLagBlocks: number;
}

export interface WatchedAddress {
  chain: ChainName;
  address: Address;
  label: string;
}

export interface GasWatch extends WatchedAddress {
  minWei: bigint;
}

export interface WatcherConfig {
  dataDir: string;
  minRpcAgreement: number;
  chains: Record<ChainName, ChainConfig>;
  /** §9.1 grace periods. */
  grace: { w2bSeconds: number; b2wBeforeEtaSeconds: number; refundBeforeExecSeconds: number; depositRefundBeforeExecSeconds: number };
  /** Gross mint (wei) above which the mint alert escalates to level 1 (decision 14: never pauses). */
  mintAlertThreshold: bigint;
  reconcile: { intervalSeconds: number; toleranceWei: Record<ChainName, bigint>; wantosLowBalanceWei: bigint | null };
  heartbeatIntervalSeconds: number;
  /** Upper bound of getLogs ranges processed per chain per tick (keeps a tick short while catching up). */
  maxRangesPerTick: number;
  gasCheckIntervalSeconds: number;
  wantosStallSeconds: number;
  /** System clock vs BSC latest block time; above this → CLOCK_SKEW (level 2). */
  maxClockSkewSeconds: number;
  /** B1: cursor not moving (and not caught up) for longer than this → level 1 CURSOR_STUCK. */
  cursorStallSeconds: number;
  /** r3: consecutive disagreements with the majority before an RPC is named (RPC_DISSENTING, level 1). */
  rpcDissentThreshold: number;
  pauseRetry: { attempts: number; backoffMs: number };
  timelockRemindersSeconds: number[];
  dailyCapReportRatioBps: number;
  gasWatch: GasWatch[];
  legacyAddresses: WatchedAddress[];
}

type Json = Record<string, unknown>;

const fail = (msg: string): never => {
  throw new Error(`watcher config: ${msg}`);
};
const obj = (v: unknown, path: string): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : fail(`${path} must be an object`));
const num = (v: unknown, path: string, min = 0): number =>
  typeof v === "number" && Number.isFinite(v) && v >= min ? v : fail(`${path} must be a number ≥ ${min}`);
const big = (v: unknown, path: string): bigint => {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return fail(`${path} must be a non-negative integer (string)`);
};
const addr = (v: unknown, path: string): Address => (typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : fail(`${path} must be an address`));
const str = (v: unknown, path: string): string => (typeof v === "string" && v.length > 0 ? v : fail(`${path} must be a string`));
const chainName = (v: unknown, path: string): ChainName => (v === "bsc" || v === "wantos" ? v : fail(`${path} must be "bsc" | "wantos"`));
const arr = (v: unknown, path: string): unknown[] => (Array.isArray(v) ? v : fail(`${path} must be an array`));

function parseChain(name: ChainName, raw: unknown, minAgree: number): ChainConfig {
  const c = obj(raw, `chains.${name}`);
  const rpcUrls = arr(c["rpcUrls"], `chains.${name}.rpcUrls`).map((u, i) => str(u, `chains.${name}.rpcUrls[${i}]`));
  if (rpcUrls.length < minAgree) fail(`chains.${name}.rpcUrls needs at least ${minAgree} independent RPCs`);
  const h = obj(c["head"], `chains.${name}.head`);
  let head: HeadPolicy;
  if (h["kind"] === "finalized") head = { kind: "finalized" };
  else if (h["kind"] === "confirmations") head = { kind: "confirmations", confirmations: num(h["confirmations"], `chains.${name}.head.confirmations`) };
  else return fail(`chains.${name}.head.kind must be "finalized" | "confirmations"`);
  return {
    name,
    chainId: num(c["chainId"], `chains.${name}.chainId`, 1),
    rpcUrls,
    bridge: addr(c["bridge"], `chains.${name}.bridge`),
    timelock: addr(c["timelock"], `chains.${name}.timelock`),
    token: addr(c["token"], `chains.${name}.token`),
    startBlock: big(c["startBlock"], `chains.${name}.startBlock`),
    head,
    maxBlockRange: num(c["maxBlockRange"] ?? 2000, `chains.${name}.maxBlockRange`, 1),
    maxLagBlocks: num(c["maxLagBlocks"] ?? 200, `chains.${name}.maxLagBlocks`, 1),
  };
}

const watched = (v: unknown, path: string): WatchedAddress => {
  const o = obj(v, path);
  return { chain: chainName(o["chain"], `${path}.chain`), address: addr(o["address"], `${path}.address`), label: str(o["label"], `${path}.label`) };
};

export function parseConfig(raw: unknown): WatcherConfig {
  const r = obj(raw, "root");
  const minRpcAgreement = num(r["minRpcAgreement"], "minRpcAgreement");
  if (minRpcAgreement < 2) fail("minRpcAgreement must be ≥ 2 (DESIGN §9.1 condition ②)");
  const chains = obj(r["chains"], "chains");
  const g = obj(r["grace"], "grace");
  const rec = obj(r["reconcile"], "reconcile");
  const tol = obj(rec["toleranceWei"], "reconcile.toleranceWei");
  const pr = obj(r["pauseRetry"], "pauseRetry");
  return {
    dataDir: str(r["dataDir"], "dataDir"),
    minRpcAgreement,
    chains: { bsc: parseChain("bsc", chains["bsc"], minRpcAgreement), wantos: parseChain("wantos", chains["wantos"], minRpcAgreement) },
    grace: {
      w2bSeconds: num(g["w2bSeconds"], "grace.w2bSeconds"),
      b2wBeforeEtaSeconds: num(g["b2wBeforeEtaSeconds"], "grace.b2wBeforeEtaSeconds"),
      refundBeforeExecSeconds: num(g["refundBeforeExecSeconds"], "grace.refundBeforeExecSeconds"),
      depositRefundBeforeExecSeconds: num(g["depositRefundBeforeExecSeconds"], "grace.depositRefundBeforeExecSeconds"),
    },
    mintAlertThreshold: big(r["mintAlertThreshold"], "mintAlertThreshold"),
    reconcile: {
      intervalSeconds: num(rec["intervalSeconds"], "reconcile.intervalSeconds", 1),
      toleranceWei: { bsc: big(tol["bsc"], "reconcile.toleranceWei.bsc"), wantos: big(tol["wantos"], "reconcile.toleranceWei.wantos") },
      wantosLowBalanceWei: rec["wantosLowBalanceWei"] === null || rec["wantosLowBalanceWei"] === undefined ? null : big(rec["wantosLowBalanceWei"], "reconcile.wantosLowBalanceWei"),
    },
    heartbeatIntervalSeconds: num(r["heartbeatIntervalSeconds"], "heartbeatIntervalSeconds", 1),
    maxRangesPerTick: num(r["maxRangesPerTick"] ?? 20, "maxRangesPerTick", 1),
    gasCheckIntervalSeconds: num(r["gasCheckIntervalSeconds"] ?? 300, "gasCheckIntervalSeconds", 1),
    wantosStallSeconds: num(r["wantosStallSeconds"], "wantosStallSeconds", 1),
    maxClockSkewSeconds: num(r["maxClockSkewSeconds"] ?? 60, "maxClockSkewSeconds", 1),
    cursorStallSeconds: num(r["cursorStallSeconds"] ?? 600, "cursorStallSeconds", 1),
    rpcDissentThreshold: num(r["rpcDissentThreshold"] ?? 5, "rpcDissentThreshold", 1),
    pauseRetry: { attempts: num(pr["attempts"], "pauseRetry.attempts", 1), backoffMs: num(pr["backoffMs"], "pauseRetry.backoffMs") },
    timelockRemindersSeconds: arr(r["timelockRemindersSeconds"], "timelockRemindersSeconds").map((x, i) => num(x, `timelockRemindersSeconds[${i}]`, 1)),
    dailyCapReportRatioBps: num(r["dailyCapReportRatioBps"] ?? 7000, "dailyCapReportRatioBps", 1),
    gasWatch: arr(r["gasWatch"] ?? [], "gasWatch").map((v, i) => {
      const w = watched(v, `gasWatch[${i}]`);
      return { ...w, minWei: big(obj(v, `gasWatch[${i}]`)["minWei"], `gasWatch[${i}].minWei`) };
    }),
    legacyAddresses: arr(r["legacyAddresses"] ?? [], "legacyAddresses").map((v, i) => watched(v, `legacyAddresses[${i}]`)),
  };
}
