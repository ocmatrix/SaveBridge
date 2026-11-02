import { computeBatches, decodeCalldata } from "@bridge/offline-check";
import { OrderRepo } from "@bridge/relayer/src/orders";
import { encodeFunctionResult, encodeFunctionData, keccak256, toBytes, type Account, type Address, type Hex } from "viem";
import { tokenAbi } from "../chain";
import { TL_ABI, abiOf, tok, type Ctx } from "../ctx";
import { b2wKey, bridgeOut, decide, deposit, w2bKey } from "../flows";
import type { Side } from "../guard";
import { faults, pump, startRelayer, startWatcher, type RelayerSys, type WatcherSys } from "../services";
import { BATCH_TYPES, listHashOf, signBatch, sortAddrs, submitBatch } from "../whitelist";
import { PAUSER_ROLE, RELAYER_ROLE } from "./roles";
import { hashTypedData } from "viem";

/** Pump watcher (+ relayer) with time moving `stepSec` per round until `pred` holds. */
export async function until(ctx: Ctx, sys: { r?: RelayerSys | null; w?: WatcherSys | null }, pred: () => Promise<boolean>, what: string, o: { rounds?: number; stepSec?: number } = {}): Promise<boolean> {
  for (let i = 0; i < (o.rounds ?? 40); i++) {
    if (await pred()) return true;
    await ctx.advance(o.stepSec ?? 15, what); // warp: time travel; real: wait that much chain time
    await pump(ctx, sys);
  }
  return pred();
}

const paused = (ctx: Ctx, s: Side) => ctx.view<boolean>(s, "paused");
const newCodes = (w: WatcherSys, from: number) => w.sink.alerts.slice(from).map((a) => a.code);

/** Owner response after an automatic pause: void/cancel what is wrong, then unpause; the watcher must not pause again. */
async function unpauseAndConfirmNoLoop(ctx: Ctx, w: WatcherSys, r: RelayerSys | null, s: Side, id: string): Promise<void> {
  await ctx.call(s, ctx.acct("admin"), "unpause");
  const from = w.sink.alerts.length;
  await pump(ctx, { r, w }, 3);
  ctx.check(`${id}-noloop`, `${s} 解除暂停后不循环暂停（旧事件只告警）`, !(await paused(ctx, s)), newCodes(w, from).filter((c) => c !== "UNPAUSED").join(",") || "—");
}

/** §5 E1–E12 (+ §5.2, §8 X2/X3/X6, §9.1 M1–M4/M6, three no-false-pause conditions). */
export async function stageEmergency(ctx: Ctx): Promise<void> {
  const { keys, cfg } = ctx;
  const d = ctx.d;
  let r: RelayerSys | null = await startRelayer(ctx);
  let w = await startWatcher(ctx);
  const repo = () => new OrderRepo(r!.db, () => new Date(ctx.clockSec * 1000));
  await pump(ctx, { r, w }, 2);
  const W = keys.user(10); // whitelisted
  const W2 = keys.user(11);

  // ---------------------------------------------------------------- M1 + the three no-false-pause conditions (one fake payout)
  {
    const relayerKey = ctx.acct("bscRelayer");
    const frozen = await ctx.chains.wantos.latest();
    await ctx.advance(5, "M1 setup");
    // ① the watcher's WANTON view is stuck before the target event (both of its WANTON RPCs)
    faults.wantos.all = (m, p) => {
      if (m === "eth_blockNumber") return { handled: true, result: `0x${frozen.number.toString(16)}` };
      if (m === "eth_getBlockByNumber" && (p[0] === "latest" || p[0] === "safe" || p[0] === "finalized")) return { handled: true, result: ctx.chains.wantos.rpc("eth_getBlockByNumber", [`0x${frozen.number.toString(16)}`, p[1]]) };
      return { handled: false };
    };
    let from = w.sink.alerts.length;
    await ctx.call("bsc", relayerKey, "release", [900_001n, W.address, tok(5)]); // no BridgeOut behind it
    await pump(ctx, { r: null, w }, 1);
    ctx.check("M1-③", "宽限期内不暂停", !(await paused(ctx, "bsc")) && !newCodes(w, from).includes("AUTO_PAUSE"));
    await until(ctx, { w }, async () => newCodes(w, from).includes("CHECK_DEFERRED") || (await paused(ctx, "bsc")), "M1 ① source behind", { rounds: 6, stepSec: cfg.watcherGrace.w2bSeconds });
    ctx.check("M1-①", "源链进度落后（WANTON 视图卡住）：CHECK_DEFERRED（二级），不暂停", newCodes(w, from).includes("CHECK_DEFERRED") && !(await paused(ctx, "bsc")));
    // ② the source check cannot be confirmed by ≥2 RPCs (watcher-b's WANTON getLogs fails)
    faults.wantos.all = null;
    // RPC-b answers, but differently: it claims order 900001 exists and is Locked for W / 5 (a lying node)
    const ordersSel = encodeFunctionData({ abi: abiOf("wantos"), functionName: "orders", args: [900_001n] });
    faults.wantos.watcherB = (m, p) => {
      const q = p[0] as { data?: string; input?: string } | undefined;
      if (m !== "eth_call" || (q?.data ?? q?.input)?.toLowerCase() !== ordersSel.toLowerCase()) return { handled: false };
      return { handled: true, result: encodeFunctionResult({ abi: abiOf("wantos"), functionName: "orders", result: [W.address, tok(5), BigInt(ctx.clockSec), 1, 0n] } as never) };
    };
    from = w.sink.alerts.length;
    await until(ctx, { w }, async () => newCodes(w, from).includes("RPC_DISAGREE") || (await paused(ctx, "bsc")), "M1 ② rpc", { rounds: 6, stepSec: cfg.watcherGrace.w2bSeconds });
    ctx.check("M1-②", "RPC 无法一致确认：RPC_DISAGREE（二级），不暂停", newCodes(w, from).includes("RPC_DISAGREE") && !(await paused(ctx, "bsc")), newCodes(w, from).join(","));
    faults.wantos.watcherB = null;
    // all three conditions met → pause
    from = w.sink.alerts.length;
    const ok = await until(ctx, { w }, () => paused(ctx, "bsc"), "M1 → AUTO_PAUSE", { rounds: 10, stepSec: cfg.watcherGrace.w2bSeconds });
    ctx.check("M1", "BSC Released 无对应 BridgeOut → 暂停 BSC，AUTO_PAUSE 一级", ok && newCodes(w, from).includes("AUTO_PAUSE"));
    // §5.2-3 duplicate pause: a second mismatch while already paused → EnforcedPause handled as success
    from = w.sink.alerts.length;
    await ctx.call("bsc", ctx.acct("admin"), "unpause");
    await ctx.call("bsc", ctx.acct("pauser"), "pause"); // someone already paused it
    await ctx.call("bsc", ctx.acct("admin"), "unpause");
    await ctx.call("bsc", relayerKey, "release", [900_002n, W2.address, tok(5)]);
    await ctx.call("bsc", ctx.acct("pauser"), "pause");
    await until(ctx, { w }, async () => newCodes(w, from).includes("AUTO_PAUSE"), "§5.2-3", { rounds: 10, stepSec: cfg.watcherGrace.w2bSeconds });
    const dup = w.sink.alerts.slice(from).find((a) => a.code === "AUTO_PAUSE");
    ctx.check("§5.2-3", "桥已暂停时监控再 pause → 按成功处理（无 PAUSE_FAILED、不重试升级）", !!dup && !newCodes(w, from).includes("PAUSE_FAILED"), dup?.title ?? "");
  }

  // ---------------------------------------------------------------- E10 relayer server compromised (DB lies + fake payout)
  {
    await r.db.query("update orders set status = 'RELEASED' where status <> 'RELEASED' and status <> 'REFUNDED'");
    const from = w.sink.alerts.length;
    await ctx.call("bsc", ctx.acct("admin"), "unpause");
    await pump(ctx, { r: null, w }, 1);
    await ctx.call("bsc", ctx.acct("bscRelayer"), "release", [900_010n, W.address, tok(5)]);
    const ok = await until(ctx, { w }, () => paused(ctx, "bsc"), "E10", { stepSec: cfg.watcherGrace.w2bSeconds });
    ctx.check("E10", "付款程序被攻破（改 DB + 放无源款）：监控只读链上，仍暂停 BSC", ok && newCodes(w, from).includes("AUTO_PAUSE"));
  }

  // ---------------------------------------------------------------- E1 BSC payout key leaked
  {
    const leaked = ctx.acct("bscRelayer");
    await ctx.call("bsc", ctx.acct("admin"), "unpause"); // owner clears E10 (old events only acknowledged)
    await pump(ctx, { r: null, w }, 1);
    const fromE1 = w.sink.alerts.length;
    await ctx.call("bsc", leaked, "release", [900_019n, W2.address, tok(5)]); // whitelisted target, no BridgeOut
    await ctx.call("bsc", leaked, "queueRelease", [900_018n, W2.address, tok(cfg.params.bsc.largeThreshold + 1)]);
    const notWl = await ctx.reverts("bsc", leaked, "release", [900_020n, keys.user(70).address, tok(5)]);
    const p = (await ctx.view<{ perAddrDailyCap: bigint; dailyCap: bigint }>("bsc", "params"));
    const day = await ctx.view<bigint>("bsc", "currentDay");
    const addrUsed = await ctx.view<bigint>("bsc", "addrDailyUsed", [day, W.address]);
    const overCap = await ctx.reverts("bsc", leaked, "queueRelease", [900_021n, W.address, p.perAddrDailyCap - addrUsed + 1n]);
    ctx.check("E1-①②", "泄露的 BSC 付款钥匙：非白名单被拒；单地址 / 当日额度封顶", notWl === "NotWhitelisted" && /CapExceeded|AmountAboveLimit/.test(overCap) && (await ctx.view<bigint>("bsc", "dailyUsed", [day])) <= p.dailyCap, `${notWl} / ${overCap}`);
    const pausedE1 = await until(ctx, { w }, () => paused(ctx, "bsc"), "E1 ③", { stepSec: cfg.watcherGrace.w2bSeconds });
    ctx.check("E1-③", "宽限期后监控暂停 BSC（一级 AUTO_PAUSE）", pausedE1 && newCodes(w, fromE1).includes("AUTO_PAUSE"));
    // ④ revoke → cancel queued items → unpause, no loop
    await ctx.call("bsc", ctx.acct("admin"), "revokeKey", [RELAYER_ROLE, leaked.address]);
    await ctx.call("bsc", ctx.acct("admin"), "cancelRelease", [900_018n]);
    ctx.check("E1-④a", "管理钱包 revokeKey 立即生效；排队项已取消", (await ctx.reverts("bsc", leaked, "release", [900_022n, W.address, tok(1)])) !== "" && Number((await ctx.view<readonly [Address, bigint, bigint, number]>("bsc", "payouts", [w2bKey(ctx, 900_018n)]))[3]) === 3);
    await unpauseAndConfirmNoLoop(ctx, w, null, "bsc", "E1");
    // ⑤ re-grant a new payout key through the timelock (fast: 2 min)
    await ctx.viaTimelock("bsc", "grantRole", [RELAYER_ROLE, keys.role("bscRelayer2").address]);
    ctx.state.current.bscRelayer = "bscRelayer2";
    ctx.save();
    ctx.check("E1-⑤", "经时间锁补发新付款钥匙", await ctx.view<boolean>("bsc", "hasRole", [RELAYER_ROLE, keys.role("bscRelayer2").address]));
  }
  // relayer with the new key + rebuilt honest DB (E10 lied in it): drop and rebuild from chain (also F11)
  await r.db.close();
  r = await startRelayer(ctx, { dbDir: `${ctx.runDir}/relayer-pg-e1` });
  const okFlow = await bridgeOut(ctx, W2, tok(25));
  const k1 = w2bKey(ctx, okFlow);
  ctx.check("E1-after", "补发钥匙后新订单正常放款", await until(ctx, { r, w }, async () => (await repo().get(k1))?.status === "RELEASED", "flow after E1"));

  // ---------------------------------------------------------------- E2 + M2 (×3) WANTON payout key leaked / B2W mismatches
  {
    const leaked = ctx.acct("wantosRelayer");
    const dA = await deposit(ctx, keys.user(90), tok(40), keys.user(91).address);
    const dB = await deposit(ctx, keys.user(92), tok(40), keys.user(93).address);
    const cases: Array<[string, bigint, Address, bigint]> = [
      ["E2 编号不存在（BSC 无对应 Deposited）", 800_001n, keys.role("attacker").address, tok(30)],
      ["M2-收款人被改", dA, keys.role("attacker").address, tok(40)],
      ["M2-金额被改", dB, keys.user(93).address, tok(41)],
    ];
    for (const [title, n, to, amount] of cases) {
      const from = w.sink.alerts.length;
      const before = await ctx.tokenBalance("wantos", to);
      await ctx.call("wantos", leaked, "queueRelease", [n, to, amount]);
      const [, , queuedAt] = await ctx.view<readonly [Address, bigint, bigint, number]>("wantos", "payouts", [b2wKey(ctx, n)]);
      const eta = Number(queuedAt) + cfg.params.wantos.b2wDelaySec;
      const ok = await until(ctx, { w }, () => paused(ctx, "wantos"), title, { stepSec: 10 });
      const at = await ctx.syncClock();
      await ctx.call("wantos", ctx.acct("admin"), "cancelRelease", [n]);
      ctx.check(`E2/${title}`, `${title} → 在 eta 前暂停 WANTON，负责人取消，无资金到账`, ok && at < eta && newCodes(w, from).includes("AUTO_PAUSE") && (await ctx.tokenBalance("wantos", to)) === before, `paused at eta−${eta - at}s`);
      await unpauseAndConfirmNoLoop(ctx, w, null, "wantos", `E2/${title.slice(0, 6)}`);
    }
    // the two legit deposits were voided by those cancellations → B2W deposit refunds (§6 refund path)
    await ctx.call("wantos", ctx.acct("admin"), "revokeKey", [RELAYER_ROLE, leaked.address]);
    for (const n of [dA, dB]) await ctx.call("bsc", ctx.acct("admin"), "requestDepositRefund", [n]);
    await ctx.advance(180 + 5, "deposit refund wait");
    for (const n of [dA, dB]) await ctx.call("bsc", keys.role("submitter"), "executeDepositRefund", [n]);
    ctx.check("E2-refund", "被作废的两笔入账走 BSC 退款，退回原地址原金额", (await ctx.view<readonly [Address, bigint, bigint, number]>("bsc", "deposits", [dA]))[3] === 2);
  }

  // ---------------------------------------------------------------- E12 KMS / cloud account lost (WANTON payout key)
  {
    const dn = await deposit(ctx, keys.user(94), tok(30), keys.user(95).address);
    await pump(ctx, { r, w }, 3);
    const st = (await repo().get(b2wKey(ctx, dn)))?.status;
    const kms = r.alerts.alerts.filter((a) => a.kind === "RELAYER_KEY_REVOKED" || a.kind === "ORDER_FAILED" || a.kind === "KMS_FAILURE").length;
    ctx.check("E12-a", "WANTON 付款钥匙被吊销 / KMS 不可用：桥只停不丢钱（订单未放款）", st !== "RELEASED" && (await ctx.tokenBalance("wantos", keys.user(95).address)) === tok(5_000), `status ${st}, relayer alerts ${kms}`);
    const p = await ctx.propose("wantos", d.proxy, encodeFunctionData({ abi: abiOf("wantos"), functionName: "grantRole", args: [RELAYER_ROLE, keys.role("wantosRelayer2").address] }));
    const early = await ctx.executeReverts("wantos", d.proxy, encodeFunctionData({ abi: abiOf("wantos"), functionName: "grantRole", args: [RELAYER_ROLE, keys.role("wantosRelayer2").address] }), p.salt);
    await ctx.waitUntil(p.readyAt, "E12 regrant");
    await ctx.executeProposal("wantos", d.proxy, encodeFunctionData({ abi: abiOf("wantos"), functionName: "grantRole", args: [RELAYER_ROLE, keys.role("wantosRelayer2").address] }), p.salt);
    ctx.state.current.wantosRelayer = "wantosRelayer2";
    ctx.save();
    await r.db.close();
    r = await startRelayer(ctx, { dbDir: `${ctx.runDir}/relayer-pg-e1` });
    // a failed order needs an operator retry (PR-3 manual path)
    const o = await repo().get(b2wKey(ctx, dn));
    if (o?.status === "FAILED") await r.relayer.processor.retryFailed(o.eventKey);
    const done = await until(ctx, { r, w }, async () => (await repo().get(b2wKey(ctx, dn)))?.status === "RELEASED", "E12 flow", { stepSec: 30 });
    ctx.check("E12-b", "补发满时间锁才生效；新钥匙接上后该订单完成", early !== "" && done);
  }

  // ---------------------------------------------------------------- E3 pause key leaked
  {
    const leaked = ctx.acct("pauser");
    const from = w.sink.alerts.length;
    for (const s of ["bsc", "wantos"] as Side[]) await ctx.call(s, leaked, "pause");
    const other = await ctx.reverts("bsc", leaked, "unpause");
    const balB = await ctx.tokenBalance("bsc", d.proxy);
    await ctx.call("bsc", ctx.acct("wl"), "unpause"); // decision 17: either wallet
    await ctx.call("wantos", ctx.acct("admin"), "unpause");
    for (const s of ["bsc", "wantos"] as Side[]) await ctx.call(s, ctx.acct("admin"), "revokeKey", [PAUSER_ROLE, leaked.address]);
    const again = await ctx.reverts("bsc", leaked, "pause");
    await pump(ctx, { r, w }, 2);
    ctx.check("E3", "暂停钥匙泄露：其他调用被拒；两个钱包各解除一次；吊销后再暂停失败；资金无变化", other !== "" && again !== "" && (await ctx.tokenBalance("bsc", d.proxy)) === balB && newCodes(w, from).includes("PAUSER_REVOKED"), `${other}/${again}`);
    await Promise.all((["bsc", "wantos"] as Side[]).map((s) => ctx.viaTimelock(s, "grantRole", [PAUSER_ROLE, keys.role("pauser3").address]))); // one shared wait
    ctx.state.current.pauser = "pauser3";
    ctx.save();
    w = await startWatcher(ctx); // watcher re-wired to the new pause key
  }

  // ---------------------------------------------------------------- §8 X2 / X3 (M3) and X6 (M4)
  {
    // X3: refund requested while the order is unpaid → relayer must not pay; watcher pauses WANTON; WL cancels
    const id = await bridgeOut(ctx, keys.user(12), tok(30));
    await ctx.call("wantos", ctx.acct("admin"), "requestRefund", [id]);
    let from = w.sink.alerts.length;
    const ok = await until(ctx, { r, w }, () => paused(ctx, "wantos"), "X3/M3", { stepSec: 20 });
    const p = await ctx.view<readonly [Address, bigint, bigint, number]>("bsc", "payouts", [w2bKey(ctx, id)]);
    ctx.check("X3", "退款申请中（Refunding）付款程序不放款（重读 status≠Locked）", Number(p[3]) === 0);
    ctx.check("M3", "RefundRequested 但 BSC 未作废 → 可执行前暂停 WANTON", ok && newCodes(w, from).includes("AUTO_PAUSE"));
    const exec = await ctx.reverts("wantos", keys.role("submitter"), "executeRefund", [id]);
    await ctx.call("wantos", ctx.acct("wl"), "cancelRefund", [id]);
    await unpauseAndConfirmNoLoop(ctx, w, r, "wantos", "X3");
    // the relayer froze the order for owner review (REVIEW/onchain_mismatch); owner approves after the cancel
    await pump(ctx, { r, w }, 1);
    const frozenForReview = await repo().get(w2bKey(ctx, id));
    if (frozenForReview?.status === "REVIEW") await decide(ctx, r, frozenForReview, "approve");
    const released = await until(ctx, { r, w }, async () => (await repo().get(w2bKey(ctx, id)))?.status === "RELEASED", "X3 then pays", { stepSec: 30 });
    ctx.check("X2", "暂停中 executeRefund 不可用；WL 取消后订单冻结待负责人审核（REVIEW），批准后只放款一次（不退款）", exec === "EnforcedPause" && released, `exec=${exec} db=${(await repo().get(w2bKey(ctx, id)))?.status}/${(await repo().get(w2bKey(ctx, id)))?.reason}`);
    // X2 proper: already Released → admin (mistake / stolen) requests refund → paused; WL cancels; final = payout only
    from = w.sink.alerts.length;
    await ctx.call("wantos", ctx.acct("admin"), "requestRefund", [id]);
    const ok2 = await until(ctx, { r, w }, () => paused(ctx, "wantos"), "X2", { stepSec: 20 });
    await ctx.call("wantos", ctx.acct("wl"), "cancelRefund", [id]);
    await unpauseAndConfirmNoLoop(ctx, w, r, "wantos", "X2");
    const ord = await ctx.view<readonly [Address, bigint, bigint, number, bigint]>("wantos", "orders", [id]);
    ctx.check("X2b", "BSC 已 Released 后误申请退款 → 暂停 WANTON；最终只有放款", ok2 && Number(ord[3]) === 1 && newCodes(w, from).includes("AUTO_PAUSE"));
    // X6 / M4: deposit refund requested while WANTON payout not voided → pause BSC
    const dn = await deposit(ctx, keys.user(96), tok(30), keys.user(97).address);
    await ctx.call("bsc", ctx.acct("admin"), "requestDepositRefund", [dn]);
    from = w.sink.alerts.length;
    const ok3 = await until(ctx, { r, w }, () => paused(ctx, "bsc"), "X6/M4", { stepSec: 20 });
    await ctx.call("bsc", ctx.acct("wl"), "cancelDepositRefund", [dn]);
    await unpauseAndConfirmNoLoop(ctx, w, r, "bsc", "X6");
    await pump(ctx, { r, w }, 1);
    const fr = await repo().get(b2wKey(ctx, dn));
    if (fr?.status === "REVIEW") await decide(ctx, r, fr, "approve");
    const paid = await until(ctx, { r, w }, async () => (await repo().get(b2wKey(ctx, dn)))?.status === "RELEASED", "X6 then pays", { stepSec: 30 });
    ctx.check("X6/M4", "DepositRefundRequested 但 WANTON 未作废 → 暂停 BSC；取消（必要时负责人审核批准）后正常入账", ok3 && newCodes(w, from).includes("AUTO_PAUSE") && paid, `db=${(await repo().get(b2wKey(ctx, dn)))?.status}/${(await repo().get(b2wKey(ctx, dn)))?.reason} reviewed=${fr?.status === "REVIEW"}`);
  }

  // ---------------------------------------------------------------- E4 admin wallet lost (start + guarantees; full 14-min path ran in R8)
  {
    const from = w.sink.alerts.length;
    await ctx.chains.bsc.write(ctx.acct("wl"), d.timelock, TL_ABI, "startAdminRecovery", [keys.role("admin2").address]);
    const batch = await ctx.reverts("bsc", keys.role("submitter"), "applyWhitelistBatch", [[keys.user(64).address], true, await ctx.view<bigint>("bsc", "whitelistNonce"), BigInt(ctx.clockSec + 60), "0x"]);
    await ctx.call("bsc", ctx.acct("pauser"), "pause");
    await ctx.call("bsc", ctx.acct("wl"), "unpause");
    await ctx.chains.bsc.write(ctx.acct("admin"), d.timelock, TL_ABI, "cancelAdminRecovery");
    await pump(ctx, { r, w }, 2);
    ctx.check("E4", "管理钱包恢复期间：白名单禁写、WL 可 unpause、启动恢复触发一级 KEY_CHANGE；（完整 14 分钟路径见 R8）", /WritesBlocked|RecoveryInProgress/.test(batch) && newCodes(w, from).includes("KEY_CHANGE"), batch);
    ctx.note("E5（白名单钱包丢失）完整路径 = R7（无人取消 → 7 分钟后接收），不重复");
  }

  // ---------------------------------------------------------------- E6 admin wallet stolen
  {
    const thief = ctx.acct("admin");
    const from = w.sink.alerts.length;
    const props = [
      encodeFunctionData({ abi: abiOf("bsc"), functionName: "withdraw", args: [keys.role("attacker").address, tok(1000)] }),
      encodeFunctionData({ abi: abiOf("bsc"), functionName: "grantRole", args: [RELAYER_ROLE, keys.role("attacker").address] }),
    ];
    const ps = [];
    for (const data of props) ps.push(await ctx.propose("bsc", d.proxy, data, thief));
    await ctx.call("bsc", thief, "startWhitelistRecovery", [keys.role("attacker").address]);
    await pump(ctx, { r, w }, 2);
    for (const p of ps) await ctx.chains.bsc.write(ctx.acct("wl"), d.timelock, TL_ABI, "cancel", [p.id]); // WL cancels each
    await ctx.call("bsc", ctx.acct("wl"), "cancelWhitelistRecovery");
    const params = await ctx.view<Record<string, bigint>>("bsc", "params");
    await ctx.call("bsc", thief, "setParams", [{ ...params, minDeposit: params.minDeposit! + tok(1) }]); // tightening: immediate
    const tightened = (await ctx.view<Record<string, bigint>>("bsc", "params")).minDeposit === params.minDeposit! + tok(1);
    await ctx.advance(130, "E6 proposals would be ready");
    const exec = await ctx.executeReverts("bsc", d.proxy, props[0]!, ps[0]!.salt);
    const codes = newCodes(w, from);
    ctx.check("E6", "管理钱包被盗：提议触发一级告警、WL 逐条取消、恢复被现任 WL 取消、资金不动；收紧立即生效", codes.includes("TIMELOCK_PROPOSED") && codes.includes("KEY_CHANGE") && exec !== "" && tightened && !(await ctx.view<boolean>("bsc", "whitelistRecoveryActive")), `exec=${exec}`);
  }

  // ---------------------------------------------------------------- E7 whitelist wallet stolen (+ §5.2 freeze-first, void future orderId)
  {
    const thief = ctx.acct("wl");
    const victim = keys.user(66).address;
    // thief adds an address (BSC only for brevity) and pre-signs another add batch for later
    await submitBatch(ctx, await signBatch(ctx, "bsc", [victim], true, { signer: thief }));
    const presigned = await signBatch(ctx, "bsc", [victim], true, { signer: thief });
    // wrong order first (on a snapshot when local): emergencyRemove without freeze → pre-signed add re-adds
    let wrongOrderReAdds = "skipped on testnet";
    if (ctx.cfg.profile === "local") {
      const snap = await ctx.chains.bsc.snapshot();
      await ctx.call("bsc", ctx.acct("admin"), "emergencyRemove", [[victim]]);
      await submitBatch(ctx, presigned);
      wrongOrderReAdds = String(await ctx.view<boolean>("bsc", "whitelisted", [victim]));
      await ctx.chains.bsc.revertTo(snap);
    }
    // correct order: freeze FIRST, then emergencyRemove; pre-signed add cannot re-add
    await ctx.call("bsc", ctx.acct("admin"), "freezeWhitelist");
    await ctx.call("bsc", ctx.acct("admin"), "emergencyRemove", [[victim]]);
    const reAdd = await ctx.reverts("bsc", keys.role("submitter"), "applyWhitelistBatch", [presigned.sorted, true, presigned.nonce, presigned.deadline, presigned.signature]);
    ctx.check("E7-freeze", "先冻结再紧急移除：预签添加批次无法加回（顺序反了则会被加回）", reAdd === "WhitelistWritesBlocked" && !(await ctx.view<boolean>("bsc", "whitelisted", [victim])), `wrong-order re-added=${wrongOrderReAdds}, correct=${reAdd}`);
    // thief starts a handover to himself → admin vetoes
    await ctx.call("bsc", thief, "beginWhitelistManagerTransfer", [keys.role("attacker").address]);
    await ctx.call("bsc", ctx.acct("admin"), "cancelWhitelistManagerTransfer");
    // admin starts WL recovery now (both chains, one WL wallet); nobody cancels → 7 min. The void / refund drill
    // below runs inside that window (it needs no whitelist write and no timelock A-class execution).
    const [, , , coolB] = await ctx.view<[boolean, Address, bigint, bigint]>("bsc", "whitelistRecovery");
    await ctx.waitUntil(Number(coolB), "E6 left the admin in a recovery cooldown on BSC");
    await ctx.call("bsc", ctx.acct("admin"), "startWhitelistRecovery", [keys.role("wl4").address]);
    await ctx.call("wantos", ctx.acct("admin"), "startWhitelistRecovery", [keys.role("wl4").address]);
    // thief voids a FUTURE orderId on BSC → that order, once created, is rejected and refunded on WANTON
    const nextId = (await ctx.view<bigint>("wantos", "orderNonce")) + 1n;
    const from = w.sink.alerts.length;
    await ctx.call("bsc", thief, "voidSource", [nextId]);
    await pump(ctx, { r, w }, 2);
    ctx.check("§5.2-2", "作废未来 orderId → VOID_FUTURE_SOURCE 二级告警", newCodes(w, from).includes("VOID_FUTURE_SOURCE"));
    const id = await bridgeOut(ctx, keys.user(13), tok(20));
    const rej = await until(ctx, { r, w }, async () => ["REJECTED", "REFUNDING"].includes((await repo().get(w2bKey(ctx, id)))?.status ?? ""), "E7 voided order");
    await ctx.call("wantos", ctx.acct("admin"), "requestRefund", [id]);
    await ctx.advance(185, "refund wait");
    await ctx.call("wantos", keys.role("submitter"), "executeRefund", [id]);
    const ref = await until(ctx, { r, w }, async () => (await repo().get(w2bKey(ctx, id)))?.status === "REFUNDED", "E7 refund");
    ctx.check("E7-void", "被作废的未来订单：付款程序 BadPayoutStatus→REJECTED→WANTON 退款", rej && ref);
    // (WL recovery was started above; its 7-minute window overlapped the void → refund drill)
    const [, , ra1] = await ctx.view<[boolean, Address, bigint, bigint]>("bsc", "whitelistRecovery");
    const [, , ra2] = await ctx.view<[boolean, Address, bigint, bigint]>("wantos", "whitelistRecovery");
    await ctx.waitUntil(Math.max(Number(ra1), Number(ra2)), "E7 WL recovery");
    await ctx.call("bsc", keys.role("wl4"), "acceptWhitelistRecovery");
    await ctx.call("wantos", keys.role("wl4"), "acceptWhitelistRecovery");
    await ctx.viaTimelock("bsc", "unfreezeWhitelist", []);
    ctx.check("E7", "白名单钱包被盗处置完成：否决交接、恢复到新 WL（两链）、经时间锁解冻", (await ctx.view<Address>("bsc", "whitelistManager")) === keys.role("wl4").address && (await ctx.view<Address>("wantos", "whitelistManager")) === keys.role("wl4").address && !(await ctx.view<boolean>("bsc", "whitelistFrozen")));
    ctx.state.current.wl = "wl4";
    ctx.save();
  }

  // ---------------------------------------------------------------- E9 admin backend tampered (offline check catches it)
  {
    const shown = [keys.user(67).address, keys.user(68).address];
    const actual = [keys.user(67).address, keys.role("attacker").address];
    const nonce = await ctx.view<bigint>("bsc", "whitelistNonce");
    const deadline = BigInt(ctx.clockSec + 300);
    const offline = computeBatches(shown.join("\n"), { allowed: true, contract: d.proxy, deadline, bscNonce: nonce, wantosNonce: nonce, bscChainId: ctx.chains.bsc.chainId, wantosChainId: ctx.chains.wantos.chainId });
    const device = hashTypedData({ domain: { name: "BscVaultV2", version: "1", chainId: ctx.chains.bsc.chainId, verifyingContract: d.proxy }, types: BATCH_TYPES, primaryType: "WhitelistBatch", message: { listHash: listHashOf(sortAddrs(actual)), count: 2, allowed: true, nonce, deadline } });
    const calldata = encodeFunctionData({ abi: abiOf("bsc"), functionName: "applyWhitelistBatch", args: [sortAddrs(actual), true, nonce, deadline, "0x"] });
    const decoded = decodeCalldata(calldata);
    ctx.check("E9", "后台被篡改：离线工具算出的 digest 与设备显示不符 → 负责人不签；解码 calldata 暴露真实地址", offline.batches[0]!.bsc.digest!.toLowerCase() !== device.toLowerCase() && JSON.stringify(decoded).toLowerCase().includes(keys.role("attacker").address.slice(2).toLowerCase()));
  }

  // ---------------------------------------------------------------- E11 WANTOS-USDT minted (alert only) and supply ceiling
  {
    const from = w.sink.alerts.length;
    const ceiling = await ctx.view<bigint>("wantos", "supplyCeiling");
    const supply = await ctx.chains.wantos.read<bigint>(d.token.wantos, tokenAbi, "totalSupply");
    await ctx.chains.wantos.write(keys.role("funder"), d.token.wantos, tokenAbi, "mint", [keys.role("funder").address, ceiling - supply + tok(20_000)]);
    await pump(ctx, { r, w }, 2);
    const codes = newCodes(w, from);
    const blocked = await ctx.reverts("wantos", keys.user(14), "bridgeOut", [tok(20)]);
    ctx.check("E11-a", "增发只告警（MINT / MINT_EXCESS）不暂停；超过 supplyCeiling 后 bridgeOut 被拒", (codes.includes("MINT") || codes.includes("MINT_EXCESS")) && !(await paused(ctx, "wantos")) && /SupplyCeilingExceeded|ERC20InsufficientAllowance/.test(blocked), blocked);
    await ctx.viaTimelock("wantos", "setSupplyCeiling", [ceiling + tok(40_000)]);
    await ctx.chains.wantos.write(keys.user(14), d.token.wantos, tokenAbi, "approve", [d.proxy, tok(20)]);
    ctx.check("E11-b", "经时间锁提高上限后恢复", (await ctx.reverts("wantos", keys.user(14), "bridgeOut", [tok(20)])) === "");
    await ctx.chains.wantos.write(keys.user(14), d.token.wantos, tokenAbi, "approve", [d.proxy, 0n]);
  }
  ctx.note("E8（两个钱包同时被盗）为桌面推演：损失上限 = 整个储备；两个钱包须分设备、分地点保管——不在链上演示");
  void keccak256;
  void toBytes;
  await r.db.close();
}

export type { Account };
