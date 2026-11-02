import { decodeEventLog, encodeFunctionData, getAddress, type Abi, type PublicClient } from "viem";
import { redact } from "./redact";
import { bridgeTimelockAbi } from "@bridge/abi";
import type { AlertSink } from "./alerts";
import type { Db } from "./db/types";
import type { TxSender } from "./chain/sender";
import type { Address, Hex } from "./types";
import { fromBytes, toBytes } from "./bytes";
import { errText } from "./redact";

const ABI = bridgeTimelockAbi as Abi;
const ZERO32 = ("0x" + "00".repeat(32)) as Hex;
const H = 3600n;

interface Op {
  id: Hex;
  calls: { index: bigint; target: Address; value: bigint; data: Hex }[];
  predecessor: Hex;
  salt: Hex;
}

/**
 * Submission service (DESIGN §4.1 / §6.4): executes due, uncancelled timelock proposals with a hot
 * key that holds NO contract role (execution is open to anyone), and reminds the owner 24h and 6h
 * before a proposal becomes executable (so it can be reviewed and cancelled). Times are chain time.
 * Notices are persisted so a restart does not repeat them.
 */
export class TimelockExecutor {
  constructor(
    private readonly o: {
      chainId: number;
      timelock: Address;
      client: PublicClient;
      sender: TxSender;
      db: Db;
      alerts: AlertSink;
      fromBlock: bigint;
      /** Max getLogs range per request (default 2000). */
      maxBlockRange?: number;
    },
  ) {}

  private read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.o.client.readContract({ address: this.o.timelock, abi: ABI, functionName, args }) as Promise<T>;
  }

  /**
   * Incremental scan (Gate2 B4): from the persisted cursor to the latest block in ranges of at most
   * `maxBlockRange` (public RPCs reject large getLogs ranges). Each range is stored together with the
   * cursor, so a restart resumes where it stopped. Errors propagate to the caller (never swallowed).
   */
  async scan(): Promise<void> {
    const tl = toBytes(this.o.timelock);
    const cur = await this.o.db.query<{ last_block: string }>(
      "select last_block::text as last_block from timelock_cursor where chain_id = $1 and timelock = $2",
      [this.o.chainId, tl],
    );
    let from = cur.rows[0] ? BigInt(cur.rows[0].last_block) + 1n : this.o.fromBlock;
    const head = await this.o.client.getBlockNumber({ cacheTime: 0 });
    const range = BigInt(this.o.maxBlockRange ?? 2000);
    while (from <= head) {
      const to = from + range - 1n > head ? head : from + range - 1n;
      const logs = await this.o.client.getLogs({ address: this.o.timelock, fromBlock: from, toBlock: to });
      await this.o.db.tx(async (t) => {
        for (const l of logs) {
          let ev;
          try {
            ev = decodeEventLog({ abi: ABI, data: l.data, topics: l.topics });
          } catch {
            continue;
          }
          const a = ev.args as unknown as Record<string, unknown>;
          if (ev.eventName === "CallScheduled") {
            await t.query(
              `insert into timelock_calls (chain_id, op_id, idx, target, value, data, predecessor) values ($1,$2,$3,$4,$5,$6,$7)
               on conflict do nothing`,
              [this.o.chainId, toBytes(a.id as Hex), (a.index as bigint).toString(), toBytes(a.target as Hex), (a.value as bigint).toString(), toBytes(a.data as Hex), toBytes(a.predecessor as Hex)],
            );
          } else if (ev.eventName === "CallSalt") {
            await t.query("insert into timelock_salts (chain_id, op_id, salt) values ($1,$2,$3) on conflict do nothing", [this.o.chainId, toBytes(a.id as Hex), toBytes(a.salt as Hex)]);
          }
        }
        await t.query(
          `insert into timelock_cursor (chain_id, timelock, last_block) values ($1,$2,$3)
           on conflict (chain_id, timelock) do update set last_block = excluded.last_block`,
          [this.o.chainId, tl, to.toString()],
        );
      });
      from = to + 1n;
    }
  }

  /** All proposals discovered so far (from the DB). */
  async proposals(): Promise<Op[]> {
    const r = await this.o.db.query<{ op_id: Uint8Array; idx: string; target: Uint8Array; value: string; data: Uint8Array; predecessor: Uint8Array; salt: Uint8Array | null }>(
      `select c.op_id, c.idx::text as idx, c.target, c.value::text as value, c.data, c.predecessor, s.salt
         from timelock_calls c left join timelock_salts s on s.chain_id = c.chain_id and s.op_id = c.op_id
        where c.chain_id = $1 order by c.op_id, c.idx`,
      [this.o.chainId],
    );
    const ops = new Map<string, Op>();
    for (const row of r.rows) {
      const id = fromBytes(row.op_id)!;
      const op = ops.get(id) ?? { id, calls: [], predecessor: fromBytes(row.predecessor)!, salt: fromBytes(row.salt) ?? ZERO32 };
      op.calls.push({ index: BigInt(row.idx), target: getAddress(fromBytes(row.target)!), value: BigInt(row.value), data: fromBytes(row.data)! });
      ops.set(id, op);
    }
    for (const op of ops.values()) op.calls.sort((x, y) => (x.index < y.index ? -1 : 1));
    return [...ops.values()];
  }

  private async noticed(id: Hex, kind: string): Promise<boolean> {
    const r = await this.o.db.query("select 1 from timelock_notices where chain_id = $1 and op_id = $2 and kind = $3", [this.o.chainId, toBytes(id), kind]);
    return r.rows.length > 0;
  }
  private async notice(id: Hex, kind: string): Promise<boolean> {
    const r = await this.o.db.query(
      "insert into timelock_notices (chain_id, op_id, kind) values ($1, $2, $3) on conflict do nothing returning kind",
      [this.o.chainId, toBytes(id), kind],
    );
    return r.rows.length === 1;
  }

  private calldata(op: Op): Hex {
    if (op.calls.length === 1) {
      const c = op.calls[0]!;
      return encodeFunctionData({ abi: ABI, functionName: "execute", args: [c.target, c.value, c.data, op.predecessor, op.salt] });
    }
    return encodeFunctionData({
      abi: ABI,
      functionName: "executeBatch",
      args: [op.calls.map((c) => c.target), op.calls.map((c) => c.value), op.calls.map((c) => c.data), op.predecessor, op.salt],
    });
  }

  async tick(): Promise<void> {
    await this.scan();
    const now = (await this.o.client.getBlock({ blockTag: "latest" })).timestamp;
    for (const op of await this.proposals()) {
      const state = Number(await this.read<number>("getOperationState", [op.id])); // 0 Unset(cancelled) 1 Waiting 2 Ready 3 Done
      if (state === 0 || state === 3) continue;
      if (await this.read<boolean>("isOperationExpired", [op.id])) continue;
      const readyAt = await this.read<bigint>("getTimestamp", [op.id]);
      if (state === 1) {
        if (now >= readyAt - 6n * H) {
          await this.notice(op.id, "24h"); // window passed; never send a late 24h reminder
          if (await this.notice(op.id, "6h")) await this.remind(op, "6h", readyAt);
        } else if (now >= readyAt - 24n * H && !(await this.noticed(op.id, "24h"))) {
          await this.notice(op.id, "24h");
          await this.remind(op, "24h", readyAt);
        }
        continue;
      }
      // Ready: same epoch only (stale proposals after an admin recovery can never execute).
      const [pe, ep] = await Promise.all([this.read<bigint>("proposalEpoch", [op.id]), this.read<bigint>("epoch")]);
      if (pe !== ep) continue;
      const res = await this.o.sender.send({ eventKey: null, action: "timelock.execute", to: this.o.timelock, data: this.calldata(op) });
      if (res.kind === "sim-revert") {
        if (await this.notice(op.id, "blocked")) {
          await this.o.alerts.emit({
            kind: "TIMELOCK_EXEC_BLOCKED",
            key: op.id,
            message: `chain ${this.o.chainId}: timelock proposal ${op.id} is ready but execution reverts (${res.revert.errorName ?? redact(res.revert.message ?? "unknown")}); will retry`,
          });
        }
      } else if (res.kind === "sent" && (await this.notice(op.id, "executed"))) {
        await this.o.alerts.emit({ kind: "TIMELOCK_EXECUTED", key: op.id, message: `chain ${this.o.chainId}: executed timelock proposal ${op.id} (tx ${res.txHash})` });
      }
    }
  }

  private async remind(op: Op, window: "24h" | "6h", readyAt: bigint): Promise<void> {
    await this.o.alerts.emit({
      kind: "TIMELOCK_REMINDER",
      key: `${op.id}:${window}`,
      message: `chain ${this.o.chainId}: timelock proposal ${op.id} becomes executable in <= ${window} (readyAt ${readyAt}); cancel it if it is not yours`,
      data: { window, id: op.id, readyAt: readyAt.toString(), calls: op.calls.map((c) => ({ target: c.target, data: c.data })) },
    });
  }
}

/** Runs each executor once; a failure is alerted (redacted) and never swallowed silently (Gate2 B4). */
export async function runTimelockTicks(executors: TimelockExecutor[], alerts: AlertSink): Promise<void> {
  for (const ex of executors) {
    try {
      await ex.tick();
    } catch (e) {
      await alerts.emit({ kind: "TIMELOCK_EXECUTOR_ERROR", key: "timelock", message: `timelock executor failed: ${errText(e)}` });
    }
  }
}
