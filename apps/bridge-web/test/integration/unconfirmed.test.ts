import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWalletClient, http, HttpRequestError, WaitForTransactionReceiptTimeoutError, type Hex, type PublicClient } from "viem";
import { KEYS, U, startEnv, whitelist, snapshot, type Env } from "../support/anvil";
import { makeClients, type Clients } from "../../src/lib/clients";
import { bridgeOutFlow, depositFlow } from "../../src/lib/flows";
import { describeError, translateError } from "../../src/lib/errors";

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

/** Receipt waits succeed `okWaits` times, then fail with `err` (timeout / RPC down) although the tx was mined. */
export function flakyReceipts(base: Clients, side: "wantos" | "bsc", okWaits: number, err: (hash: Hex) => Error): Clients {
  let n = 0;
  const pc = base[side];
  const waitForTransactionReceipt = (async (args: { hash: Hex }) => {
    if (n++ < okWaits) return pc.waitForTransactionReceipt(args);
    throw err(args.hash);
  }) as PublicClient["waitForTransactionReceipt"];
  return { ...base, [side]: { ...pc, waitForTransactionReceipt } as PublicClient };
}

const timeout = (hash: Hex) => new WaitForTransactionReceiptTimeoutError({ hash });
const rpcDown = () => new HttpRequestError({ url: "http://rpc", details: "fetch failed" });

describe("errors after broadcast are never shown as 'failed' (B1)", () => {
  it("bridgeOut broadcast, receipt wait times out → unconfirmed with the real hash; no 失败/重试", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    const s = env.wantos;
    const wallet = createWalletClient({ chain: s.anvil.chain, transport: http(s.anvil.url), account: KEYS.alice });
    const clients = flakyReceipts(makeClients(env.cfg), "wantos", 1, timeout); // approve confirms, bridgeOut does not
    const seen: [string, Hex | undefined][] = [];
    const err = await bridgeOutFlow({ cfg: env.cfg, clients, wallet }, 100n * U, (st, h) => seen.push([st, h])).catch((e) => e);
    const sentHash = seen.filter(([st, h]) => st === "confirming" && h).at(-1)![1]!;
    expect(err.name).toBe("UnconfirmedTxError");
    expect(err.hash).toBe(sentHash);
    // the transaction really is on chain
    expect((await s.anvil.pc.getTransactionReceipt({ hash: sentHash })).status).toBe("success");
    const tr = translateError(err, { decimals: 18 });
    expect(tr.key).toBe("err.unconfirmed");
    for (const lang of ["zh", "en"] as const) {
      const text = describeError(tr, lang);
      expect(text).toContain(sentHash);
      expect(text).not.toMatch(/失败|重试|failed|retry|try again/i);
    }
  });

  it("deposit: RPC drops while waiting → unconfirmed (not network failure)", async () => {
    const s = env.bsc;
    const wallet = createWalletClient({ chain: s.anvil.chain, transport: http(s.anvil.url), account: KEYS.alice });
    const clients = flakyReceipts(makeClients(env.cfg), "bsc", 1, rpcDown);
    const err = await depositFlow({ cfg: env.cfg, clients, wallet }, 50n * U, KEYS.alice.address, () => {}).catch((e) => e);
    expect(translateError(err, { decimals: 18 }).key).toBe("err.unconfirmed");
  });

  it("approve broadcast but unconfirmed → also unconfirmed (approve hash), bridgeOut not sent", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    const s = env.wantos;
    const wallet = createWalletClient({ chain: s.anvil.chain, transport: http(s.anvil.url), account: KEYS.alice });
    const before = await s.anvil.pc.getTransactionCount({ address: KEYS.alice.address });
    const clients = flakyReceipts(makeClients(env.cfg), "wantos", 0, timeout);
    const err = await bridgeOutFlow({ cfg: env.cfg, clients, wallet }, 100n * U, () => {}).catch((e) => e);
    expect(translateError(err, { decimals: 18 }).key).toBe("err.unconfirmed");
    expect(await s.anvil.pc.getTransactionCount({ address: KEYS.alice.address })).toBe(before + 1);
  });
});
