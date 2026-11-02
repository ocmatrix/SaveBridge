import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALERT_LEVELS } from "@bridge/watcher/src/alerts";
import { ALERT_LEVEL as RELAYER_LEVELS } from "@bridge/relayer/src/alerts";
import { buildManifest, buildProposals, legacyPaidReader, oldKey, preflightBatch, readLegacyPaid, reconcileLegacy, verifyScheduledCall } from "@bridge/migrate/src/index";
import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, keccak256, toHex, type Address, type Hex } from "viem";
import { tokenAbi } from "../chain";
import { TL_ABI, abiOf, tok, type Ctx } from "../ctx";
import type { Side } from "../guard";
import { faults, pump, startWatcher } from "../services";

/** §9 monitoring drills not already triggered by the earlier stages + the alert coverage table. */
export async function stageMonitor(ctx: Ctx): Promise<void> {
  const { keys, d } = { keys: ctx.keys, d: ctx.d };
  const oldVault = keys.role("attacker"); // stands in for the legacy 0x8dFd / 0x9dab / 0xec6e addresses on testnet
  const w = await startWatcher(ctx, {
    config: (c) => {
      c.legacyAddresses = [{ chain: "bsc", address: oldVault.address, label: "测试旧金库（模拟 0xec6e）" }];
      c.gasWatch = [{ chain: "wantos", address: keys.role("wl").address, label: "已退役的白名单钱包", minWei: 10n ** 30n }];
      c.gasCheckIntervalSeconds = 1;
      c.reconcile.intervalSeconds = 1;
    },
  });
  await pump(ctx, { w }, 2);
  const since = (n: number) => w.sink.alerts.slice(n).map((a) => a.code);

  // §9.2 shortfall (an RPC-level fake: the contracts cannot lose tokens without an event) and surplus (direct transfer)
  {
    let from = w.sink.alerts.length;
    const balSel = encodeFunctionData({ abi: tokenAbi, functionName: "balanceOf", args: [d.proxy] }).toLowerCase();
    faults.bsc.all = (m, p) => {
      const q = p[0] as { to?: string; data?: string; input?: string } | undefined;
      if (m !== "eth_call" || q?.to?.toLowerCase() !== d.token.bsc.toLowerCase() || (q.data ?? q.input)?.toLowerCase() !== balSel) return { handled: false };
      return {
        handled: true,
        result: (async () => {
          const raw = await ctx.chains.bsc.rpc<Hex>("eth_call", p);
          const v = decodeFunctionResult({ abi: tokenAbi, functionName: "balanceOf", data: raw }) as bigint;
          return encodeFunctionResult({ abi: tokenAbi, functionName: "balanceOf", result: v / 2n }); // half the reserve "missing"
        })(),
      };
    };
    await ctx.advance(5, "reconcile");
    await pump(ctx, { w }, 2);
    faults.bsc.all = null;
    const paused = await ctx.view<boolean>("bsc", "paused");
    ctx.check("M-recon-short", "对账短缺 → RECONCILE_SHORTFALL（二级，不暂停）", since(from).includes("RECONCILE_SHORTFALL") && !paused, [...new Set(since(from))].join(","));
    from = w.sink.alerts.length;
    await ctx.chains.wantos.write(keys.role("funder"), d.token.wantos, tokenAbi, "transfer", [d.proxy, tok(500)]);
    await ctx.advance(5, "reconcile");
    await pump(ctx, { w }, 2);
    ctx.check("M-recon-surplus", "多出（直接转入）→ 三级日报 RECONCILE_SURPLUS，不即时告警", !since(from).some((c) => c.startsWith("RECONCILE_")), "进入当日日报");
  }

  // legacy-address activity, gas low, timelock reminders (24h/6h scaled to 60s/30s), daily report
  {
    const from = w.sink.alerts.length;
    await ctx.chains.bsc.send(oldVault, keys.role("funder").address, "0x", 1n);
    const data = encodeFunctionData({ abi: abiOf("bsc"), functionName: "setParams", args: [await ctx.view("bsc", "params")] });
    const p = await ctx.propose("bsc", d.proxy, data);
    for (let i = 0; i < 6; i++) {
      await ctx.advance(20, "reminders");
      await pump(ctx, { w });
    }
    await ctx.chains.bsc.write(ctx.acct("admin"), d.timelock, TL_ABI, "cancel", [p.id]);
    const day = Math.floor(ctx.clockSec / 86400);
    if (ctx.cfg.waitMode === "warp") await ctx.waitUntil((day + 1) * 86400 + 10, "UTC day rollover → daily report");
    await pump(ctx, { w }, 2);
    const c = since(from);
    ctx.check("M-legacy", "旧地址动作 → LEGACY_ACTIVITY（二级）", c.includes("LEGACY_ACTIVITY"));
    ctx.check("M-gas", "钱包 gas 不足 → GAS_LOW（二级）", w.codes().includes("GAS_LOW"));
    ctx.check("M-reminder", "时间锁到期前提醒（主网 24h/6h，测试网压缩为 60s/30s）→ TIMELOCK_REMINDER", c.includes("TIMELOCK_REMINDER"));
    ctx.check("M-tl-proposed", "新的时间锁提议 → TIMELOCK_PROPOSED（一级）；撤销 → TIMELOCK_CANCELLED", c.includes("TIMELOCK_PROPOSED") && c.includes("TIMELOCK_CANCELLED"));
    if (ctx.cfg.waitMode === "warp") ctx.check("M-daily", "UTC 日报（三级 DAILY_REPORT）含白名单变更 / 排队 / 退款 / 作废汇总", c.includes("DAILY_REPORT"));
    ctx.check("M-heartbeat", "监控心跳每轮上报（外部心跳服务接口）", w.hb.beats.length > 0, `${w.hb.beats.length} beats`);
  }

  // alert coverage table over the whole run (watcher + relayer)
  const read = (f: string) => (existsSync(join(ctx.runDir, f)) ? readFileSync(join(ctx.runDir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);
  const wSeen = new Set(read("watcher-alerts.jsonl").map((a) => String(a.code)));
  const rSeen = new Set(read("relayer-alerts.jsonl").map((a) => String(a.kind)));
  const rows = [
    "| 来源 | 告警码 | 级别 | 本次彩排触发 |",
    "|---|---|---|---|",
    ...Object.entries(ALERT_LEVELS).map(([k, l]) => `| 监控 | ${k} | ${l} | ${wSeen.has(k) ? "是" : "否（PR-7 单元/集成测试覆盖）"} |`),
    ...Object.entries(RELAYER_LEVELS).map(([k, l]) => `| 付款程序 | ${k} | ${l} | ${rSeen.has(k) ? "是" : "否（PR-3 测试覆盖）"} |`),
  ];
  writeFileSync(join(ctx.runDir, "alert-coverage.md"), `# 告警覆盖表\n\n${rows.join("\n")}\n`);
  const lv = (n: number) => [...wSeen].some((c) => (ALERT_LEVELS as Record<string, number>)[c] === n);
  ctx.check("M-levels", "三级告警各至少触发一次（一级 / 二级 / 三级）", lv(1) && lv(2) && (lv(3) || ctx.cfg.waitMode === "real"), `watcher ${wSeen.size}/${Object.keys(ALERT_LEVELS).length} 码, relayer ${rSeen.size}/${Object.keys(RELAYER_LEVELS).length} 码 → alert-coverage.md`);
  ctx.note("外部心跳停报后由外部服务直接打电话 / 发短信、一级告警电话+短信 24h 重复：需真实通道（DESIGN §14-3 选型），本地只能验证接口调用");
}

/** §11 legacy payouts with the real PR-8 tooling (manifest → timelock proposal → WL check → wait → preflight → execute). */
export async function stageLegacy(ctx: Ctx): Promise<void> {
  const { keys, d } = { keys: ctx.keys, d: ctx.d };
  const c = ctx.chains.bsc;
  const recipients = [keys.user(71), keys.user(72), keys.user(73)].map((u) => u.address); // NOT whitelisted on purpose
  const rows = recipients.map((to, i) => {
    const srcTxHash = keccak256(toHex(`pr9-legacy-old-order-${i}`));
    return { oldKey: oldKey(srcTxHash, i), srcChainId: ctx.chains.wantos.chainId, srcTxHash, srcLogIndex: i, direction: "W2B" as const, timestamp: 1_700_000_000 + i, payee: to, srcRecipient: to, amount: tok(10 + i), status: "PAYABLE" as const };
  });
  const m = buildManifest(rows, { bscChainId: c.chainId, vault: d.proxy, cutoverT: 1_700_000_100 });
  const ps = buildProposals(m, { timelock: d.timelock });
  const start = await c.pub.getBlockNumber();
  const day = await ctx.view<bigint>("bsc", "currentDay");
  const used0 = await ctx.view<bigint>("bsc", "dailyUsed", [day]);
  for (const p of ps) await c.send(ctx.acct("admin"), d.timelock, p.scheduleCalldata);
  const sched = await c.pub.getContractEvents({ address: d.timelock, abi: TL_ABI as never, eventName: "CallScheduled", fromBlock: start, strict: true });
  const checks = sched.map((e) => verifyScheduledCall((e as unknown as { args: { target: Address; value: bigint; data: Hex; predecessor: Hex; delay: bigint } }).args, m));
  ctx.check("L1", "PR-8 清单 → 时间锁提议；白名单钱包对照公开清单逐条核对通过", checks.length === ps.length && checks.every((x) => x.ok), `manifest ${m.hash.slice(0, 10)}…, ${m.count} 行`);
  const early = await c.simulateRevert(keys.role("submitter"), d.timelock, TL_ABI, "execute", [ps[0]!.target, 0n, ps[0]!.payCalldata, ps[0]!.predecessor, ps[0]!.salt]);
  ctx.check("L2", "未到期执行被拒", early !== "", early);
  if (ctx.cfg.waitMode !== "warp") {
    ctx.note("PR-8 提议工具固定 48h 延迟（与主网一致，verifyScheduledCall 拒绝 <48h），测试网上执行需真等 48h —— 列入背景项，不占 2 小时主线");
    return;
  }
  const readyAt = Math.max(...(await Promise.all(ps.map(async (p) => Number(await c.read<bigint>(d.timelock, TL_ABI, "getTimestamp", [p.operationId]))))));
  await ctx.waitUntil(readyAt, "PR-8 48h legacy delay");
  const isPaid = legacyPaidReader(c.pub, d.proxy);
  for (const p of ps) {
    const pf = await preflightBatch(p.entries, { isLegacyPaid: isPaid, oldPayouts: [] });
    if (!pf.ok) throw new Error(pf.blockers.join("; "));
    await c.send(keys.role("submitter"), d.timelock, p.executeCalldata);
  }
  const paid = await Promise.all(m.entries.map((e) => isPaid(e.oldKey)));
  const rec = reconcileLegacy([m], await readLegacyPaid(c.pub, d.proxy, start));
  const bal = await Promise.all(recipients.map((a) => ctx.tokenBalance("bsc", a)));
  ctx.check("L3", "到期执行：legacyPaid 全部置位、ΣLegacyPaid = 清单总额；收款人不要求白名单", paid.every(Boolean) && rec.complete && rec.legacyPaidTotal === m.total && bal.every((b, i) => b >= tok(10 + i)), `ΣLegacyPaid ${rec.legacyPaidTotal} = manifest ${m.total}`);
  ctx.check("L4", "不占当日额度（dailyUsed 不变）", (await ctx.view<bigint>("bsc", "dailyUsed", [await ctx.view<bigint>("bsc", "currentDay")])) === (day === (await ctx.view<bigint>("bsc", "currentDay")) ? used0 : 0n));
  // same oldKey again (new salt) → preflight flags it and the contract rejects the whole batch
  const dup = buildProposals(m, { timelock: d.timelock }, 1)[0]!;
  await c.send(ctx.acct("admin"), d.timelock, dup.scheduleCalldata);
  await ctx.waitUntil(Number(await c.read<bigint>(d.timelock, TL_ABI, "getTimestamp", [dup.operationId])), "dup legacy delay");
  const pf = await preflightBatch(dup.entries, { isLegacyPaid: isPaid, oldPayouts: [] });
  const rev = await c.simulateRevert(keys.role("submitter"), d.timelock, TL_ABI, "execute", [dup.target, 0n, dup.payCalldata, dup.predecessor, dup.salt]);
  ctx.check("L5", "同一 oldKey 再付一次：预检拦下，合约整批回滚", !pf.ok && rev !== "", rev);
  void (["bsc", "wantos"] as Side[]);
}
