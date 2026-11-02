import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, keccak256, toBytes, type Address } from "viem";
import * as tool from "@bridge/offline-check";
import { chunk, parseAddressList } from "../../src/lib/normalize";
import { DEADLINE_AHEAD_S, diffChains, invalidateNonce, isComplete, newJob, preview, readWhitelisted, runJob, whitelistHistory, writeOrder, prepareJob } from "../../src/lib/whitelist";
import { chainNow } from "../../src/lib/chain";
import { BSC_ID, WANTOS_ID, localSigner, startWorld, type World } from "../support/world";

let w: World;
beforeAll(async () => {
  w = await startWorld();
});
afterAll(async () => w?.stop());

const addrs = (tag: string, n: number) => parseAddressList(Array.from({ length: n }, (_, i) => keccak256(toBytes(`${tag}${i}`)).slice(0, 42)).join("\n")).addresses;
const cliBase = (nonce: bigint, d: bigint) => ["--action", "add", "--contract", w.bridge, "--bsc-chain-id", String(BSC_ID), "--wantos-chain-id", String(WANTOS_ID), "--bsc-nonce", String(nonce), "--wantos-nonce", "0", "--deadline", String(d)];
const deadline = async () => (await chainNow(w.chains.bsc)) + DEADLINE_AHEAD_S;

describe("whitelist batch write (two chains, §4.4 order)", () => {
  it("add: BSC first then WANTOS, exactly two typed-data signatures, both chains written", async () => {
    const s = localSigner(w, w.act.wl);
    const list = addrs("a", 5);
    const job = await runJob(await prepareJob(w.chains, list, true, await deadline()), { chains: w.chains, signer: s });
    expect(isComplete(job)).toBe(true);
    expect(s.log.filter((x) => x.startsWith("sign712"))).toEqual([`sign712:${BSC_ID}`, `sign712:${WANTOS_ID}`]);
    expect(s.log.indexOf(`write:${BSC_ID}:applyWhitelistBatch`)).toBeLessThan(s.log.indexOf(`write:${WANTOS_ID}:applyWhitelistBatch`));
    for (const side of ["bsc", "wantos"] as const) expect(await readWhitelisted(w.chains[side], list)).toEqual(list.map(() => true));
    expect(job.runs.bsc.hashes!.listHash).toBe(tool.listHash(list));
  });

  it("remove: WANTOS first then BSC", async () => {
    expect(writeOrder(false)).toEqual(["wantos", "bsc"]);
    const s = localSigner(w, w.act.wl);
    const list = addrs("r", 3);
    await runJob(await prepareJob(w.chains, list, true, await deadline()), { chains: w.chains, signer: s });
    s.log.length = 0;
    const job = await runJob(await prepareJob(w.chains, list, false, await deadline()), { chains: w.chains, signer: s });
    expect(isComplete(job)).toBe(true);
    expect(s.log.filter((x) => x.startsWith("sign712"))).toEqual([`sign712:${WANTOS_ID}`, `sign712:${BSC_ID}`]);
    for (const side of ["bsc", "wantos"] as const) expect(await readWhitelisted(w.chains[side], list)).toEqual(list.map(() => false));
  });

  it("partial failure: BSC written, WANTOS fails → retry writes only WANTOS and reuses its signature", async () => {
    const s = localSigner(w, w.act.wl);
    const list = addrs("p", 4);
    s.failNext(new RegExp(`^write:${WANTOS_ID}:`), "network down");
    const progress: string[] = [];
    let job = await runJob(await prepareJob(w.chains, list, true, await deadline()), { chains: w.chains, signer: s, onProgress: (j) => progress.push(`${j.runs.bsc.status}/${j.runs.wantos.status}`) });
    expect(job.runs.bsc.status).toBe("done");
    expect(job.runs.wantos.status).toBe("failed");
    expect(job.runs.wantos.error).toContain("network down");
    expect(progress).toContain("done/signing");
    expect(await readWhitelisted(w.chains.bsc, list)).toEqual(list.map(() => true));
    expect(await readWhitelisted(w.chains.wantos, list)).toEqual(list.map(() => false));
    // the inconsistency is visible on the history view
    const [hb, hw] = await Promise.all([whitelistHistory(w.chains.bsc), whitelistHistory(w.chains.wantos)]);
    expect(diffChains(hb.current, hw.current).onlyBsc).toEqual(list.map((a) => getAddress(a)));
    s.log.length = 0;
    job = await runJob(job, { chains: w.chains, signer: s });
    expect(isComplete(job)).toBe(true);
    expect(s.log).toEqual([`write:${WANTOS_ID}:applyWhitelistBatch`]); // no BSC call, no new signature
    expect(await readWhitelisted(w.chains.wantos, list)).toEqual(list.map(() => true));
  });

  it("partial failure + nonce moved → retry refuses (needs prepare); re-prepared batch signs once with the new nonce", async () => {
    const s = localSigner(w, w.act.wl);
    const list = addrs("n", 2);
    s.failNext(new RegExp(`^write:${WANTOS_ID}:`));
    const d = await deadline();
    let job = await runJob(await prepareJob(w.chains, list, true, d), { chains: w.chains, signer: s });
    expect(job.runs.wantos.status).toBe("failed");
    expect(job.runs.wantos.error).toContain("钱包里拒绝了");
    expect(job.runs.wantos.needsPrepare).toBeUndefined();
    const oldNonce = job.runs.wantos.nonce!;
    await invalidateNonce(w.chains.wantos, s);
    s.log.length = 0;
    job = await runJob(job, { chains: w.chains, signer: s });
    expect(job.runs.wantos.status).toBe("failed");
    expect(job.runs.wantos.needsPrepare).toBe(true);
    expect(job.runs.wantos.error).toContain(`已从 ${oldNonce} 变为 ${oldNonce + 1n}`);
    expect(s.log).toEqual([]); // no silent re-sign
    job = await runJob(await prepareJob(w.chains, list, true, d), { chains: w.chains, signer: s });
    expect(isComplete(job)).toBe(true);
    expect(job.runs.wantos.nonce).toBe(oldNonce + 1n);
    expect(s.log).toEqual([`sign712:${WANTOS_ID}`, `write:${WANTOS_ID}:applyWhitelistBatch`]); // BSC skipped (already written)
  });

  it("nonce moves between prepare and the first signature → stops before signing (hashes on screen never silently replaced)", async () => {
    const s = localSigner(w, w.act.wl);
    const job0 = await prepareJob(w.chains, addrs("b2", 2), true, await deadline());
    await invalidateNonce(w.chains.bsc, s);
    s.log.length = 0;
    const job = await runJob(job0, { chains: w.chains, signer: s });
    expect(job.runs.bsc.status).toBe("failed");
    expect(job.runs.bsc.needsPrepare).toBe(true);
    expect(job.runs.bsc.hashes).toEqual(job0.runs.bsc.hashes);
    expect(job.runs.wantos.status).toBe("pending");
    expect(s.log).toEqual([]);
    // an unprepared job is refused as well
    const raw = await runJob(newJob(addrs("b3", 1), true, await deadline()), { chains: w.chains, signer: s });
    expect(raw.runs.bsc.needsPrepare).toBe(true);
    expect(s.log).toEqual([]);
  });

  it("a non-whitelist wallet cannot write: contract rejects the signature (InvalidSigner), nothing changes", async () => {
    for (const who of [w.act.stranger, w.act.admin]) {
      const s = localSigner(w, who);
      const list = addrs(`x${who.address}`, 2);
      const job = await runJob(await prepareJob(w.chains, list, true, await deadline()), { chains: w.chains, signer: s });
      expect(job.runs.bsc.status).toBe("failed");
      expect(job.runs.bsc.error).toContain("InvalidSigner");
      expect(job.runs.wantos.status).toBe("pending"); // stopped at the first chain
      expect(await readWhitelisted(w.chains.bsc, list)).toEqual([false, false]);
    }
  });

  it("already in target state → skipped without any signature; expired deadline refuses", async () => {
    const s = localSigner(w, w.act.wl);
    const list = addrs("a", 5); // written by the first test
    const job = await runJob(await prepareJob(w.chains, list, true, await deadline()), { chains: w.chains, signer: s });
    expect(job.runs.bsc.status).toBe("skipped");
    expect(job.runs.wantos.status).toBe("skipped");
    expect(s.log).toEqual([]);
    const fresh = addrs("d", 1);
    const old = await runJob(await prepareJob(w.chains, fresh, true, (await chainNow(w.chains.bsc)) + 10n), { chains: w.chains, signer: s });
    expect(old.runs.bsc.status).toBe("failed");
    expect(old.runs.bsc.error).toContain("有效期");
    expect(old.runs.bsc.needsPrepare).toBe(true);
  });

  it("invalidateWhitelistNonce is whitelist-wallet only", async () => {
    await expect(invalidateNonce(w.chains.bsc, localSigner(w, w.act.admin))).rejects.toThrow();
    const before = (await preview(w.chains.bsc, newJob(addrs("q", 1), true, 1n))).nonce;
    await invalidateNonce(w.chains.bsc, localSigner(w, w.act.wl));
    expect((await preview(w.chains.bsc, newJob(addrs("q", 1), true, 1n))).nonce).toBe(before + 1n);
  });

  it("history: batch records and current list", async () => {
    const h = await whitelistHistory(w.chains.bsc);
    expect(h.batches.length).toBeGreaterThanOrEqual(4);
    expect(h.current).toContain(getAddress(addrs("a", 5)[0]!));
    expect(h.current).not.toContain(getAddress(addrs("r", 3)[0]!));
  });
});

describe("tamper scenario (DESIGN §11 管理后台被篡改 / §13 PR-6 验收)", () => {
  it("page silently adds an address: offline tool's listHash / digest differ from what is signed → tool refuses (exit 2)", async () => {
    const rawFile = addrs("t", 3).join("\n"); // the owner's original file
    const attacker = "0x00000000000000000000000000000000000badd0";
    // a tampered page parses the file and injects one address before hashing / signing
    const tampered = chunk([...parseAddressList(rawFile).addresses, attacker].sort())[0]!;
    const d = await deadline();
    const pv = await preview(w.chains.bsc, newJob(tampered, true, d)); // what the tampered page shows and asks to sign
    const offline = tool.computeBatches(rawFile, {
      allowed: true,
      contract: w.bridge,
      deadline: d,
      bscNonce: pv.nonce,
      wantosNonce: 0n,
      bscChainId: BSC_ID,
      wantosChainId: WANTOS_ID,
    });
    expect(offline.batches[0]!.listHash).not.toBe(pv.listHash);
    expect(offline.batches[0]!.count).not.toBe(pv.count);
    expect(offline.batches[0]!.bsc.messageHash).not.toBe(pv.messageHash);
    expect(offline.batches[0]!.bsc.digest).not.toBe(pv.digest);
    const cli = tool.runCli(["raw.txt", ...cliBase(pv.nonce, d), "--expect-list-hash", pv.listHash], () => rawFile);
    expect(cli.code).toBe(2);
    expect(cli.out).toContain("不要签名");
    // the same check passes for an honest page
    const honest = await preview(w.chains.bsc, newJob(parseAddressList(rawFile).addresses, true, d));
    expect(tool.runCli(["raw.txt", ...cliBase(honest.nonce, d), "--expect-list-hash", honest.listHash], () => rawFile).code).toBe(0);
    const ob = tool.computeBatches(rawFile, { allowed: true, contract: w.bridge, deadline: d, bscNonce: honest.nonce, bscChainId: BSC_ID, wantosChainId: WANTOS_ID });
    expect(ob.batches[0]!.bsc.digest).toBe(honest.digest);
  });

  it("page shows the honest hash but asks the wallet to sign a tampered batch: the wallet's digest ≠ the tool's digest", async () => {
    const rawFile = addrs("u", 2).join("\n");
    const d = await deadline();
    const nonce = (await preview(w.chains.bsc, newJob([], true, d))).nonce;
    const ob = tool.computeBatches(rawFile, { allowed: true, contract: w.bridge, deadline: d, bscNonce: nonce, bscChainId: BSC_ID, wantosChainId: WANTOS_ID });
    // the payload actually handed to the wallet
    const signed = await preview(w.chains.bsc, newJob([...parseAddressList(rawFile).addresses, "0xffffffffffffffffffffffffffffffffffffff01"].sort(), true, d));
    expect(signed.digest).not.toBe(ob.batches[0]!.bsc.digest);
    expect(signed.messageHash).not.toBe(ob.batches[0]!.bsc.messageHash);
    expect(signed.domainHash).toBe(ob.batches[0]!.bsc.domainHash); // domain is the same, the message is what differs
  });
});

export type { Address };
