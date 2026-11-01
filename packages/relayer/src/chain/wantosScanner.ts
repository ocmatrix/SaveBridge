import type { AlertSink } from "../alerts";
import type { Db } from "../db/types";
import type { SafetyState } from "../safety";
import type { Address } from "../types";
import { OrderRepo } from "../orders";
import { CursorRepo } from "./cursor";
import { BRIDGE_OUT_TOPIC, sortLogs, w2bFromLog } from "./ingest";
import { logId, sameAddress, type ChainReader, type RawLog } from "./reader";

export interface ScanResult {
  status: "ok" | "waiting" | "halted";
  from?: bigint;
  to?: bigint;
  newOrders: number;
}

export interface WantosScannerOpts {
  chainId: number;
  bridge: Address;
  primary: ChainReader;
  crossChecks: ChainReader[];
  confirmations: number;
  db: Db;
  alerts: AlertSink;
  safety: SafetyState;
  rescanBlocks: number;
  maxBlockRange: number;
  startBlock: bigint;
  now?: () => Date;
}

type Check = "ok" | "mismatch" | "unavailable";

/**
 * DESIGN §6.2 WANTOS data source: self-hosted primary + cross-check RPC; events are processed only
 * after `confirmations` blocks and only when the receipt agrees on both sources; the cursor block
 * hash is re-verified every scan (hash change → reorg → halt).
 */
export class WantosScanner {
  private firstScan = true;
  private readonly cursors: CursorRepo;

  constructor(private readonly o: WantosScannerOpts) {
    if (o.crossChecks.length < 1) throw new Error("WANTOS scanner needs at least one cross-check reader");
    if (o.confirmations < 6) throw new Error("WANTOS confirmations must be >= 6");
    this.cursors = new CursorRepo(o.db);
  }

  private async alert(kind: "RPC_UNAVAILABLE" | "RPC_MISMATCH", message: string, key: string): Promise<void> {
    await this.o.alerts.emit({ kind, message: `WANTOS: ${message}`, key: `wantos:${key}` });
  }

  /** Receipt must exist and agree on the primary and on every reachable cross-check (at least one). */
  private async crossCheckLog(log: RawLog): Promise<Check> {
    const want = logId(log);
    const verify = (r: Awaited<ReturnType<ChainReader["getTransactionReceipt"]>>): boolean =>
      !!r && r.status === "success" && r.blockHash.toLowerCase() === log.blockHash.toLowerCase() && r.logs.some((l) => logId(l) === want);
    let p;
    try {
      p = await this.o.primary.getTransactionReceipt(log.transactionHash);
    } catch {
      return "unavailable";
    }
    if (!verify(p)) return "mismatch";
    let agreed = 0;
    for (const c of this.o.crossChecks) {
      let r;
      try {
        r = await c.getTransactionReceipt(log.transactionHash);
      } catch {
        continue;
      }
      if (!verify(r)) return "mismatch";
      agreed++;
    }
    return agreed > 0 ? "ok" : "unavailable";
  }

  private async crossCheckBlock(n: bigint, hash: string): Promise<Check> {
    let agreed = 0;
    for (const c of this.o.crossChecks) {
      let b;
      try {
        b = await c.getBlock({ blockNumber: n });
      } catch {
        continue;
      }
      if (!b) continue;
      if (b.hash.toLowerCase() !== hash.toLowerCase()) return "mismatch";
      agreed++;
    }
    return agreed > 0 ? "ok" : "unavailable";
  }

  async scanOnce(): Promise<ScanResult> {
    const o = this.o;
    if (o.safety.isHalted("wantos")) return { status: "halted", newOrders: 0 };
    try {
      const cur = await this.cursors.get(o.chainId);
      let from = o.startBlock;
      if (cur) {
        const b = await o.primary.getBlock({ blockNumber: cur.block });
        if (!b) {
          await this.alert("RPC_UNAVAILABLE", `primary does not know cursor block ${cur.block}`, "cursor");
          return { status: "waiting", newOrders: 0 };
        }
        if (b.hash.toLowerCase() !== cur.hash.toLowerCase()) {
          await o.safety.reportReorg("wantos", { block: cur.block, storedHash: cur.hash, observedHash: b.hash });
          return { status: "halted", newOrders: 0 };
        }
        const rescanFrom = cur.block - BigInt(o.rescanBlocks) + 1n;
        from = this.firstScan ? (rescanFrom > o.startBlock ? rescanFrom : o.startBlock) : cur.block + 1n;
      }
      const head = await o.primary.getBlockNumber();
      const safe = head - BigInt(o.confirmations);
      if (safe < from) return { status: "ok", newOrders: 0 };
      let to = from + BigInt(o.maxBlockRange) - 1n;
      if (to > safe) to = safe;

      const logs = sortLogs(
        (await o.primary.getLogs({ address: o.bridge, fromBlock: from, toBlock: to })).filter(
          (l) => sameAddress(l.address, o.bridge) && l.topics[0]?.toLowerCase() === BRIDGE_OUT_TOPIC,
        ),
      );
      const accepted: RawLog[] = [];
      let status: ScanResult["status"] = "ok";
      for (const log of logs) {
        const c = await this.crossCheckLog(log);
        if (c !== "ok") {
          await this.alert(
            c === "mismatch" ? "RPC_MISMATCH" : "RPC_UNAVAILABLE",
            `receipt cross-check ${c} for tx ${log.transactionHash} (block ${log.blockNumber}); holding`,
            `receipt:${log.transactionHash}`,
          );
          to = log.blockNumber - 1n;
          status = "waiting";
          break;
        }
        accepted.push(log);
      }
      if (to < from) return { status: "waiting", newOrders: 0 };

      const toBlock = await o.primary.getBlock({ blockNumber: to });
      if (!toBlock) return { status: "waiting", newOrders: 0 };
      const bc = await this.crossCheckBlock(to, toBlock.hash);
      if (bc !== "ok") {
        await this.alert(bc === "mismatch" ? "RPC_MISMATCH" : "RPC_UNAVAILABLE", `block ${to} hash cross-check ${bc}`, "block");
        return { status: "waiting", newOrders: 0 };
      }

      let newOrders = 0;
      await o.db.tx(async (t) => {
        const repo = new OrderRepo(t, o.now);
        for (const l of accepted) if (await repo.insertDetected(w2bFromLog(l, o.chainId, o.bridge))) newOrders++;
        await new CursorRepo(t).set(o.chainId, to, toBlock.hash);
      });
      this.firstScan = false;
      return { status, from, to, newOrders };
    } catch (e) {
      await this.alert("RPC_UNAVAILABLE", `scan failed: ${(e as Error).message}`, "scan");
      return { status: "waiting", newOrders: 0 };
    }
  }
}
