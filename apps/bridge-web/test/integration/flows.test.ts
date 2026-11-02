import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWalletClient, decodeFunctionData, erc20Abi, http, maxUint256, parseEventLogs, type Address } from "viem";
import { bscVaultV2Abi } from "@bridge/abi";
import { KEYS, U, startEnv, whitelist, pause, relayerRelease, relayerCredit, relayerQueue, mintWantosUsdt, snapshot, type Env } from "../support/anvil";
import { makeClients } from "../../src/lib/clients";
import { readBridgeState } from "../../src/lib/reader";
import { bridgeOutFlow, depositFlow, sendGuarded } from "../../src/lib/flows";
import { ChainStatusProvider } from "../../src/lib/statusProvider";
import { translateError } from "../../src/lib/errors";
import { TargetNotAllowedError } from "../../src/lib/guard";

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

function ctxFor(side: "wantos" | "bsc", user = KEYS.alice) {
  const s = env[side];
  const wallet = createWalletClient({ chain: s.anvil.chain, transport: http(s.anvil.url), account: user });
  return { cfg: env.cfg, clients: makeClients(env.cfg), wallet };
}

describe("state reads (DESIGN §8.1)", () => {
  it("not whitelisted anywhere → closed; quotas and limits come from chain", async () => {
    const st = await readBridgeState(env.cfg, makeClients(env.cfg), KEYS.alice.address);
    expect(st.wl).toBe("closed");
    expect(st.wantos.paused).toBe(false);
    expect(st.w2bRemaining).toBe(2000n * U);
    expect(st.wantos.w2bMinAmount).toBe(10n * U);
    expect(st.b2wRemaining).toBe(3000n * U);
    expect(st.bsc.minDeposit).toBe(10n * U);
    expect(st.bsc.maxDepositPerTx).toBe(2000n * U);
    expect(st.wantos.balance).toBe(10_000n * U);
    expect(st.supplyCeilingHit).toBe(false);
  });

  it("whitelisted on one chain only → syncing; both → open", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    expect((await readBridgeState(env.cfg, makeClients(env.cfg), KEYS.alice.address)).wl).toBe("syncing");
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    expect((await readBridgeState(env.cfg, makeClients(env.cfg), KEYS.alice.address)).wl).toBe("open");
  });

  it("paused is reported", async () => {
    await pause(env, env.wantos);
    const st = await readBridgeState(env.cfg, makeClients(env.cfg), KEYS.alice.address);
    expect(st.wantos.paused).toBe(true);
  });
});

describe("W2B bridgeOut (acceptance: 未开通被拒 / 方向一 / 订单状态)", () => {
  it("not whitelisted → rejected with '跨链未开通' before anything is sent", async () => {
    const ctx = ctxFor("wantos");
    const before = await env.wantos.anvil.pc.getTransactionCount({ address: KEYS.alice.address });
    const err = await bridgeOutFlow(ctx, 100n * U, () => {}).catch((e) => e);
    expect(translateError(err, { decimals: 18 }).key).toBe("err.notWhitelisted");
    // simulation fails first: neither approve nor bridgeOut was broadcast
    expect(await env.wantos.anvil.pc.getTransactionCount({ address: KEYS.alice.address })).toBe(before);
  });

  it("whitelisted → exact approve → bridgeOut → order appears → BSC release → completed", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    const ctx = ctxFor("wantos");
    const steps: string[] = [];
    const amt = 150n * U;
    const res = await bridgeOutFlow(ctx, amt, (s) => steps.push(s));
    expect(res.orderId).toBe(1n);
    expect(steps).toEqual(["approve", "confirming", "send", "confirming"]);

    // the approve transaction carried exactly the amount, never MaxUint256
    const approveTx = await env.wantos.anvil.pc.getTransaction({ hash: res.approveTxHash! });
    expect(approveTx.to?.toLowerCase()).toBe(env.wantos.usdt.toLowerCase());
    const dec = decodeFunctionData({ abi: erc20Abi, data: approveTx.input });
    expect(dec.functionName).toBe("approve");
    expect(dec.args).toEqual([env.wantos.bridge, amt]);
    expect(dec.args[1]).not.toBe(maxUint256);
    // allowance fully consumed
    expect(
      await env.wantos.anvil.pc.readContract({ address: env.wantos.usdt, abi: erc20Abi, functionName: "allowance", args: [KEYS.alice.address, env.wantos.bridge] }),
    ).toBe(0n);

    const sp = new ChainStatusProvider(env.cfg, makeClients(env.cfg));
    let orders = await sp.list(KEYS.alice.address);
    expect(orders).toEqual([expect.objectContaining({ direction: "W2B", id: 1n, amount: amt, status: "processing", srcTxHash: res.txHash })]);

    const st = await readBridgeState(env.cfg, makeClients(env.cfg), KEYS.alice.address);
    expect(st.w2bRemaining).toBe(2000n * U - amt);

    await relayerRelease(env, 1n, KEYS.alice.address, amt);
    orders = await sp.list(KEYS.alice.address);
    expect(orders[0]!.status).toBe("completed");
  });

  it("quota used up → validation / chain both refuse", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    const ctx = ctxFor("wantos");
    await bridgeOutFlow(ctx, 2000n * U, () => {});
    const st = await readBridgeState(env.cfg, makeClients(env.cfg), KEYS.alice.address);
    expect(st.w2bRemaining).toBe(0n);
    const err = await bridgeOutFlow(ctx, 10n * U, () => {}).catch((e) => e);
    expect(translateError(err, { decimals: 18 }).key).toBe("err.addrDailyCapExceeded");
  });

  it("paused → EnforcedPause translated to maintenance", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await pause(env, env.wantos);
    const err = await bridgeOutFlow(ctxFor("wantos"), 100n * U, () => {}).catch((e) => e);
    expect(translateError(err, { decimals: 18 }).key).toBe("err.paused");
  });

  it("existing sufficient allowance is reused (no new approval)", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    const ctx = ctxFor("wantos");
    await ctx.wallet.writeContract({ address: env.wantos.usdt, abi: erc20Abi, functionName: "approve", args: [env.wantos.bridge, 100n * U] });
    const steps: string[] = [];
    const res = await bridgeOutFlow(ctx, 100n * U, (s) => steps.push(s));
    expect(res.approveTxHash).toBeNull();
    expect(steps).toEqual(["send", "confirming"]);
  });
});

describe("B2W deposit (acceptance: 方向二 / 订单状态)", () => {
  it("deposit → awaiting credit → WANTOS release → completed", async () => {
    const ctx = ctxFor("bsc");
    const amt = 300n * U;
    const res = await depositFlow(ctx, amt, KEYS.alice.address, () => {});
    expect(res.nonce).toBe(1n);
    const approveTx = await env.bsc.anvil.pc.getTransaction({ hash: res.approveTxHash! });
    expect(decodeFunctionData({ abi: erc20Abi, data: approveTx.input }).args).toEqual([env.bsc.bridge, amt]);

    const sp = new ChainStatusProvider(env.cfg, makeClients(env.cfg));
    let orders = await sp.list(KEYS.alice.address);
    expect(orders).toEqual([expect.objectContaining({ direction: "B2W", id: 1n, amount: amt, status: "awaitingCredit", recipient: KEYS.alice.address })]);

    await relayerCredit(env, 1n, KEYS.alice.address, amt);
    orders = await sp.list(KEYS.alice.address);
    expect(orders[0]!.status).toBe("completed");
  });

  it("deposit to a different WANTOS recipient: the chain records that recipient (A1)", async () => {
    const ctx = ctxFor("bsc");
    const res = await depositFlow(ctx, 40n * U, KEYS.bob.address, () => {});
    const r = await env.bsc.anvil.pc.getTransactionReceipt({ hash: res.txHash });
    const ev = parseEventLogs({ abi: bscVaultV2Abi, logs: r.logs, eventName: "Deposited" });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.args.from).toBe(KEYS.alice.address);
    expect(ev[0]!.args.wantosRecipient).toBe(KEYS.bob.address);
    // and the order view shows bob as recipient while it is listed for the depositor
    const orders = await new ChainStatusProvider(env.cfg, makeClients(env.cfg)).list(KEYS.alice.address);
    expect(orders[0]).toEqual(expect.objectContaining({ direction: "B2W", recipient: KEYS.bob.address }));
  });

  it("zero recipient refused locally with zero transactions sent (A4); amount limits enforced", async () => {
    const ctx = ctxFor("bsc");
    const before = await env.bsc.anvil.pc.getTransactionCount({ address: KEYS.alice.address });
    const z = await depositFlow(ctx, 100n * U, "0x0000000000000000000000000000000000000000" as Address, () => {}).catch((e) => e);
    expect(translateError(z, { decimals: 18 }).key).toBe("err.zeroAddress");
    expect(await env.bsc.anvil.pc.getTransactionCount({ address: KEYS.alice.address })).toBe(before);
    const big = await depositFlow(ctx, 2001n * U, KEYS.alice.address, () => {}).catch((e) => e);
    expect(translateError(big, { decimals: 18 })).toEqual({ key: "err.amountAboveLimit", params: { amount: "2,001", limit: "2,000" } });
  });
});

describe("B2W preflight also checks the WANTOS side (review finding 7)", () => {
  it("WANTOS paused → deposit refused before any tx", async () => {
    await pause(env, env.wantos);
    const before = await env.bsc.anvil.pc.getTransactionCount({ address: KEYS.alice.address });
    const err = await depositFlow(ctxFor("bsc"), 100n * U, KEYS.alice.address, () => {}).catch((e) => e);
    expect(translateError(err, { decimals: 18 }).key).toBe("err.paused");
    expect(await env.bsc.anvil.pc.getTransactionCount({ address: KEYS.alice.address })).toBe(before);
  });
});

describe("preflights refuse before any transaction (A2 / B6)", () => {
  async function zeroTx(side: "wantos" | "bsc", run: () => Promise<unknown>, key: string) {
    const pc = env[side].anvil.pc;
    const before = await pc.getTransactionCount({ address: KEYS.alice.address });
    const err = await run().catch((e) => e);
    expect(translateError(err, { decimals: 18 }).key).toBe(key);
    expect(await pc.getTransactionCount({ address: KEYS.alice.address })).toBe(before);
  }

  it("deposit: BSC paused", async () => {
    await pause(env, env.bsc);
    await zeroTx("bsc", () => depositFlow(ctxFor("bsc"), 100n * U, KEYS.alice.address, () => {}), "err.paused");
  });

  it("deposit: WANTOS inbound daily cap would be exceeded", async () => {
    await relayerQueue(env, 999n, KEYS.bob.address, 2950n * U);
    await zeroTx("bsc", () => depositFlow(ctxFor("bsc"), 100n * U, KEYS.alice.address, () => {}), "err.dailyCapExceeded");
  });

  it("bridgeOut: supplyCeiling exceeded", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    await mintWantosUsdt(env, KEYS.bob.address, 20_000n * U);
    await zeroTx("wantos", () => bridgeOutFlow(ctxFor("wantos"), 100n * U, () => {}), "err.supplyCeiling");
  });

  it("bridgeOut: BSC (payout side) paused (B6)", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    await pause(env, env.bsc);
    await zeroTx("wantos", () => bridgeOutFlow(ctxFor("wantos"), 100n * U, () => {}), "err.paused");
  });
});

describe("target allow-list is enforced before the wallet is asked", () => {
  it("sendGuarded refuses a non-allowed address and sends nothing", async () => {
    const ctx = ctxFor("wantos");
    const before = await env.wantos.anvil.pc.getTransactionCount({ address: KEYS.alice.address });
    const err = await sendGuarded(ctx, env.cfg.wantos.id, {
      address: KEYS.bob.address,
      abi: erc20Abi,
      functionName: "transfer",
      args: [KEYS.bob.address, 1n],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TargetNotAllowedError);
    expect(await env.wantos.anvil.pc.getTransactionCount({ address: KEYS.alice.address })).toBe(before);
  });

  it("sendGuarded refuses when the wallet is on the other chain", async () => {
    const ctx = ctxFor("bsc");
    const err = await sendGuarded(ctx, env.cfg.wantos.id, {
      address: env.wantos.usdt,
      abi: erc20Abi,
      functionName: "approve",
      args: [env.wantos.bridge, 1n],
    }).catch((e) => e);
    expect(translateError(err, { decimals: 18 }).key).toBe("err.wrongNetwork");
  });
});
