import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { App } from "../../src/App";
import { createWagmiConfig } from "../../src/wallet/wagmi";
import { makeClients } from "../../src/lib/clients";
import { ChainStatusProvider } from "../../src/lib/statusProvider";
import userEvent from "@testing-library/user-event";
import { KEYS, U, startEnv, whitelist, snapshot, relayerRelease, type Env } from "../support/anvil";
import { renderApp } from "./renderApp";
import type { StatusProvider } from "../../src/lib/statusProvider";
import { bscVaultV2Abi } from "@bridge/abi";
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

async function connect(user = userEvent.setup()) {
  await waitConnected();
  return user;
}

const panel = (name: string) => screen.getByRole("region", { name });

describe("user page (DESIGN §8.1, §13 PR-5 acceptance)", () => {
  it("not whitelisted → '未开通跨出，请联系客服' and bridge-out disabled", async () => {
    renderApp(env.cfg, KEYS.alice.address);
    await connect();
    expect(await screen.findAllByText("未开通跨出，请联系客服", {}, T)).not.toHaveLength(0);
    const w2b = panel("WANTOS → BSC");
    await userEvent.type(within(w2b).getByLabelText("金额（USDT）"), "100");
    expect(submit(w2b)).toBeDisabled();
  });

  it("whitelisted → full W2B through the UI: exact approve, bridgeOut, order shows 处理中 then 已到账", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    const { queryClient } = renderApp(env.cfg, KEYS.alice.address);
    const user = await connect();
    const w2b = panel("WANTOS → BSC");
    await screen.findByText(/今日剩余额度 2,000 USDT/, {}, T);
    await user.type(within(w2b).getByLabelText("金额（USDT）"), "123.5");
    const btn = submit(w2b);
    await waitFor(() => expect(btn).toBeEnabled(), T);
    expect(btn).toHaveTextContent("跨出 123.5 USDT");
    await user.click(btn);
    await within(w2b).findByText("已提交，订单 #1", {}, T);
    const orders = await screen.findByRole("region", { name: "我的订单" }, T);
    await within(orders).findByText("WANTOS → BSC 订单 #1", {}, T);
    expect(within(orders).getByText("处理中")).toBeInTheDocument();
    await screen.findByText(/今日剩余额度 1,876.5 USDT/, {}, T);

    await relayerRelease(env, 1n, KEYS.alice.address, 1235n * 10n ** 17n);
    await queryClient.invalidateQueries();
    await within(orders).findByText("已到账", {}, T);
  });

  it("B2W deposit through the UI after switching network: shows awaiting-credit progress", async () => {
    renderApp(env.cfg, KEYS.alice.address);
    const user = await connect();
    await user.click(screen.getByRole("button", { name: "切换方向" }));
    const b2w = panel("BSC → WANTOS");
    // the wallet starts on WANTOS and is switched to BSC on its own
    await waitFor(() => expect(within(b2w).queryByRole("button", { name: "连接 BSC" })).toBeNull(), T);
    await user.click(within(b2w).getByRole("button", { name: "修改" })); // the recipient defaults to the wallet; edit opens the field
    expect(within(b2w).getByLabelText("WANTOS 收款地址")).toHaveValue(KEYS.alice.address);
    expect(within(b2w).getByText("默认为当前地址。请勿填写交易所充值地址。")).toBeInTheDocument();
    await user.type(within(b2w).getByLabelText("金额（USDT）"), "50");
    const btn = submit(b2w);
    await waitFor(() => expect(btn).toBeEnabled(), T);
    await user.click(btn);
    await within(b2w).findByText("已存入，存入编号 #1，等待到账 WANTOS", {}, T);
    const orders = await screen.findByRole("region", { name: "我的订单" }, T);
    await within(orders).findByText("BSC → WANTOS 存入 #1", {}, T);
    expect(within(orders).getByText("BSC 已存入，等待 WANTOS 到账")).toBeInTheDocument();
  });

  it("B2W to another recipient: confirm line shows bob's checksum address and the chain records bob (A1)", async () => {
    renderApp(env.cfg, KEYS.alice.address);
    const user = await connect();
    await user.click(screen.getByRole("button", { name: "切换方向" }));
    const b2w = panel("BSC → WANTOS");
    await waitFor(() => expect(within(b2w).queryByRole("button", { name: "连接 BSC" })).toBeNull(), T);
    await user.click(within(b2w).getByRole("button", { name: "修改" })); // the recipient defaults to the wallet; edit opens the field
    const r = within(b2w).getByLabelText("WANTOS 收款地址");
    await user.clear(r);
    await user.type(r, KEYS.bob.address.toLowerCase());
    await user.type(within(b2w).getByLabelText("金额（USDT）"), "25");
    expect(await within(b2w).findByText(`将存入 25 USDT，到账 WANTOS 地址：${KEYS.bob.address}`)).toBeInTheDocument();
    const btn = submit(b2w);
    await waitFor(() => expect(btn).toBeEnabled(), T);
    await user.click(btn);
    await within(b2w).findByText("已存入，存入编号 #1，等待到账 WANTOS", {}, T);
    const logs = await env.bsc.anvil.pc.getContractEvents({ address: env.bsc.bridge, abi: bscVaultV2Abi, eventName: "Deposited", fromBlock: 0n });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.args.from).toBe(KEYS.alice.address);
    expect(logs[0]!.args.wantosRecipient).toBe(KEYS.bob.address);
  });

  it("B2W rejects an invalid / zero recipient", async () => {
    renderApp(env.cfg, KEYS.alice.address);
    const user = await connect();
    await user.click(screen.getByRole("button", { name: "切换方向" }));
    const b2w = panel("BSC → WANTOS");
    await waitFor(() => expect(within(b2w).queryByRole("button", { name: "连接 BSC" })).toBeNull(), T);
    await user.click(within(b2w).getByRole("button", { name: "修改" })); // the recipient defaults to the wallet; edit opens the field
    const r = within(b2w).getByLabelText("WANTOS 收款地址");
    await user.clear(r);
    await user.type(r, "0x0000000000000000000000000000000000000000");
    await user.type(within(b2w).getByLabelText("金额（USDT）"), "50");
    expect(await within(b2w).findByText("收款地址无效")).toBeInTheDocument();
    expect(submit(b2w)).toBeDisabled();
  });

  it("wallet on the other chain → switched back on its own (both chains work by default)", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    const { wagmiConfig } = renderApp(env.cfg, KEYS.alice.address);
    await connect();
    const { switchChain } = await import("wagmi/actions");
    await switchChain(wagmiConfig, { chainId: 56 });
    await waitFor(() => expect(wagmiConfig.state.chainId).toBe(env.cfg.wantos.id), T);
    await waitFor(() => expect(within(panel("WANTOS → BSC")).queryByRole("button", { name: "连接 WANTOS" })).toBeNull(), T);
  });

  it("switch refused by the wallet → the 连接 pill stays as the fallback and works once the wallet accepts", async () => {
    await whitelist(env, env.wantos, [KEYS.alice.address]);
    await whitelist(env, env.bsc, [KEYS.alice.address]);
    const features: { switchChainError?: boolean } = {};
    const { wagmiConfig } = renderApp(env.cfg, KEYS.alice.address, { mockFeatures: features });
    const user = await connect();
    const { switchChain } = await import("wagmi/actions");
    // from the moment the wallet is on BSC it refuses every further switch (set before the page can react)
    wagmiConfig.subscribe((st) => st.chainId, (id) => { if (id === 56) features.switchChainError = true; });
    await switchChain(wagmiConfig, { chainId: 56 });
    const w2b = panel("WANTOS → BSC");
    expect(await within(w2b).findByRole("button", { name: "连接 WANTOS" }, T)).toBeInTheDocument();
    expect(within(w2b).queryByRole("button", { name: "添加 WANTOS 网络" })).toBeNull();
    expect(submit(w2b)).toBeDisabled();
    features.switchChainError = false;
    await user.click(within(w2b).getByRole("button", { name: "连接 WANTOS" }));
    await waitFor(() => expect(within(w2b).queryByRole("button", { name: "连接 WANTOS" })).toBeNull(), T);
  });

  it("no wallet in the browser → note + the big button reads 连接钱包 and opens the wallet list (EVM wallets: BSC, WANTOS)", async () => {
    const clients = makeClients(env.cfg);
    render(
      <App
        cfg={env.cfg}
        clients={clients}
        wagmiConfig={createWagmiConfig(env.cfg, { storage: null })}
        queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        statusProvider={new ChainStatusProvider(env.cfg, clients)}
        initialLang="zh"
      />,
    );
    expect(await screen.findByText(/未检测到钱包。请点「连接钱包」,或在 SafeBridge 内打开本页。/, {}, T)).toBeInTheDocument();
    const w2b = panel("WANTOS → BSC");
    expect(submit(w2b)).toBeEnabled();
    expect(submit(w2b)).toHaveTextContent("连接钱包");
    expect(screen.queryByRole("dialog", { name: "选择钱包" })).toBeNull();
    await userEvent.click(submit(w2b));
    const list = await screen.findByRole("dialog", { name: "选择钱包" });
    // no extension in jsdom: the generic injected wallet is offered as 浏览器钱包; choosing it explains there is no wallet
    await userEvent.click(within(list).getByRole("button", { name: "浏览器钱包" }));
    expect(await within(list).findByText(/未检测到钱包/, {}, T)).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "选择钱包" })).toBeNull();
  });

  it("brand on top (logo + SafeBridge) and the footer: only Powered by WANTOS (no whitelist sentence) — no contract address", async () => {
    renderApp(env.cfg, KEYS.alice.address);
    expect(screen.getByRole("heading", { level: 1, name: "SafeBridge" })).toBeInTheDocument();
    const footer = screen.getByRole("contentinfo");
    const lines = Array.from(footer.querySelectorAll("small")).map((e) => e.textContent);
    expect(lines).toEqual(["Powered by WANTOS"]);
    expect(footer.textContent).not.toMatch(/0x[0-9a-fA-F]{8}/);
  });

  it("language switch in the footer flips the page to English and back", async () => {
    const user = userEvent.setup();
    renderApp(env.cfg, KEYS.alice.address);
    await user.click(screen.getByRole("button", { name: "English" }));
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement.lang).toBe("en");
    await user.click(screen.getByRole("button", { name: "中文" }));
    expect(within(footer).getByRole("button", { name: "中文" })).toHaveAttribute("aria-pressed", "true");
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
    const orders = await screen.findByRole("region", { name: "我的订单" }, T);
    await within(orders).findByText("WANTOS → BSC 订单 #9", {}, T);
    expect(within(orders).getByText("处理中")).toBeInTheDocument();
    expect(within(orders).getByText("已退款")).toBeInTheDocument();
    expect(orders.textContent).not.toMatch(/REVIEW|HELD|PENDING/);
    expect(sp.list).toHaveBeenCalledWith(KEYS.alice.address, expect.anything());
  });
});
