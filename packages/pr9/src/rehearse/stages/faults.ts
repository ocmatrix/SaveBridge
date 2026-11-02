import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OrderRepo } from "@bridge/relayer/src/orders";
import type { Address } from "viem";
import { tok, type Ctx } from "../ctx";
import { b2wKey, bridgeOut, deposit, w2bKey } from "../flows";
import type { Side } from "../guard";
import { faults, pump, startRelayer, startWatcher, type RelayerSys, type WatcherSys } from "../services";
import { until } from "./emergency";

const codesSince = (w: WatcherSys, from: number) => w.sink.alerts.slice(from).map((a) => a.code);
const rKinds = (r: RelayerSys, from: number) => r.alerts.alerts.slice(from).map((a) => a.kind);
const dbDir = (ctx: Ctx) => join(ctx.runDir, "relayer-pg-e1");

/** Ticks that may throw (outage): count the failures, never crash the process. */
async function tolerantPump(ctx: Ctx, sys: { r?: RelayerSys | null; w?: WatcherSys | null }, n: number): Promise<number> {
  let errors = 0;
  for (let i = 0; i < n; i++) {
    await pump(ctx, {}); // mine / move time only
    for (const f of [() => sys.r?.relayer.tick(), () => sys.w?.w.tick()]) {
      try {
        await f();
      } catch {
        errors++;
      }
    }
  }
  return errors;
}

/** §10.1 F1–F11 (F8 is covered by the e2e stage; F6 WANTON rollback is local-only here). */
export async function stageFaults(ctx: Ctx): Promise<void> {
  const { keys } = ctx;
  let r = await startRelayer(ctx, { dbDir: dbDir(ctx) });
  let w = await startWatcher(ctx);
  const repo = () => new OrderRepo(r.db, () => new Date(ctx.clockSec * 1000));
  const status = async (k: `0x${string}`) => (await repo().get(k))?.status;
  await pump(ctx, { r, w }, 2);
  const rows = async () => Number((await r.db.query<{ n: string }>("select count(*) as n from orders")).rows[0]!.n);

  // F1 network outage (all RPCs of relayer + watcher, both chains), order sent meanwhile
  {
    const wFrom = w.sink.alerts.length;
    for (const s of ["wantos", "bsc"] as Side[]) faults[s].all = () => ({ handled: true, result: new Error("ECONNREFUSED (fault injection)") });
    const id = await bridgeOut(ctx, keys.user(15), tok(25)); // user's own tx goes through ctx's untampered client
    const errors = await tolerantPump(ctx, { r, w }, 3);
    for (const s of ["wantos", "bsc"] as Side[]) faults[s].all = null;
    const ok = await until(ctx, { r, w }, async () => (await status(w2bKey(ctx, id))) === "RELEASED", "F1 recovery");
    const att = await r.db.query<{ n: string }>("select count(distinct tx_hash) as n from tx_attempts where event_key = $1 and state = 'mined'", [Buffer.from(w2bKey(ctx, id).slice(2), "hex")]);
    ctx.check("F1", "断网：不崩溃、有告警；恢复后补扫，订单只放一次", ok && Number(att.rows[0]!.n) === 1 && codesSince(w, wFrom).some((c) => c.startsWith("RPC_") || c === "BSC_NO_FINALIZED"), `tick errors ${errors}, watcher ${[...new Set(codesSince(w, wFrom))].join(",")}`);
  }

  // F2 restart (relayer + watcher) mid-flow; F7 duplicate events / rescan
  {
    const id = await bridgeOut(ctx, keys.user(16), tok(170)); // large → queued
    await pump(ctx, { r, w }, 2);
    const before = await rows();
    await r.db.close();
    r = await startRelayer(ctx, { dbDir: dbDir(ctx) });
    w = await startWatcher(ctx);
    // F7: force a 300-block rescan (cursor moved back to a real block, with that block's real hash)
    for (const s of ["wantos", "bsc"] as Side[]) {
      const cur = await r.db.query<{ b: string }>("select last_processed_block as b from chain_cursor where chain_id = $1", [ctx.chains[s].chainId]);
      if (!cur.rows[0]) continue;
      const back = BigInt(cur.rows[0].b) > 300n ? BigInt(cur.rows[0].b) - 300n : 0n;
      const blk = await ctx.chains[s].pub.getBlock({ blockNumber: back });
      await r.db.query("update chain_cursor set last_processed_block = $2, last_block_hash = $3 where chain_id = $1", [ctx.chains[s].chainId, back.toString(), Buffer.from(blk.hash.slice(2), "hex")]);
    }
    await pump(ctx, { r, w }, 2);
    const after = await rows();
    const ok = await until(ctx, { r, w }, async () => (await status(w2bKey(ctx, id))) === "RELEASED", "F2 completes", { stepSec: 40 });
    ctx.check("F2", "付款程序 / 监控重启：从 DB / 状态文件续跑，订单完成", ok, `${(await repo().get(w2bKey(ctx, id)))?.status}/${(await repo().get(w2bKey(ctx, id)))?.reason}/${(await repo().get(w2bKey(ctx, id)))?.lastError ?? ""}`);
    ctx.check("F7", "重放同一区段（回扫 300 块）：无重复订单（event_key 主键）", after === before, `${before} → ${after}`);
  }

  // F3 crash after signing, before broadcast
  {
    await r.db.close();
    let crashed = false;
    r = await startRelayer(ctx, {
      dbDir: dbDir(ctx),
      hooks: {
        bsc: {
          afterSign: () => {
            if (!crashed) {
              crashed = true;
              throw new Error("injected crash after sign");
            }
          },
        },
      },
    });
    const u = keys.user(17);
    const bal0 = await ctx.tokenBalance("bsc", u.address);
    const id = await bridgeOut(ctx, u, tok(30));
    for (let i = 0; i < 40 && !crashed; i++) await tolerantPump(ctx, { r, w }, 1); // until the relayer signs (6 WANTON confirmations first)
    const signed = await r.db.query<{ state: string }>("select state from tx_attempts where event_key = $1", [Buffer.from(w2bKey(ctx, id).slice(2), "hex")]);
    await r.db.close();
    r = await startRelayer(ctx, { dbDir: dbDir(ctx) }); // restart: re-broadcast the persisted raw tx as-is
    const ok = await until(ctx, { r, w }, async () => (await status(w2bKey(ctx, id))) === "RELEASED", "F3 replay");
    const hashes = await r.db.query<{ n: string }>("select count(distinct tx_hash) as n from tx_attempts where event_key = $1", [Buffer.from(w2bKey(ctx, id).slice(2), "hex")]);
    ctx.check("F3", "签名后广播前崩溃：重启后原样重播同一笔原始交易，只付一次", crashed && signed.rows.length === 1 && ok && Number(hashes.rows[0]!.n) === 1 && (await ctx.tokenBalance("bsc", u.address)) === bal0 + tok(30), `attempt state before restart: ${signed.rows.map((x) => x.state).join(",")}`);
  }

  // F4 RPC disagreement: one BSC RPC of the watcher (and relayer cross-check) hides events
  {
    const from = w.sink.alerts.length;
    faults.bsc.watcherB = (m) => (m === "eth_getLogs" ? { handled: true, result: Promise.resolve([]) } : { handled: false });
    for (let i = 0; i < 6; i++) {
      await deposit(ctx, keys.user(98), tok(20), keys.user(98).address);
      await pump(ctx, { r, w });
    }
    const codes = codesSince(w, from);
    faults.bsc.watcherB = null;
    const paused = await Promise.all((["bsc", "wantos"] as Side[]).map((s) => ctx.view<boolean>(s, "paused")));
    ctx.check("F4", "RPC 不一致：minRpcAgreement=2 不满足时暂缓、不误暂停；连续分歧点名（RPC_DISSENTING）", codes.includes("RPC_DISAGREE") && paused.every((p) => !p), [...new Set(codes)].join(","));
    ctx.check("F4b", "连续分歧达到阈值后点名该 RPC（一级 RPC_DISSENTING）", codes.includes("RPC_DISSENTING"), [...new Set(codes)].join(","));
    await pump(ctx, { r, w }, 3);
  }

  // F5 BSC finalized unavailable
  {
    const wFrom = w.sink.alerts.length;
    const rFrom = r.alerts.alerts.length;
    const id = await bridgeOut(ctx, keys.user(18), tok(30));
    faults.bsc.all = (m, p) => (m === "eth_getBlockByNumber" && p[0] === "finalized" ? { handled: true, result: null } : { handled: false });
    for (let i = 0; i < 4; i++) await tolerantPump(ctx, { r, w }, 1);
    const st = await status(w2bKey(ctx, id));
    faults.bsc.all = null;
    const ok = await until(ctx, { r, w }, async () => (await status(w2bKey(ctx, id))) === "RELEASED", "F5 recovery");
    ctx.check("F5", "BSC 取不到 finalized：SUBMITTED 不会变 RELEASED、不退回 latest；BSC_NO_FINALIZED", st !== "RELEASED" && ok && (codesSince(w, wFrom).includes("BSC_NO_FINALIZED") || rKinds(r, rFrom).includes("BSC_FINALIZED_UNAVAILABLE")), `status during outage ${st}; ${[...new Set([...codesSince(w, wFrom), ...rKinds(r, rFrom)])].join(",")}`);
  }

  // F6 WANTON rollback (local: evm_snapshot / evm_revert; testnet: owner-authorized node rollback, A8)
  if (ctx.cfg.profile === "local") {
    const wFrom = w.sink.alerts.length;
    const rFrom = r.alerts.alerts.length;
    await pump(ctx, { r, w }, 1);
    const snap = await ctx.chains.wantos.snapshot();
    const orphanId = await bridgeOut(ctx, keys.user(19), tok(ctx.cfg.params.bsc.largeThreshold + 10)); // large → queued, not yet paid
    await pump(ctx, { r, w }, 3); // watcher / relayer have seen the order's block; BSC payout is Queued
    await ctx.chains.wantos.revertTo(snap);
    await ctx.chains.wantos.write(keys.user(20), ctx.d.token.wantos, (await import("../chain")).tokenAbi, "transfer", [keys.user(21).address, 1n]); // different history
    const paused = await until(ctx, { r, w }, async () => (await ctx.view<boolean>("bsc", "paused")) && (await ctx.view<boolean>("wantos", "paused")), "F6 reorg", { rounds: 10, stepSec: 5 }).catch(() => false);
    const codes = codesSince(w, wFrom);
    const orphan = await ctx.view<readonly [Address, bigint, bigint, number]>("bsc", "payouts", [w2bKey(ctx, orphanId)]);
    ctx.check("F6", "WANTON 回滚：监控发现 hash 变化 → 两链暂停 + WANTOS_REORG；付款程序停发；孤儿订单（已排队）不放款", paused && codes.includes("WANTOS_REORG") && rKinds(r, rFrom).includes("WANTOS_REORG") && Number(orphan[3]) !== 2, `paused=${paused} relayer=${[...new Set(rKinds(r, rFrom))].join(",")} orphan=${orphan[3]} watcher ${[...new Set(codes)].join(",")}`);
    // owner clears: cancel the orphan's queued payout, unpause both, restart the relayer (fresh safety latch)
    if (Number(orphan[3]) === 1) await ctx.call("bsc", ctx.acct("admin"), "cancelRelease", [orphanId]);
    for (const s of ["bsc", "wantos"] as Side[]) await ctx.call(s, ctx.acct("admin"), "unpause");
    await r.db.close();
    r = await startRelayer(ctx, { dbDir: dbDir(ctx) });
    const from2 = w.sink.alerts.length;
    await pump(ctx, { r, w }, 3);
    const again = await Promise.all((["bsc", "wantos"] as Side[]).map((s) => ctx.view<boolean>(s, "paused")));
    ctx.check("F6b", "人工清除（取消孤儿排队项）后解除暂停，不再循环暂停；孤儿订单仍不放款", again.every((p) => !p) && Number((await ctx.view<readonly [Address, bigint, bigint, number]>("bsc", "payouts", [w2bKey(ctx, orphanId)]))[3]) !== 2, codesSince(w, from2).join(","));
  } else ctx.note("F6 回滚只在 WANTON 上由负责人授权操作（A8）；本地彩排用 evm_snapshot/revert 演练");

  // F9 clock skew (> 60 s) on server B
  {
    const skewed = await startWatcher(ctx, { statePath: join(ctx.runDir, "watcher", "skew-state.json"), config: (c) => (c.maxClockSkewSeconds = 60) });
    const real = ctx.clockSec;
    ctx.clockSec = real + 120;
    await skewed.w.tick();
    ctx.clockSec = real;
    ctx.check("F9", "服务器 B 时钟偏移 > 60 s → CLOCK_SKEW（二级）", skewed.codes().includes("CLOCK_SKEW"));
  }

  // F10 watcher state file corrupted → automatic fallback to .bak, no duplicate pause on replay
  {
    await pump(ctx, { r, w }, 2);
    writeFileSync(join(ctx.runDir, "watcher", "state.json"), "{ corrupted");
    const w2 = await startWatcher(ctx);
    await pump(ctx, { r, w: w2 }, 2);
    const paused = await Promise.all((["bsc", "wantos"] as Side[]).map((s) => ctx.view<boolean>(s, "paused")));
    ctx.check("F10", "监控状态文件损坏：自动回退 .bak（STATE_RESTORED_FROM_BACKUP），不重复暂停", w2.codes().includes("STATE_RESTORED_FROM_BACKUP") && paused.every((p) => !p));
    w = w2;
  }

  // F11 server A reinstalled: DB lost, rebuilt from chain, nothing already settled is paid again
  {
    await pump(ctx, { r, w }, 2);
    const [orders, deposits] = [await ctx.view<bigint>("wantos", "orderNonce"), await ctx.view<bigint>("bsc", "depositNonce")];
    const settled = new Set<string>();
    for (let i = 1n; i <= orders; i++) if ([2, 3].includes(Number((await ctx.view<readonly [Address, bigint, bigint, number]>("bsc", "payouts", [w2bKey(ctx, i)]))[3]))) settled.add(w2bKey(ctx, i).toLowerCase());
    for (let i = 1n; i <= deposits; i++) if ([2, 3].includes(Number((await ctx.view<readonly [Address, bigint, bigint, number]>("wantos", "payouts", [b2wKey(ctx, i)]))[3]))) settled.add(b2wKey(ctx, i).toLowerCase());
    await r.db.close();
    r = await startRelayer(ctx, { dbDir: join(ctx.runDir, "relayer-pg-f11") });
    await pump(ctx, { r, w }, 6);
    const n = await rows();
    const sent = await r.db.query<{ k: Uint8Array | null }>("select distinct event_key as k from tx_attempts");
    const resent = sent.rows.map((x) => (x.k ? `0x${Buffer.from(x.k).toString("hex")}` : "")).filter((k) => settled.has(k));
    ctx.check("F11", "服务器 A 重装（丢弃 DB）：从链上重建订单；已结算（Released/Voided）的订单不再发任何交易", n === Number(orders + deposits) && resent.length === 0, `rebuilt ${n}/${orders + deposits} orders, settled ${settled.size}, new tx for pending ${sent.rows.length}, re-sent settled ${resent.length}`);
  }
  ctx.note("F8（额度 / 余额 / 白名单不一致 / 暂停中提交）已在 e2e 与 emergency 覆盖");
  void b2wKey;
  await r.db.close();
}
