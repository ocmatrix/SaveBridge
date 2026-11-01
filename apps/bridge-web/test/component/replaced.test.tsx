/** Round-3 B1: a hash that will never get a receipt (sped-up / replaced / dropped by the wallet). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { createWalletClient, erc20Abi, http, type Hex } from "viem";
import { KEYS, startEnv, whitelist, snapshot, type Env } from "../support/anvil";
import { renderApp } from "./renderApp";
import { T, connect, panel, typeAmount } from "./helpers";
import { pendingKey, savePending } from "../../src/lib/pendingTx";

let env: Env;
let revert: () => Promise<void>;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(() => env?.stop());
beforeEach(async () => {
  revert = await snapshot(env);
  sessionStorage.clear();
  await whitelist(env, env.wantos, [KEYS.alice.address]);
  await whitelist(env, env.bsc, [KEYS.alice.address]);
  // alice's nonce 0 is used by some other transaction (the "replacement")
  const w = createWalletClient({ chain: env.wantos.anvil.chain, transport: http(env.wantos.anvil.url), account: KEYS.alice });
  await env.wantos.anvil.pc.waitForTransactionReceipt({
    hash: await w.writeContract({ address: env.wantos.usdt, abi: erc20Abi, functionName: "approve", args: [env.wantos.bridge, 1n] }),
  });
});
afterEach(async () => {
  cleanup();
  sessionStorage.clear();
  await revert();
});

const GONE = `0x${"ee".repeat(32)}` as Hex; // not on chain

async function open(nonce: number | null) {
  savePending(sessionStorage, {
    [pendingKey(KEYS.alice.address, 13555, "w2b")]: { account: KEYS.alice.address, chainId: 13555, action: "w2b", hash: GONE, kind: "send", nonce },
  });
  renderApp(env.cfg, KEYS.alice.address);
  const user = await connect();
  const w2b = panel("WANTOS → BSC");
  await screen.findByText(/本地址今日可跨出/, {}, T);
  await typeAmount(user, w2b, "100");
  await user.click(within(w2b).getByRole("button", { name: "重新检查" }));
  return { user, w2b, btn: within(w2b).getByRole("button", { name: "跨出" }) };
}

describe("replaced / dropped transactions (B1)", () => {
  it("tx unknown to the node and its nonce already used → 'may have been replaced or dropped' + manual unlock with a second confirmation", async () => {
    const { user, w2b, btn } = await open(0);
    await within(w2b).findByText("这笔交易可能已被替换或丢弃，请在钱包中核对后再决定是否重新提交", {}, T);
    expect(btn).toBeDisabled();
    await user.click(within(w2b).getByRole("button", { name: "手动解除锁" }));
    expect(btn).toBeDisabled(); // first click only asks
    await user.click(within(w2b).getByRole("button", { name: "确认解除" }));
    await waitFor(() => expect(btn).toBeEnabled(), T);
    expect(within(w2b).queryByText(new RegExp(GONE))).toBeNull();
  });

  it("nonce not used yet → still 'not found yet', no manual unlock offered", async () => {
    const { w2b, btn } = await open(5);
    await within(w2b).findByText("还没有查到这笔交易的结果，请稍后再检查", {}, T);
    expect(within(w2b).queryByRole("button", { name: "手动解除锁" })).toBeNull();
    expect(btn).toBeDisabled();
  });

  it("nonce unknown → still 'not found yet', no manual unlock offered", async () => {
    const { w2b } = await open(null);
    await within(w2b).findByText("还没有查到这笔交易的结果，请稍后再检查", {}, T);
    expect(within(w2b).queryByRole("button", { name: "手动解除锁" })).toBeNull();
  });
});
