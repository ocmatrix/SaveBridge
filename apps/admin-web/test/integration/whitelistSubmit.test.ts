import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWalletClient, http, keccak256, toBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bscVaultV2Abi } from "@bridge/abi";
import { batchTypedData, parseAddressList } from "../../src/lib/normalize";
import { readNonce, readWhitelisted } from "../../src/lib/whitelist";
import { chainNow } from "../../src/lib/chain";
import { submitWhitelist, type SubmitBody, type SubmitEnv } from "../../functions/_lib/submit";
import { BSC_ID, WANTOS_ID, startWorld, type World } from "../support/world";

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
const txCount = async () => ({
  bsc: await w.chains.bsc.client.getTransactionCount({ address: submitter.address }),
  wantos: await w.chains.wantos.client.getTransactionCount({ address: submitter.address }),
});
// the service reads Date.now(); anvil's clock is the wall clock unless warped, so pass the chain clock explicitly
const nowFn = async () => {
  const t = Number(await chainNow(w.chains.bsc)) * 1000;
  return () => t;
};
const run = async (body: unknown) => submitWhitelist(env, body, await nowFn());

/** What the page sends: the whitelist wallet signs ONE chainless batch. */
async function signed(list: string[], allowed: boolean, nonce: bigint, o: { deadline?: bigint; signer?: ReturnType<typeof privateKeyToAccount> } = {}): Promise<SubmitBody> {
  const deadline = o.deadline ?? (await chainNow(w.chains.bsc)) + 3600n;
  const td = batchTypedData({ side: "bsc", chainId: BSC_ID, bridge: w.bridge, addresses: list, allowed, nonce, deadline });
  const signature = await (o.signer ?? w.act.wl).signTypedData(td as Parameters<typeof w.act.wl.signTypedData>[0]);
  return { addresses: list, allowed, nonce: String(nonce), deadline: String(deadline), signature };
}

describe("one-signature whitelist submission (REDEPLOY-PLAN D3/D4)", () => {
  it("add: one signature is written to both chains; the same request again sends nothing", async () => {
    const list = addrs("one", 4);
    const body = await signed(list, true, await readNonce(w.chains.bsc));
    const before = await txCount();
    const r = await run(body);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.runs!.bsc.status).toBe("done");
    expect(r.json.runs!.wantos.status).toBe("done");
    for (const s of ["bsc", "wantos"] as const) expect(await readWhitelisted(w.chains[s], list)).toEqual(list.map(() => true));
    const after = await txCount();
    expect(after.bsc - before.bsc).toBe(1);
    expect(after.wantos - before.wantos).toBe(1);
    const again = await run(body);
    expect(again.status).toBe(200);
    expect(again.json.runs!.bsc.status).toBe("skipped");
    expect(again.json.runs!.wantos.status).toBe("skipped");
    expect(await txCount()).toEqual(after);
  });

  it("remove: both chains cleared with one signature", async () => {
    const list = addrs("one", 4);
    const r = await run(await signed(list, false, await readNonce(w.chains.wantos)));
    expect(r.json.ok).toBe(true);
    expect(r.json.runs!.wantos.status).toBe("done");
    expect(r.json.runs!.bsc.status).toBe("done");
    for (const s of ["bsc", "wantos"] as const) expect(await readWhitelisted(w.chains[s], list)).toEqual(list.map(() => false));
  });

  it("a signature from anyone but the whitelist wallet is refused before any gas is spent", async () => {
    const list = addrs("evil", 2);
    const body = await signed(list, true, await readNonce(w.chains.bsc), { signer: w.act.stranger });
    const before = await txCount();
    const r = await run(body);
    expect(r.status).toBe(403);
    expect(await txCount()).toEqual(before);
    for (const s of ["bsc", "wantos"] as const) expect(await readWhitelisted(w.chains[s], list)).toEqual(list.map(() => false));
  });

  it("a valid signature over a different list is refused (tampered request)", async () => {
    const real = addrs("real", 2);
    const body = await signed(real, true, await readNonce(w.chains.bsc));
    const before = await txCount();
    const r = await run({ ...body, addresses: addrs("other", 2) });
    expect(r.status).toBe(403);
    expect(await txCount()).toEqual(before);
  });

  it("expired or too-far deadline is refused without sending", async () => {
    const list = addrs("dl", 1);
    const now = await chainNow(w.chains.bsc);
    const nonce = await readNonce(w.chains.bsc);
    const before = await txCount();
    expect((await run(await signed(list, true, nonce, { deadline: now + 30n }))).status).toBe(409);
    expect((await run(await signed(list, true, nonce, { deadline: now + 25n * 3600n }))).status).toBe(400);
    expect(await txCount()).toEqual(before);
  });

  it("only one chain advanced: the other is refused with a clear nonce message, the finished chain is reported", async () => {
    // advance only BSC's nonce directly (what someone replaying a signature on one chain would do)
    const first = addrs("p1", 1);
    const nonce = await readNonce(w.chains.bsc);
    expect(await readNonce(w.chains.wantos)).toBe(nonce);
    const direct = await signed(first, true, nonce);
    const wallet = createWalletClient({ account: submitter, transport: http(w.cfg.bsc.rpcUrl) });
    const h = await wallet.writeContract({ address: w.bridge, abi: bscVaultV2Abi, functionName: "applyWhitelistBatch", args: [first as `0x${string}`[], true, nonce, BigInt(direct.deadline), direct.signature as Hex], chain: null });
    await w.chains.bsc.client.waitForTransactionReceipt({ hash: h });
    expect(await readNonce(w.chains.bsc)).toBe(nonce + 1n);
    expect(await readNonce(w.chains.wantos)).toBe(nonce);
    // a batch signed for BSC's next nonce cannot be applied on WANTOS
    const r = await run(await signed(addrs("p2", 1), true, nonce + 1n));
    expect(r.status).toBe(409);
    expect(r.json.runs!.bsc.status).toBe("done");
    expect(r.json.runs!.wantos.status).toBe("failed");
    expect(r.json.runs!.wantos.error).toContain("nonce");
  });

  it("malformed bodies are rejected", async () => {
    const good = await signed(addrs("m", 2), true, await readNonce(w.chains.bsc));
    expect((await run({ ...good, addresses: [...good.addresses].reverse() })).status).toBe(400);
    expect((await run({ ...good, addresses: [] })).status).toBe(400);
    expect((await run({ ...good, signature: "0x1234" })).status).toBe(400);
    expect((await run({ ...good, allowed: "yes" })).status).toBe(400);
    expect((await run(null)).status).toBe(400);
  });

  it("an unconfigured key fails closed and never leaks the key", async () => {
    const r = await submitWhitelist({ ...env, SUBMITTER_KEY: "" }, await signed(addrs("k", 1), true, await readNonce(w.chains.bsc)), await nowFn());
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.json)).not.toContain(submitterKey);
  });
});
