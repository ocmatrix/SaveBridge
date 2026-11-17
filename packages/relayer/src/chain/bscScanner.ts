import type { AlertSink } from "../alerts";
import { errText } from "../redact";
import type { Db } from "../db/types";
import type { SafetyState } from "../safety";
import type { Address } from "../types";
import { OrderRepo } from "../orders";
import { CursorRepo } from "./cursor";
import { b2wFromLog, DEPOSITED_TOPIC, sortLogs } from "./ingest";
import { logId, sameAddress, type BlockLite, type ChainReader, type RawLog } from "./reader";
import type { ScanResult } from "./wantosScanner";

export interface BscScannerOpts {
  chainId: number;
  vault: Address;
  readers: ChainReader[];
  db: Db;
  alerts: AlertSink;
  safety: SafetyState;
  rescanBlocks: number;
  maxBlockRange: number;
  startBlock: bigint;
  now?: () => Date;
}

/**
 * DESIGN §6.2 BSC data source: at least two independent RPCs, only `finalized` blocks. Any reader may
 * DISCOVER a deposit (union of every answering reader's logs); it is taken only once at least two readers
 * CONFIRM its receipt, and any contradiction (empty / different receipt, log outside the range) holds the
 * range and alerts. A reader that errors simply does not count. If a finalized block cannot be obtained
 * from at least two RPCs, or they disagree, we wait and alert — never fall back to `latest`.
 */
export class BscScanner {
  private firstScan = true;
  private readonly cursors: CursorRepo;

  constructor(private readonly o: BscScannerOpts) {
    if (o.readers.length < 2) throw new Error("BSC scanner needs at least 2 readers");
    this.cursors = new CursorRepo(o.db);
  }

  /**
   * Agreed finalized block across readers: readers that error or have no `finalized` do not count; at
   * least two must answer. We take the lowest answered height and require identical hashes there.
   * Returns null (and alerts) otherwise.
   */
  async agreedFinalized(): Promise<BlockLite | null> {
    const res = await Promise.all(this.o.readers.map((r) => r.getBlock({ blockTag: "finalized" }).catch(() => null)));
    const ok = res.filter((b): b is BlockLite => b !== null);
    if (ok.length < 2) {
      await this.o.alerts.emit({
        kind: "BSC_FINALIZED_UNAVAILABLE",
        key: "bsc:finalized",
        message: `BSC finalized block unavailable on ${this.o.readers.length - ok.length}/${this.o.readers.length} RPCs; waiting (no fallback)`,
      });
      return null;
    }
    const low = ok.reduce((m, b) => (b.number < m ? b.number : m), ok[0]!.number);
    const at = await this.blockAgreed(low);
    return at;
  }

  /** Block `n` with identical hash from every reader that answers (at least two), else null + alert. */
  private async blockAgreed(n: bigint): Promise<BlockLite | null> {
    const res = await Promise.all(this.o.readers.map((r) => r.getBlock({ blockNumber: n }).catch(() => null)));
    const ok = res.filter((b): b is BlockLite => b !== null);
    const hashes = new Set(ok.map((b) => b.hash.toLowerCase()));
    if (hashes.size > 1) {
      await this.o.alerts.emit({ kind: "RPC_MISMATCH", key: `bsc:block:${n}`, message: `BSC RPCs disagree on block ${n} hash` });
      return null;
    }
    if (ok.length < 2) {
      await this.o.alerts.emit({ kind: "RPC_UNAVAILABLE", key: `bsc:block`, message: `BSC block ${n} unavailable on some RPC` });
      return null;
    }
    return ok[0]!;
  }

  /**
   * Receipt of `log` from every reader (same rule as the WANTOS cross-check): a reader that errors is
   * skipped; an empty, failed or different receipt (block number / hash, or missing this exact log) is a
   * contradiction. ok needs no contradiction and at least two agreeing readers.
   */
  private async confirmLog(log: RawLog, from: bigint, to: bigint): Promise<"ok" | "mismatch" | "unavailable"> {
    if (log.blockNumber < from || log.blockNumber > to) return "mismatch";
    const want = logId(log);
    const res = await Promise.all(this.o.readers.map((r) => r.getTransactionReceipt(log.transactionHash).then((rc) => ({ rc }), () => null)));
    let agreed = 0;
    for (const x of res) {
      if (!x) continue;
      const rc = x.rc;
      if (!rc || rc.status !== "success" || rc.blockNumber !== log.blockNumber || rc.blockHash.toLowerCase() !== log.blockHash.toLowerCase() || !rc.logs.some((l) => logId(l) === want))
        return "mismatch";
      agreed++;
    }
    return agreed >= 2 ? "ok" : "unavailable";
  }

  async scanOnce(): Promise<ScanResult> {
    const o = this.o;
    if (o.safety.isHalted("bsc")) return { status: "halted", newOrders: 0 };
    try {
      const fin = await this.agreedFinalized();
      if (!fin) return { status: "waiting", newOrders: 0 };
      const cur = await this.cursors.get(o.chainId);
      let from = o.startBlock;
      if (cur) {
        const b = await this.blockAgreed(cur.block);
        if (!b) return { status: "waiting", newOrders: 0 };
        if (b.hash.toLowerCase() !== cur.hash.toLowerCase()) {
          await o.safety.reportReorg("bsc", { block: cur.block, storedHash: cur.hash, observedHash: b.hash });
          return { status: "halted", newOrders: 0 };
        }
        const rescanFrom = cur.block - BigInt(o.rescanBlocks) + 1n;
        from = this.firstScan ? (rescanFrom > o.startBlock ? rescanFrom : o.startBlock) : cur.block + 1n;
      }
      if (fin.number < from) return { status: "ok", newOrders: 0 };
      let to = from + BigInt(o.maxBlockRange) - 1n;
      if (to > fin.number) to = fin.number;

      // Union discovery: a reader that errors simply did not answer.
      const sets = await Promise.all(o.readers.map((r) => r.getLogs({ address: o.vault, fromBlock: from, toBlock: to }).catch(() => null)));
      const answered = sets.filter((s) => s !== null).length;
      const byId = new Map<string, RawLog>();
      for (const s of sets)
        for (const l of s ?? []) if (sameAddress(l.address, o.vault) && l.topics[0]?.toLowerCase() === DEPOSITED_TOPIC) byId.set(logId(l), l);
      const logs = sortLogs([...byId.values()]);

      const accepted: RawLog[] = [];
      let status: ScanResult["status"] = "ok";
      for (const log of logs) {
        const c = await this.confirmLog(log, from, to);
        if (c !== "ok") {
          await o.alerts.emit({
            kind: c === "mismatch" ? "RPC_MISMATCH" : "RPC_UNAVAILABLE",
            key: `bsc:receipt:${log.transactionHash}`,
            message: `BSC receipt check ${c} for tx ${log.transactionHash} (block ${log.blockNumber}); holding`,
          });
          to = log.blockNumber - 1n;
          status = "waiting";
          break;
        }
        accepted.push(log);
      }

      const ingest = async (repo: OrderRepo): Promise<number> => {
        let n = 0;
        for (const l of accepted) if (await repo.insertDetected(b2wFromLog(l, o.chainId, o.vault))) n++;
        return n;
      };
      let newOrders = 0;
      if (answered < 2) {
        // Only one reader vouched that the range holds nothing else: keep what two confirmed, do not move the cursor.
        await o.db.tx(async (t) => {
          newOrders = await ingest(new OrderRepo(t, o.now));
        });
        await o.alerts.emit({ kind: "RPC_UNAVAILABLE", key: "bsc:logs", message: `BSC getLogs answered by ${answered}/${o.readers.length} RPCs for ${from}..${to}; cursor not advanced` });
        return { status: "waiting", newOrders };
      }
      if (to < from) return { status: "waiting", newOrders: 0 };
      const toBlock = to === fin.number ? fin : await this.blockAgreed(to);
      if (!toBlock) return { status: "waiting", newOrders: 0 };

      await o.db.tx(async (t) => {
        newOrders = await ingest(new OrderRepo(t, o.now));
        await new CursorRepo(t).set(o.chainId, to, toBlock.hash);
      });
      this.firstScan = false;
      return { status, from, to, newOrders };
    } catch (e) {
      await o.alerts.emit({ kind: "RPC_UNAVAILABLE", key: "bsc:scan", message: `BSC scan failed: ${errText(e)}` });
      return { status: "waiting", newOrders: 0 };
    }
  }
}
