import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWalletClient, decodeFunctionData, erc20Abi, http } from "viem";
import { KEYS, U, startEnv, whitelist, snapshot, bridgeOutDirect, depositDirect, relayerRelease, type Env } from "../support/anvil";
import { makeClients } from "../../src/lib/clients";
import { ChainStatusProvider } from "../../src/lib/statusProvider";
import { bridgeOutFlow } from "../../src/lib/flows";
import type { AppConfig } from "../../src/config";

let env: Env;
let revert: () => Promise<void>;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(() => env?.stop());
beforeEach(async () => {
  revert = await snapshot(env);
});
afterEach(async () => {
  await revert();
});

const HASH = `0x${"ab".repeat(32)}` as const;

/** Relayer API stub: returns `orders` for every address (untrusted data). */
function withApi(orders: unknown[]): { cfg: AppConfig; fetchFn: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>; calls: string[] } {
  const calls: string[] = [];
  return {
    cfg: { ...env.cfg, relayerApi: "https://relayer.test" },
    calls,
    fetchFn: async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ orders }) };
    },
  };
}

describe("ChainStatusProvider with an (untrusted) relayer API — A3 / B4", () => {
  it("ids the API returns that belong to someone else are not shown (W2B owner / B2W depositor)", async () => {
    await whitelist(env, env.wantos, [KEYS.bob.address]);
    await bridgeOutDirect(env, KEYS.bob, 50n * U);
    await depositDirect(env, KEYS.bob, 40n * U, KEYS.bob.address);
    const api = withApi([
      { direction: "W2B", srcEventNonce: "1", dstTxHash: null },
      { direction: "B2W", srcEventNonce: "1", dstTxHash: null },
    ]);
    const sp = new ChainStatusProvider(api.cfg, makeClients(env.cfg), api.fetchFn);
    expect(await sp.list(KEYS.alice.address)).toEqual([]);
    expect(api.calls[0]).toBe(`https://relayer.test/v1/orders?address=${KEYS.alice.address}`);
    // control: the same ids are shown to their owner
    const bobs = await sp.list(KEYS.bob.address);
    expect(bobs.map((o) => `${o.direction}#${o.id}`).sort()).toEqual(["B2W#1", "W2B#1"]);
  });

  it("API ids of the user's own orders beyond the event look-back are still listed (re-read on chain)", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await bridgeOutDirect(env, KEYS.alice, 50n * U);
    const api = withApi([{ direction: "W2B", srcEventNonce: "1", dstTxHash: null }]);
    const cfg = { ...api.cfg, wantos: { ...api.cfg.wantos, fromBlock: 10_000_000n } }; // logs find nothing
    const sp = new ChainStatusProvider(cfg, makeClients(env.cfg), api.fetchFn);
    expect((await sp.list(KEYS.alice.address)).map((o) => o.id)).toEqual([1n]);
  });

  it("dstTxHash link only once the payout is Released on chain (B4/M22)", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    await bridgeOutDirect(env, KEYS.alice, 50n * U);
    const api = withApi([{ direction: "W2B", srcEventNonce: "1", dstTxHash: HASH }]);
    const sp = new ChainStatusProvider(api.cfg, makeClients(env.cfg), api.fetchFn);
    const before = await sp.list(KEYS.alice.address);
    expect(before[0]).toEqual(expect.objectContaining({ status: "processing", dstTxHash: null }));
    await relayerRelease(env, 1n, KEYS.alice.address, 50n * U);
    const after = await sp.list(KEYS.alice.address);
    expect(after[0]).toEqual(expect.objectContaining({ status: "completed", dstTxHash: HASH }));
  });
});

describe("partial existing allowance (B4/M14)", () => {
  it("re-approves exactly the new amount when the allowance is non-zero but too low", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    const s = env.wantos;
    const wallet = createWalletClient({ chain: s.anvil.chain, transport: http(s.anvil.url), account: KEYS.alice });
    await s.anvil.pc.waitForTransactionReceipt({
      hash: await wallet.writeContract({ address: s.usdt, abi: erc20Abi, functionName: "approve", args: [s.bridge, 30n * U] }),
    });
    const steps: string[] = [];
    const res = await bridgeOutFlow({ cfg: env.cfg, clients: makeClients(env.cfg), wallet }, 100n * U, (x) => steps.push(x));
    expect(res.approveTxHash).not.toBeNull();
    expect(steps[0]).toBe("approve");
    const tx = await s.anvil.pc.getTransaction({ hash: res.approveTxHash! });
    expect(decodeFunctionData({ abi: erc20Abi, data: tx.input }).args).toEqual([s.bridge, 100n * U]);
  });
});
