import { bscVaultV2Abi } from "@bridge/abi";
import { encodeFunctionData } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { DRILL_ACCOUNTS, LOCAL_CHAIN_ID, retarget, runDrill, startLocalVault, tokenAbi, type LocalVault } from "../../src/drill.js";
import { buildManifest } from "../../src/manifest.js";
import { oldKey } from "../../src/oldkey.js";
import { buildProposals, payLegacyCalldata } from "../../src/proposal.js";
import { legacyPaidReader, preflightBatch, readLegacyPaid, reconcileLegacy } from "../../src/reconcile.js";
import { scanLegacy } from "../../src/scan.js";
import { T, VAULT, fixture, manyOrders, tx } from "../helpers.js";

let lv: LocalVault | undefined;
afterEach(() => {
  lv?.stop(); // only the anvil this test started
  lv = undefined;
});

const header = { bscChainId: 56, vault: VAULT, cutoverT: T };
const basic = fixture("legacy-basic.json");
const basicManifest = buildManifest(scanLegacy(basic, { cutoverT: T }).payable, header);

describe("anvil drill (PR-1 contracts deployed locally)", () => {
  it("basic fixture: schedule → verify → 48h → preflight → execute → paid[oldKey] → ΣLegacyPaid; repeat rejected", async () => {
    lv = await startLocalVault();
    const r = await runDrill(lv, basicManifest);
    expect(r.batches).toBe(1);
    expect(r.allPaidOnChain).toBe(true);
    expect(r.vaultSpent).toBe(basicManifest.total);
    expect(r.reconcile).toMatchObject({ ok: true, complete: true, paidCount: 4, errors: [] });
    expect(r.reconcile.legacyPaidTotal).toBe(basicManifest.total);
    expect(r.earlyExecuteRejectedWith).toMatch(/TimelockUnexpectedOperationState/);
    expect(r.duplicateRejectedWith).toBe("LegacyAlreadyPaid");
  });

  it("250 rows: three batches (100/100/50) all paid exactly once", async () => {
    lv = await startLocalVault();
    const m = buildManifest(scanLegacy({ orders: manyOrders(250), payouts: [] }, { cutoverT: T }).payable, header);
    const r = await runDrill(lv, m);
    expect(r.batches).toBe(3);
    expect(r.executed).toHaveLength(3);
    expect(r.reconcile.complete).toBe(true);
    expect(r.reconcile.paidCount).toBe(250);
    expect(r.vaultSpent).toBe(m.total);
    expect(r.duplicateRejectedWith).toBe("LegacyAlreadyPaid");
  });

  it("partial execution: only executed batches are paid; reconciliation stays incomplete; preflight blocks an old-bridge payout seen late", async () => {
    lv = await startLocalVault();
    const m = retarget(buildManifest(scanLegacy({ orders: manyOrders(120), payouts: [] }, { cutoverT: T }).payable, header), lv.vault, LOCAL_CHAIN_ID);
    const A = DRILL_ACCOUNTS;
    await lv.send(A.tokenDeployer, lv.token, encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [A.admin.address, m.total] }));
    await lv.send(A.admin, lv.token, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [lv.vault, m.total] }));
    await lv.send(A.admin, lv.vault, encodeFunctionData({ abi: bscVaultV2Abi, functionName: "fund", args: [m.total] }));
    const from = await lv.pub.getBlockNumber();
    const ps = buildProposals(m, { timelock: lv.timelock });
    expect(ps.map((p) => p.count)).toEqual([100, 20]);
    for (const p of ps) await lv.send(A.admin, lv.timelock, p.scheduleCalldata);
    await lv.increaseTime(48 * 3600 + 1);
    const isPaid = legacyPaidReader(lv.pub, lv.vault);
    await lv.send(A.executor, lv.timelock, ps[0]!.executeCalldata);

    const r = reconcileLegacy([m], await readLegacyPaid(lv.pub, lv.vault, from));
    expect(r).toMatchObject({ ok: true, complete: false, paidCount: 100 });
    expect(r.unpaid).toHaveLength(20);
    expect(await isPaid(ps[1]!.entries[0]!.oldKey)).toBe(false);
    expect(await isPaid(ps[0]!.entries[99]!.oldKey)).toBe(true);

    // the old bridge pays one row of batch 1 after the manifest was published -> do not execute
    const e = ps[1]!.entries[3]!;
    const late = { chainId: 56, txHash: tx("e"), logIndex: 0, to: e.to, amount: "1", srcTxHash: e.srcTxHash, srcLogIndex: e.srcLogIndex };
    const pf = await preflightBatch(ps[1]!.entries, { isLegacyPaid: isPaid, oldPayouts: [late] });
    expect(pf.ok).toBe(false);
    expect(pf.blockers).toHaveLength(1);

    // the admin/WL wallet cancels the operation; the corrected batch (without that row) is proposed again
    await lv.send(A.wl, lv.timelock, encodeFunctionData({ abi: (await import("@bridge/abi")).bridgeTimelockAbi, functionName: "cancel", args: [ps[1]!.operationId] }));
    await expect(lv.send(A.executor, lv.timelock, ps[1]!.executeCalldata)).rejects.toThrow(/TimelockUnexpectedOperationState/);
  });

  it("the contract refuses a batch that mixes a paid oldKey with a new one (whole batch reverts)", async () => {
    lv = await startLocalVault();
    const m = retarget(buildManifest(scanLegacy({ orders: manyOrders(2), payouts: [] }, { cutoverT: T }).payable, header), lv.vault, LOCAL_CHAIN_ID);
    const A = DRILL_ACCOUNTS;
    await lv.send(A.tokenDeployer, lv.token, encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [A.admin.address, m.total * 2n] }));
    await lv.send(A.admin, lv.token, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [lv.vault, m.total * 2n] }));
    await lv.send(A.admin, lv.vault, encodeFunctionData({ abi: bscVaultV2Abi, functionName: "fund", args: [m.total * 2n] }));
    const first = buildProposals(m, { timelock: lv.timelock, exclude: new Set([m.entries[1]!.oldKey]) })[0]!;
    await lv.send(A.admin, lv.timelock, first.scheduleCalldata);
    // second op: both rows (row 0 again + row 1)
    const both = buildProposals(m, { timelock: lv.timelock }, 7)[0]!;
    expect(both.payCalldata).toBe(payLegacyCalldata(m.entries));
    await lv.send(A.admin, lv.timelock, both.scheduleCalldata);
    await lv.increaseTime(48 * 3600 + 1);
    await lv.send(A.executor, lv.timelock, first.executeCalldata);
    await expect(lv.send(A.executor, lv.timelock, both.executeCalldata)).rejects.toThrow(/LegacyAlreadyPaid/);
    const isPaid = legacyPaidReader(lv.pub, lv.vault);
    expect(await isPaid(m.entries[1]!.oldKey)).toBe(false);
  });

  it("non-timelock callers cannot pay legacy orders", async () => {
    lv = await startLocalVault();
    const m = retarget(basicManifest, lv.vault, LOCAL_CHAIN_ID);
    await expect(lv.send(DRILL_ACCOUNTS.admin, lv.vault, payLegacyCalldata(m.entries))).rejects.toThrow(/NotTimelock/);
  });
});
