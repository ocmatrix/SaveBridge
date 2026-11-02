/**
 * Every "button disabled" protection is tested with the same pattern (Gate-2 round 1, A2):
 * first the identical situation WITHOUT the blocker (valid amount, right network) → button enabled;
 * then the blocker is triggered on chain → the page refreshes → button disabled + the specific notice.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { switchChain } from "wagmi/actions";
import {
  KEYS,
  U,
  startEnv,
  whitelist,
  pause,
  snapshot,
  relayerQueue,
  mintWantosUsdt,
  bridgeOutDirect,
  type Env,
} from "../support/anvil";
import { renderApp } from "./renderApp";
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
const panel = (name: string) => screen.getByRole("region", { name });

async function connect() {
  const user = userEvent.setup();
  await waitConnected();
  return user;
}

/** W2B ready: whitelisted on both chains, wallet on WANTOS, valid amount typed, button enabled. */
async function readyW2B(amount = "100") {
  await whitelist(env, env.wantos, [KEYS.alice.address]);
  await whitelist(env, env.bsc, [KEYS.alice.address]);
  const r = renderApp(env.cfg, KEYS.alice.address);
  const user = await connect();
  await screen.findByText(/今日剩余额度/, {}, T);
  const w2b = panel("WANTOS → BSC");
  await user.type(within(w2b).getByLabelText("金额（USDT）"), amount);
  const btn = submit(w2b);
  await waitFor(() => expect(btn).toBeEnabled(), T);
  return { ...r, user, w2b, btn };
}

/** B2W ready: wallet switched to BSC, valid amount typed, button enabled. */
async function readyB2W(amount = "100") {
  const r = renderApp(env.cfg, KEYS.alice.address);
  const user = await connect();
  await user.click(screen.getByRole("button", { name: "切换方向" }));
  const b2w = panel("BSC → WANTOS");
  await waitFor(() => expect(within(b2w).queryByText("当前网络不是 BSC，请切换")).toBeNull(), T);
  await user.type(within(b2w).getByLabelText("金额（USDT）"), amount);
  const btn = submit(b2w);
  await waitFor(() => expect(btn).toBeEnabled(), T);
  return { ...r, user, b2w, btn };
}

/** The blocker notice itself (not only the amount-validation message) must be shown. */
function expectNotice(scope: HTMLElement, text: string) {
  const els = within(scope).getAllByText(text);
  expect(els.some((e) => e.classList.contains("bar") || e.classList.contains("notice"))).toBe(true);
}

async function refresh(qc: { invalidateQueries(): Promise<void> }) {
  await act(async () => {
    await qc.invalidateQueries();
  });
}

describe("W2B blockers (enabled first, then blocked)", () => {
  it("WANTOS paused", async () => {
    const { queryClient, w2b, btn } = await readyW2B();
    await pause(env, env.wantos);
    await refresh(queryClient);
    await waitFor(() => expect(btn).toBeDisabled(), T);
    expectNotice(w2b, "跨链桥维护中，暂停操作，请稍后再试");
  });

  it("BSC paused (B6: payout side paused → funds would sit locked on WANTOS)", async () => {
    const { queryClient, w2b, btn } = await readyW2B();
    await pause(env, env.bsc);
    await refresh(queryClient);
    await waitFor(() => expect(btn).toBeDisabled(), T);
    expectNotice(w2b, "跨链桥维护中，暂停操作，请稍后再试");
  });

  it("enabled on WANTOS only (BSC whitelist removed) → 开通同步中 (deviation 1)", async () => {
    const { queryClient, w2b, btn } = await readyW2B();
    await whitelist(env, env.bsc, [KEYS.alice.address], false);
    await refresh(queryClient);
    await waitFor(() => expect(btn).toBeDisabled(), T);
    expectNotice(w2b, "开通同步中，请稍后刷新");
  });

  it("not enabled on either chain → 未开通跨出", async () => {
    const { queryClient, w2b, btn } = await readyW2B();
    await whitelist(env, env.wantos, [KEYS.alice.address], false);
    await whitelist(env, env.bsc, [KEYS.alice.address], false);
    await refresh(queryClient);
    await waitFor(() => expect(btn).toBeDisabled(), T);
    expectNotice(w2b, "未开通跨出，请联系客服");
  });

  it("supplyCeiling exceeded", async () => {
    const { queryClient, w2b, btn } = await readyW2B();
    await mintWantosUsdt(env, KEYS.bob.address, 20_000n * U);
    await refresh(queryClient);
    await waitFor(() => expect(btn).toBeDisabled(), T);
    expectNotice(w2b, "WANTOS-USDT 发行量超过安全上限，跨出暂停，请稍后再试");
  });

  it("per-address daily quota used up", async () => {
    const { queryClient, w2b, btn } = await readyW2B("10");
    await bridgeOutDirect(env, KEYS.alice, 1995n * U);
    await refresh(queryClient);
    await waitFor(() => expect(btn).toBeDisabled(), T);
    expectNotice(w2b, "今日额度已用完，请明天（UTC 0 点后）再试");
  });

  it("wallet moved to the other chain → switched back on its own, button enabled again", async () => {
    const { wagmiConfig, btn } = await readyW2B();
    await act(async () => {
      await switchChain(wagmiConfig, { chainId: 56 });
    });
    await waitFor(() => expect(wagmiConfig.state.chainId).toBe(13555), T);
    await waitFor(() => expect(btn).toBeEnabled(), T);
  });
});

describe("B2W blockers (enabled first, then blocked)", () => {
  it("only BSC paused", async () => {
    const { queryClient, b2w, btn } = await readyB2W();
    await pause(env, env.bsc);
    await refresh(queryClient);
    await waitFor(() => expect(btn).toBeDisabled(), T);
    expectNotice(b2w, "跨链桥维护中，暂停操作，请稍后再试");
  });

  it("only WANTOS paused", async () => {
    const { queryClient, b2w, btn } = await readyB2W();
    await pause(env, env.wantos);
    await refresh(queryClient);
    await waitFor(() => expect(btn).toBeDisabled(), T);
    expectNotice(b2w, "跨链桥维护中，暂停操作，请稍后再试");
  });

  it("WANTOS inbound daily cap used up", async () => {
    const { queryClient, b2w, btn } = await readyB2W("10");
    await relayerQueue(env, 999n, KEYS.bob.address, 2995n * U);
    await refresh(queryClient);
    await waitFor(() => expect(btn).toBeDisabled(), T);
    expectNotice(b2w, "今日额度已用完，请明天（UTC 0 点后）再试");
  });

  it("amount above WANTOS inbound remaining (not exhausted)", async () => {
    const { queryClient, b2w, btn } = await readyB2W("100");
    await relayerQueue(env, 999n, KEYS.bob.address, 2950n * U);
    await refresh(queryClient);
    await waitFor(() => expect(btn).toBeDisabled(), T);
    expect(within(b2w).getByText("超过今日剩余额度 50 USDT")).toBeInTheDocument();
  });
});
