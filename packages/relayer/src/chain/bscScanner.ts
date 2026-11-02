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
 * DESIGN §6.2 BSC data source: at least two independent RPCs, only `finalized` blocks. If a
 * finalized block cannot be obtained from at least two RPCs, or they disagree, we wait and alert —
 * never fall back to `latest`.
 */
export class BscScanner {
  private firstScan = true;
  private readonly cursors: CursorRepo;

  constructor(private readonly o: BscScannerOpts) {
    if (o.readers.length < 2) throw new Error("BSC scanner needs at least 2 readers");
    this.cursors = new CursorRepo(o.db);
  }

  /**
   * Agreed finalized block across readers: every reader must answer `finalized`, we take the lowest
   * height and require identical hashes at that height. Returns null (and alerts) otherwise.
   */
  async agreedFinalized(): Promise<BlockLite | null> {
    const res = await Promise.all(this.o.readers.map((r) => r.getBlock({ blockTag: "finalized" }).catch(() => null)));
    const ok = res.filter((b): b is BlockLite => b !== null);
    if (ok.length < this.o.readers.length || ok.length < 2) {
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

  /** Same block (number) from every reader with identical hash, else null + alert. */
  private async blockAgreed(n: bigint): Promise<BlockLite | null> {
    const res = await Promise.all(this.o.readers.map((r) => r.getBlock({ blockNumber: n }).catch(() => null)));
    if (res.some((b) => b === null)) {
      await this.o.alerts.emit({ kind: "RPC_UNAVAILABLE", key: `bsc:block`, message: `BSC block ${n} unavailable on some RPC` });
      return null;
    }
    const hashes = new Set(res.map((b) => b!.hash.toLowerCase()));
    if (hashes.size !== 1) {
      await this.o.alerts.emit({ kind: "RPC_MISMATCH", key: `bsc:block:${n}`, message: `BSC RPCs disagree on block ${n} hash` });
      return null;
    }
    return res[0]!;
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

      const sets = await Promise.all(
        o.readers.map(async (r) =>
          sortLogs(
            (await r.getLogs({ address: o.vault, fromBlock: from, toBlock: to })).filter(
              (l) => sameAddress(l.address, o.vault) && l.topics[0]?.toLowerCase() === DEPOSITED_TOPIC,
            ),
          ),
        ),
      );
      const ids = sets.map((s) => s.map(logId).join("|"));
      if (new Set(ids).size !== 1) {
        await o.alerts.emit({ kind: "RPC_MISMATCH", key: `bsc:logs:${from}`, message: `BSC RPCs disagree on Deposited logs in ${from}..${to}` });
        return { status: "waiting", newOrders: 0 };
      }
      const logs: RawLog[] = sets[0]!;
      const toBlock = to === fin.number ? fin : await this.blockAgreed(to);
      if (!toBlock) return { status: "waiting", newOrders: 0 };

      let newOrders = 0;
      await o.db.tx(async (t) => {
        const repo = new OrderRepo(t, o.now);
        for (const l of logs) if (await repo.insertDetected(b2wFromLog(l, o.chainId, o.vault))) newOrders++;
        await new CursorRepo(t).set(o.chainId, to, toBlock.hash);
      });
      this.firstScan = false;
      return { status: "ok", from, to, newOrders };
    } catch (e) {
      await o.alerts.emit({ kind: "RPC_UNAVAILABLE", key: "bsc:scan", message: `BSC scan failed: ${errText(e)}` });
      return { status: "waiting", newOrders: 0 };
    }
  }
}
