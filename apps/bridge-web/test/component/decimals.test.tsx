import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PublicClient } from "viem";
import { KEYS, U, startEnv, whitelist, snapshot, type Env } from "../support/anvil";
import { renderApp } from "./renderApp";
import { makeClients, type Clients } from "../../src/lib/clients";
import type { StatusProvider } from "../../src/lib/statusProvider";

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

/** BSC client whose USDT reports 6 decimals (WANTOS stays 18). */
function mismatched(): Clients {
  const c = makeClients(env.cfg);
  const bsc = c.bsc;
  const readContract = ((args: { address: string; functionName: string }) =>
    args.functionName === "decimals" && args.address.toLowerCase() === env.cfg.bsc.usdt.toLowerCase()
      ? Promise.resolve(6)
      : bsc.readContract(args as never)) as PublicClient["readContract"];
  return { wantos: c.wantos, bsc: { ...bsc, readContract } as PublicClient };
}

const orders: StatusProvider = {
  list: vi.fn().mockResolvedValue([{ direction: "W2B", id: 3n, amount: 100n * U, status: "processing", srcTxHash: null, dstTxHash: null }]),
};

async function openW2B(clients?: Clients) {
  renderApp(env.cfg, KEYS.alice.address, { statusProvider: orders, ...(clients ? { clients } : {}) });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "连接钱包" }));
  await user.click(await screen.findByRole("button", { name: "Mock Connector" }));
  await screen.findByRole("button", { name: "断开" }, T);
  const w2b = screen.getByRole("region", { name: "WANTOS → BSC" });
  await user.type(within(w2b).getByLabelText("金额（USDT）"), "100");
  return within(w2b).getByRole("button", { name: "跨出" });
}

describe("USDT decimals differ between chains (A3 / M11b)", () => {
  it("control: same decimals → enabled, orders listed", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    const btn = await openW2B();
    await waitFor(() => expect(btn).toBeEnabled(), T);
    expect(await screen.findByRole("region", { name: "我的订单" }, T)).toBeInTheDocument();
  });

  it("different decimals → page stops: notice, button disabled, order list hidden", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    const btn = await openW2B(mismatched());
    expect(await screen.findByText("两条链 USDT 精度不一致，页面已停用，请联系客服", {}, T)).toBeInTheDocument();
    expect(btn).toBeDisabled();
    expect(screen.queryByRole("region", { name: "我的订单" })).toBeNull();
    expect(screen.queryByText(/本地址今日可跨出/)).toBeNull();
  });
});
