import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KEYS, U, startEnv, whitelist, pause, snapshot, relayerRelease, type Env } from "../support/anvil";
import { renderApp } from "./renderApp";
import type { StatusProvider } from "../../src/lib/statusProvider";
import { bscVaultV2Abi } from "@bridge/abi";

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

async function connect(user = userEvent.setup()) {
  await user.click(await screen.findByRole("button", { name: "连接钱包" }));
  await user.click(await screen.findByRole("button", { name: "Mock Connector" }));
  await screen.findByRole("button", { name: "断开" }, T);
  return user;
}

const panel = (name: string) => screen.getByRole("region", { name });

describe("user page (DESIGN §8.1, §13 PR-5 acceptance)", () => {
  it("not whitelisted → '跨链未开通，请联系客服' and bridge-out disabled", async () => {
    renderApp(env.cfg, KEYS.alice.address);
    await connect();
    expect(await screen.findAllByText("跨链未开通，请联系客服", {}, T)).not.toHaveLength(0);
    const w2b = panel("WANTOS → BSC");
    await userEvent.type(within(w2b).getByLabelText("金额（USDT）"), "100");
    expect(within(w2b).getByRole("button", { name: "跨出" })).toBeDisabled();
  });

  it("whitelisted on WANTOS only → '开通同步中' and bridge-out disabled", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    renderApp(env.cfg, KEYS.alice.address);
    await connect();
    expect(await screen.findAllByText("开通同步中，请稍后刷新", {}, T)).not.toHaveLength(0);
    expect(within(panel("WANTOS → BSC")).getByRole("button", { name: "跨出" })).toBeDisabled();
  });

  it("whitelisted → full W2B through the UI: exact approve, bridgeOut, order shows 处理中 then 已到账", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    const { queryClient } = renderApp(env.cfg, KEYS.alice.address);
    const user = await connect();
    const w2b = panel("WANTOS → BSC");
    await screen.findByText("本地址今日可跨出：2,000 USDT", {}, T);
    await user.type(within(w2b).getByLabelText("金额（USDT）"), "123.5");
    const btn = within(w2b).getByRole("button", { name: "跨出" });
    await waitFor(() => expect(btn).toBeEnabled(), T);
    await user.click(btn);
    await within(w2b).findByText("已提交，订单 #1", {}, T);
    const orders = screen.getByRole("region", { name: "我的订单" });
    await within(orders).findByText("WANTOS → BSC 订单 #1", {}, T);
    expect(within(orders).getByText("处理中")).toBeInTheDocument();
    await screen.findByText("本地址今日可跨出：1,876.5 USDT", {}, T);

    await relayerRelease(env, 1n, KEYS.alice.address, 1235n * 10n ** 17n);
    await queryClient.invalidateQueries();
    await within(orders).findByText("已到账", {}, T);
  });

  it("B2W deposit through the UI after switching network: shows awaiting-credit progress", async () => {
    renderApp(env.cfg, KEYS.alice.address);
    const user = await connect();
    await user.click(screen.getByRole("tab", { name: "BSC → WANTOS" }));
    const b2w = panel("BSC → WANTOS");
    // wallet starts on WANTOS → must switch
    expect(await within(b2w).findByText("当前网络不是 BSC，请切换", {}, T)).toBeInTheDocument();
    await user.click(within(b2w).getByRole("button", { name: "切换到 BSC" }));
    await waitFor(() => expect(within(b2w).queryByText("当前网络不是 BSC，请切换")).toBeNull(), T);
    expect(within(b2w).getByLabelText("WANTOS 收款地址")).toHaveValue(KEYS.alice.address);
    expect(within(b2w).getByText("默认为当前地址。请勿填写交易所充值地址。")).toBeInTheDocument();
    await user.type(within(b2w).getByLabelText("金额（USDT）"), "50");
    const btn = within(b2w).getByRole("button", { name: "存入" });
    await waitFor(() => expect(btn).toBeEnabled(), T);
    await user.click(btn);
    await within(b2w).findByText("已存入，存入编号 #1，约 15 分钟到账 WANTOS", {}, T);
    const orders = screen.getByRole("region", { name: "我的订单" });
    await within(orders).findByText("BSC → WANTOS 存入 #1", {}, T);
    expect(within(orders).getByText("BSC 已存入，等待 WANTOS 到账（约 15 分钟）")).toBeInTheDocument();
  });

  it("B2W to another recipient: confirm line shows bob's checksum address and the chain records bob (A1)", async () => {
    renderApp(env.cfg, KEYS.alice.address);
    const user = await connect();
    await user.click(screen.getByRole("tab", { name: "BSC → WANTOS" }));
    const b2w = panel("BSC → WANTOS");
    await user.click(await within(b2w).findByRole("button", { name: "切换到 BSC" }));
    await waitFor(() => expect(within(b2w).queryByText("当前网络不是 BSC，请切换")).toBeNull(), T);
    const r = within(b2w).getByLabelText("WANTOS 收款地址");
    await user.clear(r);
    await user.type(r, KEYS.bob.address.toLowerCase());
    await user.type(within(b2w).getByLabelText("金额（USDT）"), "25");
    expect(await within(b2w).findByText(`将存入 25 USDT，到账 WANTOS 地址：${KEYS.bob.address}`)).toBeInTheDocument();
    const btn = within(b2w).getByRole("button", { name: "存入" });
    await waitFor(() => expect(btn).toBeEnabled(), T);
    await user.click(btn);
    await within(b2w).findByText("已存入，存入编号 #1，约 15 分钟到账 WANTOS", {}, T);
    const logs = await env.bsc.anvil.pc.getContractEvents({ address: env.bsc.bridge, abi: bscVaultV2Abi, eventName: "Deposited", fromBlock: 0n });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.args.from).toBe(KEYS.alice.address);
    expect(logs[0]!.args.wantosRecipient).toBe(KEYS.bob.address);
  });

  it("B2W rejects an invalid / zero recipient", async () => {
    renderApp(env.cfg, KEYS.alice.address);
    const user = await connect();
    await user.click(screen.getByRole("tab", { name: "BSC → WANTOS" }));
    const b2w = panel("BSC → WANTOS");
    await user.click(within(b2w).getByRole("button", { name: "切换到 BSC" }));
    const r = within(b2w).getByLabelText("WANTOS 收款地址");
    await user.clear(r);
    await user.type(r, "0x0000000000000000000000000000000000000000");
    await user.type(within(b2w).getByLabelText("金额（USDT）"), "50");
    expect(await within(b2w).findByText("收款地址无效")).toBeInTheDocument();
    expect(within(b2w).getByRole("button", { name: "存入" })).toBeDisabled();
  });

  it("paused → maintenance notice and both directions disabled", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    await pause(env, env.wantos);
    renderApp(env.cfg, KEYS.alice.address);
    const user = await connect();
    expect(await screen.findAllByText("跨链桥维护中，暂停操作，请稍后再试", {}, T)).not.toHaveLength(0);
    const w2b = panel("WANTOS → BSC");
    await user.type(within(w2b).getByLabelText("金额（USDT）"), "100");
    expect(within(w2b).getByRole("button", { name: "跨出" })).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: "BSC → WANTOS" }));
    expect(within(panel("BSC → WANTOS")).getByRole("button", { name: "存入" })).toBeDisabled();
  });

  it("daily quota used up → 额度已用完 and bridge-out disabled", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    // use the full per-address quota directly on chain
    const { createWalletClient, http, erc20Abi } = await import("viem");
    const { wantosBridgeV2Abi } = await import("@bridge/abi");
    const w = createWalletClient({ chain: env.wantos.anvil.chain, transport: http(env.wantos.anvil.url), account: KEYS.alice });
    await env.wantos.anvil.pc.waitForTransactionReceipt({
      hash: await w.writeContract({ address: env.wantos.usdt, abi: erc20Abi, functionName: "approve", args: [env.wantos.bridge, 2000n * U] }),
    });
    await env.wantos.anvil.pc.waitForTransactionReceipt({
      hash: await w.writeContract({ address: env.wantos.bridge, abi: wantosBridgeV2Abi, functionName: "bridgeOut", args: [2000n * U] }),
    });
    renderApp(env.cfg, KEYS.alice.address);
    const user = await connect();
    expect(await screen.findAllByText("今日额度已用完，请明天（UTC 0 点后）再试", {}, T)).not.toHaveLength(0);
    const w2b = panel("WANTOS → BSC");
    await user.type(within(w2b).getByLabelText("金额（USDT）"), "10");
    expect(within(w2b).getByRole("button", { name: "跨出" })).toBeDisabled();
  });

  it("wrong network → prompt to switch / add WANTOS", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    const { wagmiConfig } = renderApp(env.cfg, KEYS.alice.address);
    const user = await connect();
    const { switchChain } = await import("wagmi/actions");
    await switchChain(wagmiConfig, { chainId: 56 });
    const w2b = panel("WANTOS → BSC");
    expect(await within(w2b).findByText("当前网络不是 WANTOS，请切换", {}, T)).toBeInTheDocument();
    expect(within(w2b).getByRole("button", { name: "添加 WANTOS 网络" })).toBeInTheDocument();
    expect(within(w2b).getByRole("button", { name: "跨出" })).toBeDisabled();
    await user.click(within(w2b).getByRole("button", { name: "切换到 WANTOS" }));
    await waitFor(() => expect(within(w2b).queryByText("当前网络不是 WANTOS，请切换")).toBeNull(), T);
  });

  it("footer always shows both bridge addresses from config", async () => {
    renderApp(env.cfg, KEYS.alice.address);
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getAllByText(env.cfg.wantos.bridge).length).toBeGreaterThan(0);
    expect(within(footer).getAllByText(env.cfg.bsc.bridge).length).toBeGreaterThan(0);
  });

  it("orders come through the replaceable StatusProvider; risk states are shown as 处理中", async () => {
    const sp: StatusProvider = {
      list: vi.fn().mockResolvedValue([
        { direction: "W2B", id: 9n, amount: 100n * U, status: "processing", srcTxHash: null, dstTxHash: null },
        { direction: "W2B", id: 8n, amount: 100n * U, status: "refunded", srcTxHash: null, dstTxHash: null },
      ]),
    };
    renderApp(env.cfg, KEYS.alice.address, { statusProvider: sp });
    await connect();
    const orders = screen.getByRole("region", { name: "我的订单" });
    await within(orders).findByText("WANTOS → BSC 订单 #9", {}, T);
    expect(within(orders).getByText("处理中")).toBeInTheDocument();
    expect(within(orders).getByText("已退款")).toBeInTheDocument();
    expect(orders.textContent).not.toMatch(/REVIEW|HELD|PENDING/);
    expect(sp.list).toHaveBeenCalledWith(KEYS.alice.address, expect.anything());
  });
});
