import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseAddressList } from "../../src/lib/normalize";
import { DEADLINE_AHEAD_S, invalidateNonce, isComplete, prepareJob, readWhitelisted, runJobShared } from "../../src/lib/whitelist";
import { chainNow } from "../../src/lib/chain";
import { submitWhitelist, type SubmitEnv } from "../../functions/_lib/submit";
import { BSC_ID, WANTOS_ID, localSigner, startWorld, type World } from "../support/world";

let w: World;
let env: SubmitEnv;
const submitterKey = generatePrivateKey();
const submitter = privateKeyToAccount(submitterKey);

beforeAll(async () => {
  w = await startWorld();
  for (const n of [w.node.bsc, w.node.wantos]) await n.test.setBalance({ address: submitter.address, value: 10n ** 21n });
  env = { BRIDGE: w.bridge, BSC_CHAIN_ID: String(BSC_ID), BSC_RPC_URL: w.cfg.bsc.rpcUrl, WANTOS_CHAIN_ID: String(WANTOS_ID), WANTOS_RPC_URL: w.cfg.wantos.rpcUrl, SUBMITTER_KEY: submitterKey };
});
afterAll(async () => w?.stop());

const addrs = (tag: string, n: number) => parseAddressList(Array.from({ length: n }, (_, i) => keccak256(toBytes(`${tag}${i}`)).slice(0, 42)).join("\n")).addresses;
const deadline = async () => (await chainNow(w.chains.bsc)) + DEADLINE_AHEAD_S;
/** The Pages Function, called in-process (the chain clock stands in for Date.now()). */
const serviceFetch = (calls: { n: number } = { n: 0 }): typeof fetch =>
  (async (_url: unknown, init?: RequestInit) => {
    calls.n++;
    const t = Number(await chainNow(w.chains.bsc)) * 1000;
    const r = await submitWhitelist(env, JSON.parse(String(init?.body)), () => t);
    return new Response(JSON.stringify(r.json), { status: r.status });
  }) as typeof fetch;

describe("runJobShared: one wallet signature, no network switch", () => {
  it("signs once, never sends a wallet transaction, and both chains end up whitelisted", async () => {
    const s = localSigner(w, w.act.wl);
    const list = addrs("s1", 6);
    const job = await runJobShared(await prepareJob(w.chains, list, true, await deadline()), { chains: w.chains, signer: s, submitApi: "/api/whitelist", fetchFn: serviceFetch() });
    expect(isComplete(job)).toBe(true);
    expect(s.log.filter((x) => x.startsWith("sign712"))).toHaveLength(1);
    expect(s.log.filter((x) => x.startsWith("write:"))).toEqual([]);
    expect(job.runs.bsc.txHash).toBeTruthy();
    expect(job.runs.wantos.txHash).toBeTruthy();
    for (const side of ["bsc", "wantos"] as const) expect(await readWhitelisted(w.chains[side], list)).toEqual(list.map(() => true));
  });

  it("a service outage keeps the signature; the retry sends the SAME signature without asking the wallet again", async () => {
    const s = localSigner(w, w.act.wl);
    const list = addrs("s2", 3);
    const prepared = await prepareJob(w.chains, list, true, await deadline());
    const down = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    let job = await runJobShared(prepared, { chains: w.chains, signer: s, submitApi: "/api/whitelist", fetchFn: down });
    expect(isComplete(job)).toBe(false);
    expect(job.runs.bsc.status).toBe("failed");
    expect(job.runs.bsc.signature).toBeTruthy();
    expect(s.log.filter((x) => x.startsWith("sign712"))).toHaveLength(1);
    job = await runJobShared(job, { chains: w.chains, signer: s, submitApi: "/api/whitelist", fetchFn: serviceFetch() });
    expect(isComplete(job)).toBe(true);
    expect(s.log.filter((x) => x.startsWith("sign712"))).toHaveLength(1); // not signed again
    for (const side of ["bsc", "wantos"] as const) expect(await readWhitelisted(w.chains[side], list)).toEqual(list.map(() => true));
  });

  it("different nonces on the two chains cannot share a signature: the batch must be prepared again, nothing is signed", async () => {
    const s = localSigner(w, w.act.wl);
    await invalidateNonce(w.chains.bsc, localSigner(w, w.act.wl)); // only BSC moves on
    const calls = { n: 0 };
    const job = await runJobShared(await prepareJob(w.chains, addrs("s3", 2), true, await deadline()), { chains: w.chains, signer: s, submitApi: "/api/whitelist", fetchFn: serviceFetch(calls) });
    expect(job.runs.bsc.needsPrepare).toBe(true);
    expect(job.runs.bsc.error).toContain("nonce 不一致");
    expect(s.log.filter((x) => x.startsWith("sign712"))).toEqual([]);
    expect(calls.n).toBe(0);
    // repair: bring WANTOS to the same nonce, then it works
    await invalidateNonce(w.chains.wantos, localSigner(w, w.act.wl));
    const list = addrs("s3", 2);
    const ok = await runJobShared(await prepareJob(w.chains, list, true, await deadline()), { chains: w.chains, signer: s, submitApi: "/api/whitelist", fetchFn: serviceFetch() });
    expect(isComplete(ok)).toBe(true);
  });

  it("the nonce moved after preparing (service answers 409): the stored signature is dropped and a new prepare is demanded", async () => {
    const s = localSigner(w, w.act.wl);
    const list = addrs("s4", 2);
    const prepared = await prepareJob(w.chains, list, true, await deadline());
    await invalidateNonce(w.chains.bsc, localSigner(w, w.act.wl));
    await invalidateNonce(w.chains.wantos, localSigner(w, w.act.wl));
    const job = await runJobShared(prepared, { chains: w.chains, signer: s, submitApi: "/api/whitelist", fetchFn: serviceFetch() });
    expect(isComplete(job)).toBe(false);
    expect(job.runs.bsc.needsPrepare).toBe(true);
    expect(job.runs.bsc.signature).toBeUndefined();
    expect(await readWhitelisted(w.chains.bsc, list)).toEqual(list.map(() => false));
  });
});
