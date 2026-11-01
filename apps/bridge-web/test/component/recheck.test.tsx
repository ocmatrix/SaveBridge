/** Round-2 A2: the re-check branches and the B2W side of the unconfirmed lock. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { createWalletClient, encodeFunctionData, http, type Hex } from "viem";
import { wantosBridgeV2Abi } from "@bridge/abi";
import { KEYS, startEnv, whitelist, snapshot, type Env } from "../support/anvil";
import { renderApp } from "./renderApp";
import { T, connect, flaky, panel, toBsc, typeAmount } from "./helpers";
import { pendingKey, savePending, type PendingTx } from "../../src/lib/pendingTx";

let env: Env;
let revert: () => Promise<void>;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(() => env?.stop());
beforeEach(async () => {
  revert = await snapshot(env);
  sessionStorage.clear();
});
afterEach(async () => {
  cleanup();
  sessionStorage.clear();
  await revert();
});

function seed(p: PendingTx) {
  savePending(sessionStorage, { [pendingKey(p.account, p.chainId, p.action)]: p });
}

describe("re-check outcomes (A2)", () => {
  it("receipt says REVERTED → 'rejected, you may resubmit', lock released, never '已确认'", async () => {
    // a real reverted transaction on WANTOS: bridgeOut from a not-yet-whitelisted address, gas fixed so it is mined
    const w = createWalletClient({ chain: env.wantos.anvil.chain, transport: http(env.wantos.anvil.url), account: KEYS.alice });
    const hash = await w.sendTransaction({
      to: env.wantos.bridge,
      data: encodeFunctionData({ abi: wantosBridgeV2Abi, functionName: "bridgeOut", args: [10n ** 20n] }),
      gas: 300_000n,
    });
    expect((await env.wantos.anvil.pc.waitForTransactionReceipt({ hash })).status).toBe("reverted");
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    seed({ account: KEYS.alice.address, chainId: 13555, action: "w2b", hash, kind: "send", nonce: null });

    renderApp(env.cfg, KEYS.alice.address);
    const user = await connect();
    const w2b = panel("WANTOS → BSC");
    await within(w2b).findByText(new RegExp(hash), {}, T);
    await screen.findByText(/本地址今日可跨出/, {}, T);
    await typeAmount(user, w2b, "100");
    const btn = within(w2b).getByRole("button", { name: "跨出" });
    expect(btn).toBeDisabled();
    await user.click(within(w2b).getByRole("button", { name: "重新检查" }));
    await within(w2b).findByText("该交易已上链但被合约拒绝，资金未转出，可以重新提交", {}, T);
    expect(w2b.textContent).not.toMatch(/已确认/);
    await waitFor(() => expect(btn).toBeEnabled(), T);
  });

  it("no receipt yet (TransactionReceiptNotFoundError) → 'not found yet', still locked", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    const hash = `0x${"cd".repeat(32)}` as Hex; // never broadcast on this chain
    seed({ account: KEYS.alice.address, chainId: 13555, action: "w2b", hash, kind: "send", nonce: null });
    renderApp(env.cfg, KEYS.alice.address);
    const user = await connect();
    const w2b = panel("WANTOS → BSC");
    await screen.findByText(/本地址今日可跨出/, {}, T);
    await typeAmount(user, w2b, "100");
    await user.click(within(w2b).getByRole("button", { name: "重新检查" }));
    await within(w2b).findByText("还没有查到这笔交易的结果，请稍后再检查", {}, T);
    expect(within(w2b).getByText(new RegExp(hash))).toBeInTheDocument();
    expect(within(w2b).getByRole("button", { name: "跨出" })).toBeDisabled();
  });
});

describe("B2W unconfirmed (A2, symmetric to W2B)", () => {
  it("hash shown in role=status before any receipt; then locked with a BSC-explorer link", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const waiting = new Promise<void>((r) => (entered = r));
    renderApp(env.cfg, KEYS.alice.address, {
      clients: flaky(env.cfg, "bsc", 1, () => {
        entered(); // the deposit receipt wait has started
        return gate;
      }),
    });
    const user = await connect();
    const b2w = await toBsc(user);
    await typeAmount(user, b2w, "50");
    const btn = within(b2w).getByRole("button", { name: "存入" });
    await waitFor(() => expect(btn).toBeEnabled(), T);
    await user.click(btn);
    // the wallet has returned the deposit hash; the receipt wait is still hanging
    await waiting;
    const status = await within(b2w).findByRole("status", {}, T);
    await waitFor(() => expect(status.textContent).toMatch(/已提交（哈希 0x[0-9a-f]{64}）/), T);
    const hash = status.textContent!.match(/0x[0-9a-f]{64}/)![0];
    // it is the deposit transaction (to the BSC bridge), not the approve
    const tx = await env.bsc.anvil.pc.getTransaction({ hash: hash as Hex });
    expect(tx.to?.toLowerCase()).toBe(env.bsc.bridge.toLowerCase());
    release();
    await within(b2w).findByText(/暂未确认结果/, {}, T);
    expect(within(b2w).getByRole("link", { name: "在浏览器核对" })).toHaveAttribute("href", `${env.cfg.bsc.explorerUrl}/tx/${hash}`);
    await typeAmount(user, b2w, "50");
    expect(btn).toBeDisabled();
  });
});
