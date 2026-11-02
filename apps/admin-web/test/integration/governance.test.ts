import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { reviewMessage as relayerReviewMessage } from "../../../../packages/relayer/src/review";
import { recoverMessageAddress } from "viem";
import { readBoth, readChainState } from "../../src/lib/state";
import { gate } from "../../src/lib/perm";
import { cancelProposal, decodeCall, executeErrorText, executeProposal, listProposals, propose } from "../../src/lib/timelock";
import { applyParams, classify, crossWarnings, planKind, readParams, setSupplyCeiling, validate } from "../../src/lib/params";
import { actions, countdown, crossChainGaps, makeProof, verifyProof } from "../../src/lib/handover";
import { emergencyRemove, keyHolders, pause, PAUSER_ROLE, RELAYER_ROLE, revokeKey, unpause, vetoWlTransfer } from "../../src/lib/emergency";
import { parseIds, requestRefundBatch, reviewMessage, signDecision, voidSourceBatch } from "../../src/lib/review";
import { readReserve } from "../../src/lib/reserves";
import { newJob, readWhitelisted, runJob, DEADLINE_AHEAD_S, prepareJob } from "../../src/lib/whitelist";
import { chainNow, timelockAbi } from "../../src/lib/chain";
import { parseAddressList } from "../../src/lib/normalize";
import { BSC_ID, U, WANTOS_ID, localSigner, startWorld, type World } from "../support/world";

let w: World;
beforeAll(async () => {
  w = await startWorld();
});
afterAll(async () => w?.stop());

const H = 3600;
const sides = ["bsc", "wantos"] as const;

describe("chain state + permission gates (contract reads only)", () => {
  it("reads roles from the contracts and gates every role", async () => {
    const st = await readChainState(w.chains.bsc);
    expect(st.admin).toBe(w.act.admin.address);
    expect(st.wl).toBe(w.act.wl.address);
    expect(st.paused).toBe(false);
    expect(st.minDelay).toBe(48n * 3600n);
    expect(gate("admin", w.act.admin.address, st).ok).toBe(true);
    expect(gate("admin", w.act.wl.address, st).reason).toContain("不是 BSC 的管理钱包");
    expect(gate("wl", w.act.admin.address, st).reason).toContain("不是 BSC 的白名单钱包");
    expect(gate("adminOrWl", w.act.stranger.address, st).ok).toBe(false);
    expect(gate("anyone", w.act.stranger.address, st).ok).toBe(true);
    expect(gate("wl", undefined, st).reason).toBe("未连接钱包");
    for (const who of ["pendingWl", "wlRecoveryCandidate", "pendingAdmin", "adminRecoveryCandidate"] as const) expect(gate(who, w.act.newHolder.address, st).ok).toBe(false);
  });
});

describe("timelock panel: propose → decode → countdown → cancel / execute", () => {
  it("loosening params creates a proposal; it decodes; WL cancels it", async () => {
    const ctx = w.chains.bsc;
    const st = await readChainState(ctx);
    const { params } = await readParams(ctx);
    const next = { ...params, dailyCap: params.dailyCap! + 1000n * U };
    expect(planKind(classify("bsc", params, next))).toBe("timelock");
    const r = await applyParams(ctx, localSigner(w, w.act.admin), st.timelock, params, next);
    expect(r.kind).toBe("timelock");
    let list = await listProposals(ctx, st.timelock);
    const p = list.find((x) => x.id === r.id)!;
    expect(p.state).toBe("waiting");
    expect(p.calls[0]!.fn).toBe("setParams");
    expect(p.calls[0]!.kind).toBe("参数调整");
    expect(p.calls[0]!.text).toContain(`dailyCap: ${next.dailyCap}`);
    expect(countdown(p.readyAt, st.now)).toMatch(/1 天 23 小时|2 天 0 小时/);
    // a stranger cannot cancel; WL can
    await expect(cancelProposal(ctx, localSigner(w, w.act.stranger), st.timelock, p.id)).rejects.toThrow(/NotCanceller/);
    await cancelProposal(ctx, localSigner(w, w.act.wl), st.timelock, p.id);
    list = await listProposals(ctx, st.timelock);
    expect(list.find((x) => x.id === r.id)!.state).toBe("cancelled");
  });

  it("execute only after 48h; then the params change", async () => {
    const ctx = w.chains.wantos;
    const st = await readChainState(ctx);
    const { params } = await readParams(ctx);
    const next = { ...params, b2wDailyCap: params.b2wDailyCap! + 500n * U };
    const r = await applyParams(ctx, localSigner(w, w.act.admin), st.timelock, params, next);
    let p = (await listProposals(ctx, st.timelock)).find((x) => x.id === r.id)!;
    await expect(executeProposal(ctx, localSigner(w, w.act.stranger), st.timelock, p)).rejects.toThrow(/TimelockUnexpectedOperationState/);
    await w.warp(48 * H + 5);
    p = (await listProposals(ctx, st.timelock)).find((x) => x.id === r.id)!;
    expect(p.state).toBe("ready");
    await executeProposal(ctx, localSigner(w, w.act.stranger), st.timelock, p); // anyone executes
    expect((await readParams(ctx)).params.b2wDailyCap).toBe(next.b2wDailyCap);
    expect((await listProposals(ctx, st.timelock)).find((x) => x.id === r.id)!.state).toBe("done");
  });

  it("tightening is one direct admin tx; a non-admin cannot; validation mirrors the contract", async () => {
    const ctx = w.chains.bsc;
    const st = await readChainState(ctx);
    const { params, decimals } = await readParams(ctx);
    const next = { ...params, perAddrDailyCap: params.perAddrDailyCap! - 100n * U };
    expect(validate("bsc", next, decimals)).toEqual([]);
    await expect(applyParams(ctx, localSigner(w, w.act.wl), st.timelock, params, next)).rejects.toThrow();
    const r = await applyParams(ctx, localSigner(w, w.act.admin), st.timelock, params, next);
    expect(r.kind).toBe("direct");
    expect((await readParams(ctx)).params.perAddrDailyCap).toBe(next.perAddrDailyCap);
    expect(validate("bsc", { ...next, largeThreshold: next.perAddrDailyCap! + 1n }, decimals)).toContain("必须满足 大额阈值 ≤ 每地址日额度 ≤ 全局日额度");
    expect(validate("bsc", { ...next, dailyCap: 1n }, decimals).join()).toContain("不得低于");
    await expect(applyParams(ctx, localSigner(w, w.act.admin), st.timelock, next, next)).rejects.toThrow("参数没有变化");
    const wp = (await readParams(w.chains.wantos)).params;
    expect(crossWarnings({ ...next, perAddrDailyCap: 1n }, wp)).toContain("BSC 每地址日额度 应 ≥ WANTOS 每地址日额度");
  });

  it("supplyCeiling: lower direct, raise via timelock", async () => {
    const ctx = w.chains.wantos;
    const st = await readChainState(ctx);
    const cur = (await readReserve(ctx)).supplyCeiling!;
    expect((await setSupplyCeiling(ctx, localSigner(w, w.act.admin), st.timelock, cur, cur - 1n)).kind).toBe("direct");
    expect((await setSupplyCeiling(ctx, localSigner(w, w.act.admin), st.timelock, cur - 1n, cur)).kind).toBe("timelock");
    await expect(setSupplyCeiling(w.chains.bsc, localSigner(w, w.act.admin), st.timelock, 1n, 2n)).rejects.toThrow();
  });

  it("execution failure from a bad implementation is shown as 'do not retry'", () => {
    expect(executeErrorText(new Error("x"))).toBe("x");
    const fake = Object.assign(new Error("合约拒绝：BridgeCheckFailed"), {});
    expect(executeErrorText(fake)).toContain("不要重试");
  });

  it("calls are decoded by their TARGET; unknown data / foreign targets are flagged", async () => {
    const tl = (await readChainState(w.chains.bsc)).timelock;
    const own = { bridge: w.bridge, timelock: tl };
    const d = decodeCall(w.chains.bsc.bridgeAbi, w.bridge, 0n, "0xdeadbeef", own);
    expect(d.fn).toBeNull();
    expect(d.targetKind).toBe("bridge");
    expect(d.kind).toContain("无法解码");
    const grant = encodeFunctionData({ abi: w.chains.bsc.bridgeAbi, functionName: "grantRole", args: [RELAYER_ROLE, w.act.stranger.address] });
    const g = decodeCall(w.chains.bsc.bridgeAbi, w.bridge, 0n, grant, own);
    expect(g.text).toContain("RELAYER_ROLE");
    // the same bridge call aimed at another contract is NOT decoded as a bridge call
    const o = decodeCall(w.chains.bsc.bridgeAbi, w.act.stranger.address, 0n, grant, own);
    expect(o.targetKind).toBe("other");
    expect(o.fn).toBeNull();
    expect(o.kind).toContain("目标不是本系统合约");
    // a bridge-only function aimed at the timelock is not decoded with the bridge ABI
    const t = decodeCall(w.chains.bsc.bridgeAbi, tl, 0n, encodeFunctionData({ abi: w.chains.bsc.bridgeAbi, functionName: "pause" }), own);
    expect(t.targetKind).toBe("timelock");
    expect(t.fn).toBeNull();
    const ta = decodeCall(w.chains.bsc.bridgeAbi, tl, 0n, encodeFunctionData({ abi: timelockAbi, functionName: "transferAdmin", args: [w.act.stranger.address] }), own);
    expect(ta.fn).toBe("transferAdmin");
  });
});

describe("/handover full flow (whitelist wallet, both chains)", () => {
  it("proof → begin on both chains → countdown → accept on both → old WL loses power", async () => {
    // 1. the new holder proves the address
    const proof = await makeProof(localSigner(w, w.act.newHolder), "wl", w.bridge);
    const proven = await verifyProof(JSON.stringify(proof), { role: "wl", bridge: w.bridge, client: w.chains.wantos.client });
    expect(proven).toBe(w.act.newHolder.address);
    await expect(verifyProof(JSON.stringify({ ...proof, signature: (await makeProof(localSigner(w, w.act.stranger), "wl", w.bridge)).signature }), { role: "wl", bridge: w.bridge, client: w.chains.bsc.client })).rejects.toThrow("签名不是该地址签的");
    await expect(verifyProof(JSON.stringify(proof), { role: "admin", bridge: w.bridge, client: w.chains.bsc.client })).rejects.toThrow();
    await expect(verifyProof("nope", { role: "wl", bridge: w.bridge, client: w.chains.bsc.client })).rejects.toThrow();
    await expect(verifyProof(JSON.stringify({ message: proof.message.replace(/bridge: .*/, "bridge: 0x0000000000000000000000000000000000000001"), signature: proof.signature }), { role: "wl", bridge: w.bridge, client: w.chains.bsc.client })).rejects.toThrow();

    // 2. begin on BSC only → the page flags the other chain
    const wl = localSigner(w, w.act.wl);
    await expect(actions.beginWl(w.chains.bsc, localSigner(w, w.act.admin), proven)).rejects.toThrow(/NotWhitelistManager/);
    await actions.beginWl(w.chains.bsc, wl, proven);
    let both = await readBoth(w.chains);
    expect(crossChainGaps(both).join()).toContain("只在 BSC 上发起，WANTOS 上还没有");
    await actions.beginWl(w.chains.wantos, wl, proven);
    both = await readBoth(w.chains);
    expect(crossChainGaps(both)).toEqual([]);
    // 3. waiting period: candidate cannot accept yet
    const g = gate("pendingWl", proven, both.bsc);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain("等待期未满");
    expect(countdown(both.bsc.pendingWl!.availableAt, both.bsc.now)).toMatch(/小时/);
    await w.warp(48 * H + 5);
    both = await readBoth(w.chains);
    expect(gate("pendingWl", proven, both.bsc).ok).toBe(true);
    expect(gate("pendingWl", w.act.stranger.address, both.bsc).ok).toBe(false);
    // 4. accept on BSC only → gap shown; then on WANTOS
    const nh = localSigner(w, w.act.newHolder);
    await actions.acceptWl(w.chains.bsc, nh);
    both = await readBoth(w.chains);
    expect(crossChainGaps(both).join()).toContain("两条链的白名单钱包不同");
    await actions.acceptWl(w.chains.wantos, nh);
    both = await readBoth(w.chains);
    for (const s of sides) expect(both[s].wl).toBe(w.act.newHolder.address);
    expect(crossChainGaps(both)).toEqual([]);
    // 5. the old WL can no longer sign batches; the new one can
    const list = parseAddressList(keccak256(toBytes("h1")).slice(0, 42)).addresses;
    const d = (await chainNow(w.chains.bsc)) + DEADLINE_AHEAD_S;
    const old = await runJob(await prepareJob(w.chains, list, true, d), { chains: w.chains, signer: wl });
    expect(old.runs.bsc.error).toContain("InvalidSigner");
    const ok = await runJob(await prepareJob(w.chains, list, true, d), { chains: w.chains, signer: nh });
    expect(ok.runs.wantos.status).toBe("done");
    expect(await readWhitelisted(w.chains.wantos, list)).toEqual([true]);
  });

  it("admin vetoes a WL handover; WL recovery start/cancel symmetric", async () => {
    const wl = localSigner(w, w.act.newHolder); // current WL after the previous test
    const admin = localSigner(w, w.act.admin);
    await actions.beginWl(w.chains.bsc, wl, w.act.wl.address);
    await vetoWlTransfer(w.chains.bsc, admin);
    expect((await readChainState(w.chains.bsc)).pendingWl).toBeNull();
    await actions.startWlRecovery(w.chains.bsc, admin, w.act.wl.address);
    let st = await readChainState(w.chains.bsc);
    expect(st.wlRecovery.active).toBe(true);
    expect(gate("wlRecoveryCandidate", w.act.wl.address, st).reason).toContain("7 天");
    await actions.cancelWlRecovery(w.chains.bsc, wl); // current WL cancels
    st = await readChainState(w.chains.bsc);
    expect(st.wlRecovery.active).toBe(false);
    await expect(actions.acceptWlRecovery(w.chains.bsc, localSigner(w, w.act.wl))).rejects.toThrow();
  });

  it("admin wallet handover: propose transferAdmin on both chains, execute after 48h, accept on both", async () => {
    const admin = localSigner(w, w.act.admin);
    const both0 = await readBoth(w.chains);
    const ids: Record<string, Hex> = {};
    for (const s of sides) ids[s] = (await actions.proposeTransferAdmin(w.chains[s], admin, both0[s].timelock, w.act.stranger.address)).id;
    await w.warp(48 * H + 5);
    for (const s of sides) {
      const p = (await listProposals(w.chains[s], both0[s].timelock)).find((x) => x.id === ids[s])!;
      expect(p.calls[0]!.fn).toBe("transferAdmin");
      expect(p.calls[0]!.kind).toBe("更换管理钱包");
      await executeProposal(w.chains[s], localSigner(w, w.act.pauser), both0[s].timelock, p);
    }
    let both = await readBoth(w.chains);
    expect(both.bsc.pendingAdmin!.candidate).toBe(w.act.stranger.address);
    expect(gate("pendingAdmin", w.act.stranger.address, both.bsc).ok).toBe(true);
    const ns = localSigner(w, w.act.stranger);
    await actions.acceptAdmin(w.chains.bsc, ns, both0.bsc.timelock);
    both = await readBoth(w.chains);
    expect(crossChainGaps(both).join()).toContain("两条链的管理钱包不同");
    await actions.acceptAdmin(w.chains.wantos, ns, both0.wantos.timelock);
    both = await readBoth(w.chains);
    for (const s of sides) expect(both[s].admin).toBe(w.act.stranger.address);
    // old admin lost its direct powers
    await expect(pause(w.chains.bsc, admin)).rejects.toThrow();
  });

  it("admin recovery: WL starts, admin cancels", async () => {
    const st = await readChainState(w.chains.wantos);
    const wl = localSigner(w, w.act.newHolder);
    await actions.startAdminRecovery(w.chains.wantos, wl, st.timelock, w.act.admin.address);
    const s2 = await readChainState(w.chains.wantos);
    expect(s2.adminRecovery.active).toBe(true);
    expect(crossChainGaps(await readBoth(w.chains)).join()).toContain("管理钱包恢复：只在 WANTOS 上发起");
    await actions.cancelAdminRecovery(w.chains.wantos, localSigner(w, w.act.stranger), st.timelock);
    expect((await readChainState(w.chains.wantos)).adminRecovery.active).toBe(false);
  });
});

describe("emergency", () => {
  it("emergency remove freezes first; pause by WL, unpause by WL; revoke keys", async () => {
    const admin = localSigner(w, w.act.stranger); // current admin after the handover tests
    const wl = localSigner(w, w.act.newHolder);
    const ctx = w.chains.bsc;
    const list = parseAddressList([keccak256(toBytes("e1")).slice(0, 42), keccak256(toBytes("e2")).slice(0, 42)].join("\n")).addresses;
    await runJob(await prepareJob(w.chains, list, true, (await chainNow(ctx)) + DEADLINE_AHEAD_S), { chains: w.chains, signer: wl });
    expect(await readWhitelisted(ctx, list)).toEqual([true, true]);
    await expect(emergencyRemove(ctx, wl, list as Address[])).rejects.toThrow();
    const txs = await emergencyRemove(ctx, admin, list as Address[]);
    expect(txs.length).toBe(2); // freeze + remove
    expect((await readChainState(ctx)).frozen).toBe(true);
    expect(await readWhitelisted(ctx, list)).toEqual([false, false]);
    expect((await emergencyRemove(ctx, admin, [list[0]] as Address[])).length).toBe(1); // already frozen
    await expect(emergencyRemove(ctx, admin, [])).rejects.toThrow();

    await pause(ctx, wl);
    expect((await readChainState(ctx)).paused).toBe(true);
    await unpause(ctx, wl);
    expect((await readChainState(ctx)).paused).toBe(false);
    await expect(unpause(ctx, localSigner(w, w.act.pauser))).rejects.toThrow();

    const holders = await keyHolders(ctx);
    expect(holders).toEqual(expect.arrayContaining([{ role: "RELAYER", account: w.act.relayer.address }, { role: "PAUSER", account: w.act.pauser.address }]));
    await revokeKey(ctx, admin, PAUSER_ROLE, w.act.pauser.address);
    expect((await keyHolders(ctx)).find((h) => h.role === "PAUSER")).toBeUndefined();
  });
});

describe("order review + batch void / refund", () => {
  it("decision message is byte-identical to the relayer's and is signed by the admin wallet", async () => {
    const eventKey = keccak256(toBytes("ek")).toUpperCase().replace("0X", "0x") as Hex;
    for (const decision of ["approve", "reject"] as const) {
      const a = { chainId: BSC_ID, eventKey, decision, expires: 1800000000n };
      expect(reviewMessage(a)).toBe(relayerReviewMessage(a));
    }
    const admin = localSigner(w, w.act.stranger);
    const d = await signDecision(w.chains, admin, { direction: "W2B", eventKey, decision: "approve", nowSec: 1_700_000_000n });
    expect(d.expires).toBe(1_700_003_600n);
    expect(d.message).toContain(`chainId: ${BSC_ID}`);
    expect(await recoverMessageAddress({ message: relayerReviewMessage({ chainId: BSC_ID, eventKey, decision: "approve", expires: d.expires }), signature: d.signature })).toBe(getAddress(w.act.stranger.address));
    const b2w = await signDecision(w.chains, admin, { direction: "B2W", eventKey, decision: "reject", nowSec: 1n });
    expect(b2w.message).toContain(`chainId: ${WANTOS_ID}`);
    await expect(signDecision(w.chains, admin, { direction: "B2W", eventKey, decision: "reject", nowSec: 1n, ttl: 25n * 3600n })).rejects.toThrow();
  });

  it("batch void (BSC) and batch refund request (WANTOS) need the right wallet", async () => {
    const admin = localSigner(w, w.act.stranger);
    await expect(voidSourceBatch(w.chains.bsc, localSigner(w, w.act.pauser), [1n, 2n])).rejects.toThrow();
    await voidSourceBatch(w.chains.bsc, admin, [101n, 102n]);
    const key = (await w.chains.bsc.client.readContract({ address: w.bridge, abi: w.chains.bsc.bridgeAbi, functionName: "eventKeyOf", args: [101n] })) as Hex;
    const p = (await w.chains.bsc.client.readContract({ address: w.bridge, abi: w.chains.bsc.bridgeAbi, functionName: "payouts", args: [key] })) as readonly unknown[];
    expect(p[3]).toBe(3); // Voided
    await expect(requestRefundBatch(w.chains.wantos, admin, [999n])).rejects.toThrow(/BadOrderStatus/);
    expect(parseIds("1, 2 5-7，9")).toEqual([1n, 2n, 5n, 6n, 7n, 9n]);
    expect(() => parseIds("a")).toThrow();
    expect(() => parseIds("0")).toThrow();
    expect(() => parseIds("1-900")).toThrow();
  });
});

describe("reserves (read-only)", () => {
  it("balances, quota use and supply ceiling come from chain", async () => {
    const b = await readReserve(w.chains.bsc);
    expect(b.balance).toBe(0n);
    expect(b.cap).toBe(b.params.dailyCap);
    expect(b.totalSupply).toBeUndefined();
    const ww = await readReserve(w.chains.wantos);
    expect(ww.supplyCeiling).toBeGreaterThan(0n);
    expect(ww.decimals).toBe(18);
  });
});
