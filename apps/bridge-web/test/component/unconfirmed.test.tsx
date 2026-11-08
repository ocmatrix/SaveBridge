import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WaitForTransactionReceiptTimeoutError, type Hex, type PublicClient } from "viem";
import { KEYS, startEnv, whitelist, snapshot, type Env } from "../support/anvil";
import { renderApp } from "./renderApp";
import { makeClients, type Clients } from "../../src/lib/clients";
import { submit, waitConnected } from "./helpers";

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
  cleanup();
  await revert();
});
const T = { timeout: 15_000 };

function flaky(okWaits: number): Clients {
  const base = makeClients(env.cfg);
  let n = 0;
  const pc = base.wantos;
  const waitForTransactionReceipt = (async (args: { hash: Hex }) => {
    if (n++ < okWaits) return pc.waitForTransactionReceipt(args);
    throw new WaitForTransactionReceiptTimeoutError({ hash: args.hash });
  }) as PublicClient["waitForTransactionReceipt"];
  return { ...base, wantos: { ...pc, waitForTransactionReceipt } as PublicClient };
}

describe("broadcast but unconfirmed (B1)", () => {
  it("shows the hash as submitted-pending, blocks resubmission until re-checked, never says failed", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    renderApp(env.cfg, KEYS.alice.address, { clients: flaky(1) });
    const user = userEvent.setup();
    await waitConnected();
    const w2b = screen.getByRole("region", { name: "WANTOS → BSC" });
    await screen.findByText(/余额：/, {}, T);
    await user.type(within(w2b).getByLabelText("金额（USDT）"), "100");
    const btn = submit(w2b);
    await waitFor(() => expect(btn).toBeEnabled(), T);
    await user.click(btn);

    const msg = await within(w2b).findByText(/暂未确认结果/, {}, T);
    const hash = msg.textContent!.match(/0x[0-9a-f]{64}/)![0] as Hex;
    expect((await env.wantos.anvil.pc.getTransactionReceipt({ hash })).status).toBe("success");
    expect(w2b.textContent).not.toMatch(/失败|重试/);
    expect(within(w2b).getByRole("link", { name: "在浏览器核对" })).toHaveAttribute("href", `${env.cfg.wantos.explorerUrl}/tx/${hash}`);
    // amount is still valid, but the same action stays locked until the user re-checks
    expect(btn).toBeDisabled();

    await user.click(within(w2b).getByRole("button", { name: "重新检查" }));
    await within(w2b).findByText("交易已确认", {}, T);
    await waitFor(() => expect(within(w2b).queryByText(/暂未确认结果/)).toBeNull(), T);
  });
});
