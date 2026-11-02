import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { readChainState } from "../../src/lib/state";
import { listProposals } from "../../src/lib/timelock";
import { applyParams, readParams } from "../../src/lib/params";
import { actions } from "../../src/lib/handover";
import { chainNow } from "../../src/lib/chain";
import { parseAddressList } from "../../src/lib/normalize";
import { DEADLINE_AHEAD_S, newJob, readWhitelisted, runJob, prepareJob } from "../../src/lib/whitelist";
import { U, localSigner, startWorld, type World } from "../support/world";

let w: World;
beforeAll(async () => {
  w = await startWorld();
});
afterAll(async () => w?.stop());

describe("mixed batch (some addresses already in target state) is NOT skipped", () => {
  it("writes the batch when only part of it is already whitelisted", async () => {
    const wl = localSigner(w, w.act.wl);
    const [a, b] = parseAddressList([keccak256(toBytes("m1")).slice(0, 42), keccak256(toBytes("m2")).slice(0, 42)].join("\n")).addresses as [string, string];
    const d = (await chainNow(w.chains.bsc)) + DEADLINE_AHEAD_S;
    await runJob(await prepareJob(w.chains, [a], true, d), { chains: w.chains, signer: wl });
    const job = await runJob(await prepareJob(w.chains, [a, b], true, d), { chains: w.chains, signer: wl });
    expect(job.runs.bsc.status).toBe("done");
    expect(job.runs.wantos.status).toBe("done");
    expect(await readWhitelisted(w.chains.bsc, [a, b])).toEqual([true, true]);
  });
});

describe("admin recovery completes → older proposals show as void (stale epoch)", () => {
  it("proposal made before the recovery is listed as stale after acceptAdmin", async () => {
    const ctx = w.chains.bsc;
    const st = await readChainState(ctx);
    const { params } = await readParams(ctx);
    const r = await applyParams(ctx, localSigner(w, w.act.admin), st.timelock, params, { ...params, dailyCap: params.dailyCap! + 1000n * U });
    await actions.startAdminRecovery(ctx, localSigner(w, w.act.wl), st.timelock, w.act.newHolder.address);
    await w.warp(14 * 86400 + 5);
    await actions.acceptAdmin(ctx, localSigner(w, w.act.newHolder), st.timelock);
    const p = (await listProposals(ctx, st.timelock)).find((x) => x.id === r.id)!;
    expect(p.state).toBe("stale");
    expect((await readChainState(ctx)).admin).toBe(w.act.newHolder.address);
  });
});
