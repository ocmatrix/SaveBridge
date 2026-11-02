import type { Account } from "viem";
import { OrderRepo } from "@bridge/relayer/src/orders";
import { tokenAbi } from "../chain";
import { tok, type Ctx } from "../ctx";
import { b2wKey, bridgeOut, chainView, decide, deposit, pct, reconcileOne, w2bKey, type Tracked } from "../flows";
import { pump, startRelayer, startWatcher, type RelayerSys, type WatcherSys } from "../services";
import { signBatch, submitBatch } from "../whitelist";

/** §6: two directions, 100 orders (40 small / 15 large / 25 B2W / 5 quota / 5 review / 5 refund / 5 negative). */
export async function stageE2E(ctx: Ctx): Promise<void> {
  const { keys, cfg } = ctx;
  const r = await startRelayer(ctx);
  const w = await startWatcher(ctx);
  const repo = new OrderRepo(r.db, () => new Date(ctx.clockSec * 1000));
  await pump(ctx, { r, w });
  const tracked: Tracked[] = [];
  const now = () => ctx.clockSec;
  const t0Alerts = w.sink.alerts.length;
  const add = (t: Omit<Tracked, "sentAt">) => tracked.push({ ...t, sentAt: Date.now() });

  // ---- 5 negative cases: the chain must refuse them (simulated: nothing broadcast; approvals are exact)
  const approve = async (side: "bsc" | "wantos", u: Account, amount: bigint) => ctx.chains[side].write(u, ctx.d.token[side], tokenAbi, "approve", [ctx.d.proxy, amount]);
  const minW = tok(cfg.params.wantos.w2bMinAmount) - 1n;
  const minD = tok(cfg.params.bsc.minDeposit) - 1n;
  const maxD = tok(cfg.params.bsc.maxDepositPerTx) + 1n;
  await approve("wantos", keys.user(1), minW);
  const n3 = await ctx.reverts("wantos", keys.user(1), "bridgeOut", [minW]);
  await approve("wantos", keys.user(1), 0n);
  await approve("bsc", keys.user(81), minD);
  const n4 = await ctx.reverts("bsc", keys.user(81), "deposit", [minD, keys.user(81).address]);
  await approve("bsc", keys.user(81), maxD);
  const n5 = await ctx.reverts("bsc", keys.user(81), "deposit", [maxD, keys.user(81).address]);
  await approve("bsc", keys.user(81), 0n);
  const neg = [
    ["N1 非白名单 bridgeOut", await ctx.reverts("wantos", keys.user(61), "bridgeOut", [tok(20)]), "NotWhitelisted"],
    ["N2 合约地址调用 bridgeOut（未开通即拒；开通后另有 ContractCaller）", await ctx.reverts("wantos", ctx.d.token.wantos, "bridgeOut", [tok(20)]), "NotWhitelisted"],
    ["N3 低于 w2bMinAmount", n3, "AmountBelowMinimum"],
    ["N4 存入低于 minDeposit", n4, "AmountBelowMinimum"],
    ["N5 存入超过 maxDepositPerTx", n5, "AmountAboveLimit"],
  ] as const;
  for (const [title, why, want] of neg) ctx.check(`E2E-${title.slice(0, 2)}`, `负面用例 ${title.slice(3)} 被链上拒绝（${want}）`, why === want, why);

  // ---- submit concurrently (one tx stream per user)
  const small = keys.users(1, cfg.e2e.smallW2B);
  const large = keys.users(41, 40 + cfg.e2e.largeW2B);
  const amtSmall = (i: number) => tok(20 + (i % 8) * 10);
  const amtLarge = (i: number) => tok(cfg.params.bsc.largeThreshold + 10 + (i % 5) * 20);
  const w2b = async (kind: string, u: Account, amount: bigint, expect: Tracked["expect"]) => {
    const id = await bridgeOut(ctx, u, amount);
    add({ kind, dir: "W2B", nonce: id, key: w2bKey(ctx, id), user: u.address, to: u.address, amount, expect });
    return id;
  };
  await Promise.all([
    ...small.map((u, i) => w2b("small", u, amtSmall(i), "RELEASED")),
    ...large.map((u, i) => w2b(i >= large.length - 2 ? "large-cancel" : "large", u, amtLarge(i), i >= large.length - 2 ? "REFUNDED" : "RELEASED")),
  ]);
  // review: 3 × amount_limit (> perAddrDailyCap) → reject; 2 × whitelist_removed → approve one, reject one
  for (const u of keys.users(56, 58)) await w2b("review-amount", u, tok(cfg.params.bsc.perAddrDailyCap + 50), "REFUNDED");
  await w2b("review-wlremoved-approve", keys.user(59), tok(50), "RELEASED");
  await w2b("review-wlremoved-reject", keys.user(60), tok(50), "REFUNDED");
  // removal goes WANTON first; only WANTON here, so U59/U60 are "removed while in flight" (BSC still allows U59's payout)
  await submitBatch(ctx, await signBatch(ctx, "wantos", [keys.user(59).address, keys.user(60).address], false));
  // refund: 4 W2B voided on BSC by the admin before the relayer pays → REJECTED → refund on WANTON
  const refundIds: bigint[] = [];
  for (const u of keys.users(36, 39)) refundIds.push(await w2b("refund-w2b", u, tok(20), "REFUNDED"));
  for (const id of refundIds) await ctx.call("bsc", ctx.acct("admin"), "voidSource", [id]);
  // B2W: 25 deposits; recipients are NOT whitelisted (B2W has no whitelist reason)
  const depositors = [...keys.users(81, 100), ...keys.users(76, 80)].slice(0, cfg.e2e.b2w);
  await Promise.all(
    depositors.map(async (u, i) => {
      const to = keys.user(61 + (i % 20)).address;
      const amount = tok(30 + (i % 5) * 10);
      const n = await deposit(ctx, u, amount, to);
      add({ kind: "b2w", dir: "B2W", nonce: n, key: b2wKey(ctx, n), user: u.address, to, amount, expect: "RELEASED" });
    }),
  );
  // refund: 1 B2W deposit voided on WANTON → requestDepositRefund on BSC
  const dn = await deposit(ctx, keys.user(75), tok(40), keys.user(75).address);
  add({ kind: "refund-b2w", dir: "B2W", nonce: dn, key: b2wKey(ctx, dn), user: keys.user(75).address, to: keys.user(75).address, amount: tok(40), expect: "REFUNDED" });
  await ctx.call("wantos", ctx.acct("admin"), "voidSource", [dn]);
  // quota: 5 second orders by large-order users push them over perAddrDailyCap → WAITING(quota) → next UTC day
  for (const u of keys.users(41, 40 + cfg.e2e.quota)) await w2b("quota", u, amtLarge(0), "RELEASED");
  const real = tracked.length + neg.length;
  ctx.check("E2E-sent", `已发出 ${tracked.length} 笔真实订单 + ${neg.length} 笔负面用例 = ${real}`, real === 100, `W2B ${tracked.filter((t) => t.dir === "W2B").length} / B2W ${tracked.filter((t) => t.dir === "B2W").length}`);

  // ---- drive to terminal states, acting like the owner where the plan needs a human
  const decided = new Set<string>();
  const cancelled = new Set<string>();
  const refundRequested = new Set<string>();
  let rounds = 0;
  let crossedDay = false;
  const done = async () => {
    let n = 0;
    for (const t of tracked) {
      const o = await repo.get(t.key);
      if (o && (o.status === "RELEASED" || o.status === "REFUNDED")) {
        n++;
        t.doneAt ??= Date.now();
      }
    }
    return n;
  };
  while ((await done()) < tracked.length && rounds < 400) {
    rounds++;
    await pump(ctx, { r, w });
    for (const t of tracked) {
      const o = await repo.get(t.key);
      if (!o) continue;
      const k = t.key;
      if (o.status === "REVIEW" && !decided.has(k)) {
        decided.add(k);
        await decide(ctx, r, o, t.kind === "review-wlremoved-approve" ? "approve" : "reject");
        if (t.kind !== "review-wlremoved-approve") await ctx.call("bsc", ctx.acct("admin"), "voidSource", [t.nonce]);
      }
      if (t.kind === "large-cancel" && o.status === "QUEUED" && !cancelled.has(k)) {
        cancelled.add(k);
        await ctx.call("bsc", ctx.acct("wl"), "cancelRelease", [t.nonce]); // WL cancels a queued large payout
      }
      if (o.status === "REFUNDING" && !refundRequested.has(k)) {
        refundRequested.add(k);
        if (t.dir === "W2B") await ctx.call("wantos", ctx.acct("admin"), "requestRefund", [t.nonce]);
        else await ctx.call("bsc", ctx.acct("admin"), "requestDepositRefund", [t.nonce]);
      }
    }
    // refunds that are due: anyone executes
    for (const t of tracked) {
      if (!refundRequested.has(t.key)) continue;
      const fn = t.dir === "W2B" ? "executeRefund" : "executeDepositRefund";
      const side = t.dir === "W2B" ? "wantos" : "bsc";
      const v = await chainView(ctx, t);
      if ((t.dir === "W2B" ? v.wantosOrder : v.bscDeposit) === (t.dir === "W2B" ? 2 : 1) && (await ctx.reverts(side, keys.role("submitter"), fn, [t.nonce])) === "")
        await ctx.call(side, keys.role("submitter"), fn, [t.nonce]);
    }
    const open = await repo.listActive();
    const waitingQuota = open.filter((o) => o.status === "WAITING" && o.reason === "quota");
    const onlyQuotaLeft = open.length > 0 && open.every((o) => o.status === "WAITING" && o.reason === "quota");
    if (onlyQuotaLeft && !crossedDay) {
      ctx.check("E2E-quota-wait", `撞单地址额度的 ${waitingQuota.length} 笔进入 WAITING(quota)`, waitingQuota.length === cfg.e2e.quota);
      if (cfg.waitMode === "warp") {
        const day = Math.floor(now() / 86400);
        await ctx.waitUntil((day + 1) * 86400 + 5, "next UTC day (quota reset)");
        crossedDay = true;
      } else {
        ctx.note(`真实测试网：${waitingQuota.length} 笔 WAITING(quota) 需等到下一个 UTC 日自动放行（不占 2 小时主线，见 RUNBOOK 背景项）`);
        break;
      }
    }
    // keep time moving for queued payouts / refund waits / b2w delay
    if (cfg.waitMode === "warp" && rounds % 3 === 0) await ctx.advance(30, "queue / refund waits");
  }
  ctx.check("E2E-rounds", `收敛（${rounds} 轮 relayer+watcher tick）`, rounds < 400);

  // ---- §6.3 judgments
  const fails: string[] = [];
  const latency: number[] = [];
  let deferred = 0;
  for (const t of tracked) {
    const o = await repo.get(t.key);
    if (cfg.waitMode === "real" && t.kind === "quota" && o?.status === "WAITING") {
      deferred++;
      continue;
    }
    const e = reconcileOne(t, await chainView(ctx, t), o?.status);
    if (e) fails.push(`${t.kind}#${t.nonce}: ${e}`);
    if (t.doneAt) latency.push(t.doneAt - t.sentAt);
  }
  ctx.check("E2E-final", `全部订单达终态且逐笔三处一致（源链 / 付款链 / DB=用户页数据源）${deferred ? `，${deferred} 笔待次日` : ""}`, fails.length === 0, fails.slice(0, 5).join("; "));
  const active = (await repo.listActive()).filter((o) => !(cfg.waitMode === "real" && o.status === "WAITING" && o.reason === "quota"));
  ctx.check("E2E-nofail", "无遗留 FAILED / WAITING", active.length === 0, active.map((o) => `${o.status}/${o.reason}`).join(","));
  const pauses = await Promise.all((["bsc", "wantos"] as const).map((s) => ctx.view<boolean>(s, "paused")));
  const lvl1 = w.sink.alerts.slice(t0Alerts).filter((a) => a.level === 1);
  ctx.check("E2E-nopause", "监控零误暂停、零一级告警", pauses.every((p) => !p) && lvl1.length === 0, lvl1.map((a) => a.code).join(","));
  const shortfall = w.sink.alerts.slice(t0Alerts).filter((a) => a.code === "RECONCILE_SHORTFALL");
  ctx.check("E2E-reconcile", "余额对账全程无 RECONCILE_SHORTFALL", shortfall.length === 0);
  const allowances = await Promise.all(tracked.filter((t) => t.dir === "W2B").slice(0, 10).map((t) => ctx.chains.wantos.read<bigint>(ctx.d.token.wantos, tokenAllowanceAbi as never, "allowance", [t.user, ctx.d.proxy])));
  ctx.check("E2E-approve", "授权用精确金额（bridgeOut 后剩余授权为 0，无 MaxUint256）", allowances.every((a) => a === 0n));
  ctx.note(`订单完成耗时（墙钟，含本地出块/快进）p50 ${(pct(latency, 50) / 1000).toFixed(1)} s / p95 ${(pct(latency, 95) / 1000).toFixed(1)} s`);
  ctx.state.data.e2e = { orders: tracked.map((t) => ({ kind: t.kind, dir: t.dir, nonce: t.nonce.toString(), key: t.key })) };
  ctx.save();
  await stopServices(r, w);
}

const tokenAllowanceAbi = [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }] as const;

export async function stopServices(r: RelayerSys | null, _w: WatcherSys | null): Promise<void> {
  if (r) await r.db.close();
}
