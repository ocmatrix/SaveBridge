import { encodeFunctionData, keccak256, toBytes, zeroAddress, type Address, type Hex } from "viem";
import { PauseGuardError, PauseOnlySigner, pauseCall } from "@bridge/watcher/src/pauser";
import { viemRawTxSender } from "@bridge/watcher/src/wiring";
import { tokenAbi } from "../chain";
import { TL_ABI, abiOf, tok, type Ctx } from "../ctx";
import type { Side } from "../guard";
import { applyBoth, batchReverts, offlineCheckMatches, signBatch, sortAddrs } from "../whitelist";

const SIDES: Side[] = ["bsc", "wantos"];

/** Both chains run the same drill in parallel; each `sync()` waits until every side reached it (no early warp). */
export function barrier(n: number): () => Promise<void> {
  let round = 0;
  let waiting: Array<() => void> = [];
  const counts = new Map<number, number>();
  return () => {
    const r = round;
    counts.set(r, (counts.get(r) ?? 0) + 1);
    if (counts.get(r) === n) {
      round++;
      const w = waiting;
      waiting = [];
      w.forEach((f) => f());
      return Promise.resolve();
    }
    return new Promise<void>((res) => waiting.push(res));
  };
}
export const RELAYER_ROLE = keccak256(toBytes("RELAYER_ROLE"));
export const PAUSER_ROLE = keccak256(toBytes("PAUSER_ROLE"));

// ------------------------------------------------------------------ stage: fund (A5 reserves + test balances)
export async function stageFund(ctx: Ctx): Promise<void> {
  const { chains, keys, cfg } = ctx;
  const d = ctx.d;
  const funder = keys.role("funder");
  await chains.bsc.write(funder, d.token.bsc, tokenAbi, "mint", [funder.address, tok(cfg.reserves.bsc + 20_000)]);
  for (const s of SIDES) {
    await chains[s].write(funder, d.token[s], tokenAbi, "approve", [d.proxy, tok(cfg.reserves[s])]);
    await ctx.call(s, funder, "fund", [tok(cfg.reserves[s])]);
    ctx.check(`F-${s}`, `${s} 储备注资 ${cfg.reserves[s]}（fund，精确授权）`, (await ctx.tokenBalance(s, d.proxy)) === tok(cfg.reserves[s]));
  }
  // BSC-side test USDT for depositors (B2W) and the users who will need it
  await chains.bsc.sendMany(funder, keys.users(1, 100).map((u) => ({ to: d.token.bsc, data: encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [u.address, tok(2_000)] }) })));
  ctx.check("F-users", "测试用户 U1…U100 两链均持有测试 USDT", (await ctx.tokenBalance("bsc", keys.user(100).address)) === tok(2_000));
}

// ------------------------------------------------------------------ stage: roles (§4 R3–R12)
export async function stageRoles(ctx: Ctx): Promise<void> {
  const { keys, d } = { keys: ctx.keys, d: ctx.d };

  // R3 whitelist batches (2 batches, U1..U60), offline-check gate, add order BSC → WANTON
  const b1 = keys.users(1, 30).map((u) => u.address);
  const b2 = keys.users(31, 60).map((u) => u.address);
  const r1 = await applyBoth(ctx, b1, true);
  const r2 = await applyBoth(ctx, b2, true);
  const allOk = await Promise.all([...b1, ...b2].flatMap((a) => SIDES.map((s) => ctx.view<boolean>(s, "whitelisted", [a]))));
  ctx.check("R3", "白名单两批（U1…U60）经离线核对后写入，两链一致（先 BSC 后 WANTON）", allOk.every(Boolean), `listHash ${r1.listHash.slice(0, 10)}…/${r2.listHash.slice(0, 10)}…`);
  const neg = await Promise.all(keys.users(61, 80).map((u) => ctx.view<boolean>("wantos", "whitelisted", [u.address])));
  ctx.check("R3b", "U61…U80 未开通（负面用例）", neg.every((x) => !x));

  // R4 attack surface
  const x = [keys.user(61).address];
  const tampered = [...x, keys.user(62).address];
  const nonceB = await ctx.view<bigint>("bsc", "whitelistNonce");
  const now = await ctx.syncClock();
  const oc = await offlineCheckMatches(ctx, x, true, { bsc: nonceB, wantos: await ctx.view<bigint>("wantos", "whitelistNonce") }, BigInt(now + 300));
  const good = await signBatch(ctx, "bsc", x, true);
  const tamperedSubmit = await ctx.reverts("bsc", keys.role("submitter"), "applyWhitelistBatch", [sortAddrs(tampered), true, good.nonce, good.deadline, good.signature]);
  ctx.check("R4a", "篡改页面：提交的地址表与签名不符 → InvalidSigner（离线核对对原表给出的 hash 与设备签名一致）", oc.ok && tamperedSubmit === "InvalidSigner", tamperedSubmit);
  const expired = await signBatch(ctx, "bsc", x, true, { deadline: BigInt(now - 1) });
  ctx.check("R4b", "过期批次被拒", (await batchReverts(ctx, expired)) === "SignatureExpired");
  const far = await signBatch(ctx, "bsc", x, true, { deadline: BigInt(now + 3600) });
  ctx.check("R4c", "deadline 超过 MAX_SIGNATURE_TTL（快速版 10 分钟）被拒", (await batchReverts(ctx, far)) === "DeadlineTooFar");
  const cross = await signBatch(ctx, "bsc", x, true, { nonce: await ctx.view<bigint>("wantos", "whitelistNonce") });
  ctx.check("R4d", "跨链批次（BSC 签名拿到 WANTON 提交）被拒", (await batchReverts(ctx, cross, "wantos")) === "InvalidSigner");
  const notWl = await signBatch(ctx, "bsc", x, true, { signer: keys.role("attacker") });
  ctx.check("R4e", "非白名单钱包签名被拒", (await batchReverts(ctx, notWl)) === "InvalidSigner");
  const replayOf = await signBatch(ctx, "bsc", [keys.user(1).address], true, { nonce: nonceB - 1n });
  ctx.check("R4f", "重放（旧 nonce）被拒", (await batchReverts(ctx, replayOf)) === "BadNonce");
  const pre = await signBatch(ctx, "bsc", x, true);
  await ctx.call("bsc", ctx.acct("wl"), "invalidateWhitelistNonce");
  ctx.check("R4g", "invalidateWhitelistNonce 作废已签未提交批次", (await batchReverts(ctx, pre)) === "BadNonce");
  await ctx.call("wantos", ctx.acct("wl"), "invalidateWhitelistNonce"); // keep both chains' nonces aligned

  // R5 admin handover via timelock: transferAdmin → MIN_DELAY → acceptAdmin (both chains)
  await Promise.all(
    ((sync) => SIDES.map(async (s) => {
    const admin2 = keys.role("admin2");
    const data = encodeFunctionData({ abi: TL_ABI, functionName: "transferAdmin", args: [admin2.address] });
    const p = await ctx.propose(s, d.timelock, data);
    const early = await ctx.executeReverts(s, d.timelock, data, p.salt);
    await sync();
    await ctx.waitUntil(p.readyAt, "R5 timelock");
    await ctx.executeProposal(s, d.timelock, data, p.salt);
    await ctx.chains[s].write(admin2, d.timelock, TL_ABI, "acceptAdmin");
    const stale = await ctx.chains[s].simulateRevert(keys.role("admin"), d.timelock, TL_ABI, "cancel", [p.id]);
    const adm = await ctx.view<Address>(s, "adminWallet");
    ctx.check(`R5-${s}`, `${s} 管理钱包交接：时间锁到期前不可执行；到期后新地址 acceptAdmin；旧地址 cancel 被拒`, early !== "" && adm === admin2.address && stale !== "", `early=${early} stale=${stale}`);
  }))(barrier(SIDES.length)),
  );
  ctx.state.current.admin = "admin2";
  ctx.save();

  // R6 whitelist-wallet handover with veto, then completion
  await Promise.all(
    ((sync) => SIDES.map(async (s) => {
    const wl2 = keys.role("wl2");
    await ctx.call(s, ctx.acct("wl"), "beginWhitelistManagerTransfer", [wl2.address]);
    await ctx.call(s, ctx.acct("admin"), "cancelWhitelistManagerTransfer"); // admin veto
    const vetoed = await ctx.reverts(s, wl2, "acceptWhitelistManagerTransfer");
    await ctx.call(s, ctx.acct("wl"), "beginWhitelistManagerTransfer", [wl2.address]);
    const [, availableAt] = await ctx.view<[Address, bigint, bigint]>(s, "pendingWhitelistManager");
    const tooEarly = await ctx.reverts(s, wl2, "acceptWhitelistManagerTransfer");
    await sync();
    await ctx.waitUntil(Number(availableAt), "R6 WL_TRANSFER_DELAY");
    await ctx.call(s, wl2, "acceptWhitelistManagerTransfer");
    const oldWlBatch = await ctx.reverts(s, keys.role("wl"), "invalidateWhitelistNonce");
    ctx.check(`R6-${s}`, `${s} 白名单钱包交接：管理钱包否决生效；再次发起到期后接收；旧地址失效`, vetoed !== "" && tooEarly === "NotReady" && (await ctx.view<Address>(s, "whitelistManager")) === wl2.address && oldWlBatch !== "", `veto=${vetoed}`);
  }))(barrier(SIDES.length)),
  );
  ctx.state.current.wl = "wl2";
  ctx.save();

  // R7 whitelist-wallet recovery: current WL cancels → cooldown → restart → writes blocked → completes
  await Promise.all(
    ((sync) => SIDES.map(async (s) => {
    const wl3 = keys.role("wl3");
    await ctx.call(s, ctx.acct("admin"), "startWhitelistRecovery", [wl3.address]);
    await ctx.call(s, ctx.acct("wl"), "cancelWhitelistRecovery");
    const cool = await ctx.reverts(s, ctx.acct("admin"), "startWhitelistRecovery", [wl3.address]);
    const [, , , cooldownUntil] = await ctx.view<[boolean, Address, bigint, bigint]>(s, "whitelistRecovery");
    await sync();
    await ctx.waitUntil(Number(cooldownUntil), "R7 cooldown");
    await ctx.call(s, ctx.acct("admin"), "startWhitelistRecovery", [wl3.address]);
    const blocked = await batchReverts(ctx, await signBatch(ctx, s, [keys.user(63).address], true));
    const [, , readyAt] = await ctx.view<[boolean, Address, bigint, bigint]>(s, "whitelistRecovery");
    await sync();
    await ctx.waitUntil(Number(readyAt), "R7 WL_RECOVERY_DELAY");
    await ctx.call(s, wl3, "acceptWhitelistRecovery");
    ctx.check(`R7-${s}`, `${s} 白名单钱包恢复：现任取消 → 冷却期内不得再启动 → 恢复期间白名单禁写 → 到期接收`, cool === "RecoveryCooldown" && blocked === "WhitelistWritesBlocked" && (await ctx.view<Address>(s, "whitelistManager")) === wl3.address, `cool=${cool} blocked=${blocked}`);
  }))(barrier(SIDES.length)),
  );
  ctx.state.current.wl = "wl3";
  ctx.save();

  // R8 admin-wallet recovery by the WL: old proposals die with the epoch bump
  await Promise.all(
    ((sync) => SIDES.map(async (s) => {
    const admin3 = keys.role("admin3");
    const data = encodeFunctionData({ abi: abiOf(s), functionName: "withdraw", args: [keys.role("attacker").address, 1n] });
    const old = await ctx.propose(s, d.proxy, data);
    await ctx.chains[s].write(ctx.acct("wl"), d.timelock, TL_ABI, "startAdminRecovery", [admin3.address]);
    await sync();
    await ctx.waitUntil(old.readyAt, "R8 old proposal ready");
    const during = await ctx.executeReverts(s, d.proxy, data, old.salt);
    const readyAt = Number(await ctx.chains[s].read<bigint>(d.timelock, TL_ABI, "adminRecoveryReadyAt"));
    await sync();
    await ctx.waitUntil(readyAt, "R8 ADMIN_RECOVERY_DELAY");
    const epoch0 = await ctx.chains[s].read<bigint>(d.timelock, TL_ABI, "epoch");
    await ctx.chains[s].write(admin3, d.timelock, TL_ABI, "acceptAdmin");
    const after = await ctx.executeReverts(s, d.proxy, data, old.salt);
    const epoch1 = await ctx.chains[s].read<bigint>(d.timelock, TL_ABI, "epoch");
    ctx.check(`R8-${s}`, `${s} 管理钱包恢复：恢复期间 A 类执行被拒；到期接收；epoch+1 后旧提议作废`, during !== "" && after !== "" && epoch1 === epoch0 + 1n && (await ctx.view<Address>(s, "adminWallet")) === admin3.address, `during=${during} after=${after}`);
  }))(barrier(SIDES.length)),
  );
  ctx.state.current.admin = "admin3";
  ctx.save();

  // R10 pause key can only pause; both wallets can unpause (decision 17)
  await Promise.all(
    ((sync) => SIDES.map(async (s) => {
    const pk = ctx.acct("pauser");
    const signer = new PauseOnlySigner(viemRawTxSender(ctx.chains[s].wallet(pk), pk), [d.proxy]);
    let guard = "";
    for (const bad of [pauseCall(d.token[s]), { to: d.proxy, data: "0x3f4ba83a" } as unknown as ReturnType<typeof pauseCall>]) {
      try {
        await signer.sendPause(bad); // wrong target / unpause() calldata smuggled through a cast
        guard = "sent!";
      } catch (e) {
        if (!(e instanceof PauseGuardError)) guard = String(e);
        else if (guard === "") guard = "PauseGuardError";
      }
    }
    const nonceBefore = await ctx.chains[s].pub.getTransactionCount({ address: pk.address });
    const unpauseByPauser = await ctx.reverts(s, pk, "unpause");
    const tx = await signer.sendPause(pauseCall(d.proxy));
    await ctx.chains[s].pub.waitForTransactionReceipt({ hash: tx });
    const paused1 = await ctx.view<boolean>(s, "paused");
    await ctx.call(s, ctx.acct("admin"), "unpause");
    await signer.sendPause(pauseCall(d.proxy)).then((h) => ctx.chains[s].pub.waitForTransactionReceipt({ hash: h }));
    await ctx.call(s, ctx.acct("wl"), "unpause");
    ctx.check(`R10-${s}`, `${s} 暂停钥匙：非 pause 调用被 PauseOnlySigner 拦下（nonce 不变）、不能 unpause；两个钱包各解除一次`, guard === "PauseGuardError" && unpauseByPauser !== "" && paused1 && !(await ctx.view<boolean>(s, "paused")) && nonceBefore === (await ctx.chains[s].pub.getTransactionCount({ address: pk.address })) - 2, `guard=${guard}`);
  }))(barrier(SIDES.length)),
  );

  // R11 key mutual exclusion: granting an existing key's address another role fails at execution
  await Promise.all(
    ((sync) => SIDES.map(async (s) => {
    const data = encodeFunctionData({ abi: abiOf(s), functionName: "grantRole", args: [RELAYER_ROLE, ctx.acct("pauser").address] });
    const p = await ctx.propose(s, d.proxy, data);
    await sync();
    await ctx.waitUntil(p.readyAt, "R11");
    const r = await ctx.executeReverts(s, d.proxy, data, p.salt);
    ctx.check(`R11-${s}`, `${s} 钥匙互斥：把暂停钥匙地址授予付款角色 → 执行被拒`, r !== "", r);
  }))(barrier(SIDES.length)),
  );

  // R12 revoke (immediate) and re-grant (timelock) of the pause key
  await Promise.all(
    ((sync) => SIDES.map(async (s) => {
    const old = ctx.acct("pauser");
    const pauser2 = keys.role("pauser2");
    await ctx.call(s, ctx.acct("admin"), "revokeKey", [PAUSER_ROLE, old.address]);
    const revoked = await ctx.reverts(s, old, "pause");
    const data = encodeFunctionData({ abi: abiOf(s), functionName: "grantRole", args: [PAUSER_ROLE, pauser2.address] });
    const p = await ctx.propose(s, d.proxy, data);
    const early = await ctx.executeReverts(s, d.proxy, data, p.salt);
    await sync();
    await ctx.waitUntil(p.readyAt, "R12 grant");
    await ctx.executeProposal(s, d.proxy, data, p.salt);
    ctx.check(`R12-${s}`, `${s} 吊销立即生效；补发须满时间锁后才可执行`, revoked !== "" && early !== "" && (await ctx.view<boolean>(s, "hasRole", [PAUSER_ROLE, pauser2.address])), `revoked=${revoked} early=${early}`);
  }))(barrier(SIDES.length)),
  );
  ctx.state.current.pauser = "pauser2";
  ctx.save();
  ctx.note("R1/R2（硬件钱包签名与 EIP-712 显示）、R9（KMS）只能在真实设备上做：本地用测试钥匙代替，测试网上由负责人本人操作");
  void zeroAddress;
}
