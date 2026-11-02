/** Round-3 B5: if BSC paused() cannot be read, nothing is sent and the page says so (fail closed). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { HttpRequestError, createWalletClient, http, type PublicClient } from "viem";
import { KEYS, U, startEnv, whitelist, snapshot, type Env } from "../support/anvil";
import { renderApp } from "./renderApp";
import { T, connect, panel, typeAmount } from "./helpers";
import { makeClients, type Clients } from "../../src/lib/clients";
import { bridgeOutFlow } from "../../src/lib/flows";

let env: Env;
let revert: () => Promise<void>;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(() => env?.stop());
beforeEach(async () => {
  revert = await snapshot(env);
  await whitelist(env, env.wantos, [KEYS.alice.address]);
  await whitelist(env, env.bsc, [KEYS.alice.address]);
});
afterEach(async () => {
  cleanup();
  await revert();
});

/** BSC RPC answers everything except the bridge's paused() view. */
function bscPausedUnreadable(): Clients {
  const c = makeClients(env.cfg);
  const bsc = c.bsc;
  const readContract = ((args: { functionName: string }) =>
    args.functionName === "paused" ? Promise.reject(new HttpRequestError({ url: "bsc", details: "down" })) : bsc.readContract(args as never)) as PublicClient["readContract"];
  return { wantos: c.wantos, bsc: { ...bsc, readContract } as PublicClient };
}

describe("BSC paused() unreadable (B5)", () => {
  it("bridgeOutFlow sends nothing", async () => {
    const wallet = createWalletClient({ chain: env.wantos.anvil.chain, transport: http(env.wantos.anvil.url), account: KEYS.alice });
    const before = await env.wantos.anvil.pc.getTransactionCount({ address: KEYS.alice.address });
    const err = await bridgeOutFlow({ cfg: env.cfg, clients: bscPausedUnreadable(), wallet }, 100n * U, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(await env.wantos.anvil.pc.getTransactionCount({ address: KEYS.alice.address })).toBe(before);
  });

  it("the page shows the read error with a refresh button and keeps bridge-out disabled", async () => {
    renderApp(env.cfg, KEYS.alice.address, { clients: bscPausedUnreadable() });
    const user = await connect();
    await screen.findByText(/读取链上数据失败/, {}, T);
    expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument();
    const w2b = panel("WANTOS → BSC");
    await typeAmount(user, w2b, "100");
    expect(within(w2b).getByRole("button", { name: "跨出" })).toBeDisabled();
  });
});
