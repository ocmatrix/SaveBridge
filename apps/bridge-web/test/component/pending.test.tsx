/** Round-2 A1: the unconfirmed-transaction lock lives at page level, per account+chain+action, survives tab switch and reload. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import type { Hex } from "viem";
import { KEYS, startEnv, whitelist, snapshot, type Env } from "../support/anvil";
import { renderApp } from "./renderApp";
import { T, connect, flaky, panel, typeAmount } from "./helpers";

let env: Env;
let revert: () => Promise<void>;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(() => env?.stop());
beforeEach(async () => {
  revert = await snapshot(env);
  sessionStorage.clear();
  await whitelist(env, env.wantos, [KEYS.alice.address, KEYS.bob.address]);
  await whitelist(env, env.bsc, [KEYS.alice.address, KEYS.bob.address]);
});
afterEach(async () => {
  cleanup();
  sessionStorage.clear();
  await revert();
});

const hashIn = (el: HTMLElement) => el.textContent!.match(/0x[0-9a-f]{64}/)![0] as Hex;

/** Alice submits a W2B whose bridgeOut receipt times out → pending lock. */
async function alicePending(okWaits = 1) {
  const r = renderApp(env.cfg, [KEYS.alice.address, KEYS.bob.address], { clients: flaky(env.cfg, "wantos", okWaits) });
  const user = await connect();
  await screen.findByText(/本地址今日可跨出/, {}, T);
  const w2b = panel("WANTOS → BSC");
  await typeAmount(user, w2b, "100");
  const btn = within(w2b).getByRole("button", { name: "跨出" });
  await waitFor(() => expect(btn).toBeEnabled(), T);
  await user.click(btn);
  const msg = await within(w2b).findByText(/暂未确认结果/, {}, T);
  return { ...r, user, hash: hashIn(msg) };
}

describe("unconfirmed lock scope (A1)", () => {
  it("survives switching tabs: still disabled, hash still shown", async () => {
    const { user, hash } = await alicePending();
    await user.click(screen.getByRole("tab", { name: "BSC → WANTOS" }));
    await user.click(screen.getByRole("tab", { name: "WANTOS → BSC" }));
    const w2b = panel("WANTOS → BSC");
    expect(within(w2b).getByText(new RegExp(hash))).toBeInTheDocument();
    await typeAmount(user, w2b, "100");
    expect(within(w2b).getByRole("button", { name: "跨出" })).toBeDisabled();
  });

  it("is per account: another account is not blocked and does not see the hash; switching back restores it", async () => {
    const { user, hash, wagmiConfig } = await alicePending();
    const connector = wagmiConfig.connectors[0]!;
    await act(async () => {
      connector.emitter.emit("change", { accounts: [KEYS.bob.address] });
    });
    const w2b = panel("WANTOS → BSC");
    await waitFor(() => expect(within(w2b).queryByText(new RegExp(hash))).toBeNull(), T);
    await typeAmount(user, w2b, "100");
    await waitFor(() => expect(within(w2b).getByRole("button", { name: "跨出" })).toBeEnabled(), T);
    await act(async () => {
      connector.emitter.emit("change", { accounts: [KEYS.alice.address] });
    });
    await within(w2b).findByText(new RegExp(hash), {}, T);
    expect(within(w2b).getByRole("button", { name: "跨出" })).toBeDisabled();
  });

  it("survives a reload (unmount + remount reading session storage)", async () => {
    const { hash } = await alicePending();
    cleanup();
    renderApp(env.cfg, [KEYS.alice.address, KEYS.bob.address]);
    const user = await connect();
    const w2b = panel("WANTOS → BSC");
    await within(w2b).findByText(new RegExp(hash), {}, T);
    await screen.findByText(/本地址今日可跨出/, {}, T);
    await typeAmount(user, w2b, "100");
    expect(within(w2b).getByRole("button", { name: "跨出" })).toBeDisabled();
  });

  it("an unconfirmed APPROVE, once confirmed, says 'approval confirmed, submit again' — never 交易已确认", async () => {
    const { user } = await alicePending(0); // the approve receipt times out
    const w2b = panel("WANTOS → BSC");
    await user.click(within(w2b).getByRole("button", { name: "重新检查" }));
    await within(w2b).findByText("授权已确认，请再次点击提交以完成跨链", {}, T);
    expect(w2b.textContent).not.toContain("交易已确认");
    await waitFor(() => expect(within(w2b).getByRole("button", { name: "跨出" })).toBeEnabled(), T);
  });
});
