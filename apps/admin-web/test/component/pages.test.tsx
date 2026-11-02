import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { keccak256, recoverMessageAddress, toBytes, type Hex } from "viem";
import { reviewMessage as relayerReviewMessage } from "../../../../packages/relayer/src/review";
import { readChainState } from "../../src/lib/state";
import { readParams, applyParams } from "../../src/lib/params";
import { U, BSC_ID, localSigner, startWorld, type World } from "../support/world";
import { renderApp } from "./render";

let w: World;
beforeAll(async () => {
  w = await startWorld();
});
afterEach(() => cleanup());
afterAll(async () => w?.stop());

const btn = (name: string | RegExp) => screen.getAllByRole("button", { name });

describe("navigation + role badge", () => {
  it("shows the on-chain role of the connected wallet and navigates", async () => {
    renderApp(w, localSigner(w, w.act.wl));
    expect(await screen.findByTestId("role")).toHaveTextContent("白名单钱包");
    fireEvent.click(screen.getByRole("link", { name: "紧急" }));
    expect(await screen.findByText(/收紧类操作立即生效/)).toBeInTheDocument();
    cleanup();
    renderApp(w, localSigner(w, w.act.stranger));
    expect(await screen.findByTestId("role")).toHaveTextContent("无");
  });
});

describe("emergency page", () => {
  it("non-admin: freeze disabled with reason; WL can pause and unpause", async () => {
    renderApp(w, localSigner(w, w.act.wl), "/emergency");
    await screen.findAllByText(/状态：运行中/);
    expect(btn("冻结白名单写入")[0]).toBeDisabled();
    expect(screen.getAllByText(/当前钱包不是 BSC 的管理钱包/).length).toBeGreaterThan(0);
    fireEvent.click(btn("暂停")[0]!); // BSC
    await waitFor(async () => expect((await readChainState(w.chains.bsc)).paused).toBe(true), { timeout: 10_000 });
    await screen.findByText(/暂停中：BSC/);
    await waitFor(() => expect(btn("解除暂停")[0]).toBeEnabled());
    fireEvent.click(btn("解除暂停")[0]!);
    await waitFor(async () => expect((await readChainState(w.chains.bsc)).paused).toBe(false), { timeout: 10_000 });
  });

  it("admin: emergency remove asks to freeze first", async () => {
    renderApp(w, localSigner(w, w.act.admin), "/emergency");
    fireEvent.change(await screen.findByLabelText("紧急移除地址"), { target: { value: keccak256(toBytes("z")).slice(0, 42) } });
    const b = btn(/在 BSC 上紧急移除 1 个地址/)[0]!;
    await waitFor(() => expect(b).toBeEnabled());
    fireEvent.click(b);
    expect(screen.getByRole("alertdialog")).toHaveTextContent("将先冻结白名单写入");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "确认" }));
    await waitFor(async () => expect((await readChainState(w.chains.bsc)).frozen).toBe(true), { timeout: 10_000 });
  });
});

describe("timelock page", () => {
  it("lists a proposal decoded with countdown; stranger cannot cancel; WL cancels", async () => {
    const st = await readChainState(w.chains.wantos);
    const { params } = await readParams(w.chains.wantos);
    const r = await applyParams(w.chains.wantos, localSigner(w, w.act.admin), st.timelock, params, { ...params, b2wDailyCap: params.b2wDailyCap! + 100n * U });
    renderApp(w, localSigner(w, w.act.stranger), "/timelock");
    const card = await screen.findByTestId(`proposal-${r.id}`);
    expect(card).toHaveTextContent("参数调整");
    expect(card).toHaveTextContent("setParams");
    expect(card).toHaveTextContent(/还有 \d+ 天/);
    expect(within(card).getByRole("button", { name: "取消" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "执行" })).toBeDisabled();
    expect(card).toHaveTextContent("等待期未满");
    cleanup();
    renderApp(w, localSigner(w, w.act.wl), "/timelock");
    const c2 = await screen.findByTestId(`proposal-${r.id}`);
    fireEvent.click(within(c2).getByRole("button", { name: "取消" }));
    fireEvent.click(within(c2).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.getByTestId(`proposal-${r.id}`)).toHaveTextContent("已取消"), { timeout: 10_000 });
  });
});

describe("params page", () => {
  it("loosening a field turns the action into a timelock proposal; tightening is direct", async () => {
    renderApp(w, localSigner(w, w.act.admin), "/params");
    const input = await screen.findByLabelText("BSC 全局日额度");
    fireEvent.change(input, { target: { value: "6000" } });
    expect(await screen.findByText("放宽（需时间锁）")).toBeInTheDocument();
    expect(btn("生成时间锁提议（48h）")[0]).toBeEnabled();
    fireEvent.change(input, { target: { value: "4000" } });
    expect(await screen.findByText("收紧")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "10" } });
    expect(await screen.findByText(/全局日额度 不得低于 1000/)).toBeInTheDocument();
  });
});

describe("/handover page", () => {
  it("shows contract addresses; new holder proves address; current WL verifies; gates per role", async () => {
    renderApp(w, localSigner(w, w.act.newHolder), "/handover");
    await screen.findAllByRole("button", { name: "接收（新地址）" });
    expect(screen.getAllByText(w.bridge).length).toBeGreaterThan(2);
    expect(btn("接收（新地址）")[0]).toBeDisabled();
    expect(screen.getAllByText(/没有待接收的白名单钱包交接/).length).toBeGreaterThan(0);
    expect(btn("发起交接")[0]).toBeDisabled();
    fireEvent.click(btn("签名生成地址证明")[0]!);
    const proof = (await screen.findByTestId("proof")).textContent!;
    cleanup();

    renderApp(w, localSigner(w, w.act.wl), "/handover");
    fireEvent.change(await screen.findByLabelText("粘贴地址证明"), { target: { value: proof } });
    fireEvent.click(screen.getByRole("button", { name: "验证证明" }));
    expect(await screen.findByTestId("verified")).toHaveTextContent(w.act.newHolder.address);
    expect(screen.getByLabelText("新地址")).toHaveValue(w.act.newHolder.address);
    const begin = btn("发起交接")[0]!; // BSC
    await waitFor(() => expect(begin).toBeEnabled());
    fireEvent.click(begin);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "确认" }));
    expect(await screen.findByTestId("gaps", {}, { timeout: 10_000 })).toHaveTextContent("只在 BSC 上发起，WANTOS 上还没有");
    // veto it so later tests start clean
    fireEvent.click(btn("取消 / 否决交接")[0]!);
    await waitFor(() => expect(screen.queryByTestId("gaps")).toBeNull(), { timeout: 10_000 });
  });
});

describe("review / controlled / reserves (Worker API placeholder, fake fetch)", () => {
  const eventKey = keccak256(toBytes("order-1")) as Hex;
  function fakeApi() {
    const calls: { url: string; method: string; auth: string | null; body: unknown }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization");
      calls.push({ url, method: init.method ?? "GET", auth, body: init.body ? JSON.parse(init.body as string) : null });
      const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/admin/orders?status=REVIEW"))
        return json({ orders: [{ eventKey, direction: "W2B", srcEventNonce: "7", user: w.act.stranger.address, to: w.act.stranger.address, amount: (1500n * U).toString(), level: "audit", reason: "source_5_20", rules: ["来源占比 8%"], sourcePath: ["0xf974…", "0xe49d…"], createdAt: "2026-11-02" }] });
      if (url.endsWith("/admin/review")) return json({ ok: true });
      if (url.endsWith("/admin/controlled") && (init.method ?? "GET") === "GET") return json({ items: [{ addr: "0x0000000000000000000000000000000000000abc", label: "测试", addedAt: "2026-11-02" }] });
      if (url.endsWith("/admin/controlled")) return json({ ok: true });
      if (url.endsWith("/admin/report")) return json({ reconciliation: [{ at: "t", text: "WANTOS 无短缺" }], alerts: [], whitelistDaily: [] });
      if (url.endsWith("/admin/address-info")) return json({});
      return new Response("{}", { status: 501 });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }

  it("approve: admin signs the relayer's exact message; one SIWE session for several requests", async () => {
    const { calls, fetchFn } = fakeApi();
    const admin = localSigner(w, w.act.admin);
    renderApp(w, admin, "/review", { adminApi: "https://admin.wanto.pro/api", fetchFn });
    fireEvent.click(await screen.findByRole("button", { name: /读取（需要管理钱包签名登录）/ }));
    expect(await screen.findByText(/命中规则：来源占比 8%/)).toBeInTheDocument();
    expect(screen.getByText(/资金来源路径/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "通过" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/admin/review"))).toBe(true), { timeout: 10_000 });
    const post = calls.find((c) => c.url.endsWith("/admin/review"))!;
    const body = post.body as { eventKey: Hex; decision: "approve"; expires: string; signature: Hex };
    expect(body.decision).toBe("approve");
    const msg = relayerReviewMessage({ chainId: BSC_ID, eventKey, decision: "approve", expires: BigInt(body.expires) });
    expect(await recoverMessageAddress({ message: msg, signature: body.signature })).toBe(w.act.admin.address);
    expect(post.auth).toMatch(/^SIWE [A-Za-z0-9+/=]+\.0x[0-9a-f]+$/);
    expect(new Set(calls.map((c) => c.auth)).size).toBe(1); // session reused
    expect(admin.log.filter((x) => x === "sign:msg").length).toBe(2); // 1 SIWE + 1 decision
  });

  it("non-admin cannot approve (button disabled with reason)", async () => {
    const { fetchFn } = fakeApi();
    renderApp(w, localSigner(w, w.act.wl), "/review", { adminApi: "https://admin.wanto.pro/api", fetchFn });
    fireEvent.click(await screen.findByRole("button", { name: /读取/ }));
    await screen.findByText(/命中规则/);
    expect(screen.getByRole("button", { name: "通过" })).toBeDisabled();
    expect(screen.getAllByText(/不是 BSC 的管理钱包/).length).toBeGreaterThan(0);
  });

  it("no admin API configured → placeholder message", async () => {
    renderApp(w, localSigner(w, w.act.admin), "/review");
    fireEvent.click(await screen.findByRole("button", { name: /读取/ }));
    expect(await screen.findByText(/未配置管理接口/)).toBeInTheDocument();
  });

  it("controlled set: list and add go through the API", async () => {
    const { calls, fetchFn } = fakeApi();
    renderApp(w, localSigner(w, w.act.admin), "/controlled", { adminApi: "https://admin.wanto.pro/api", fetchFn });
    fireEvent.click(await screen.findByRole("button", { name: "读取" }));
    expect(await screen.findByText(/测试/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("受控地址"), { target: { value: "0x0000000000000000000000000000000000000def" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "添加" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && (c.body as { action: string }).action === "add")).toBe(true));
  });

  it("reserves: chain reads + report", async () => {
    const { fetchFn } = fakeApi();
    renderApp(w, localSigner(w, w.act.admin), "/reserves", { adminApi: "https://admin.wanto.pro/api", fetchFn });
    expect(await screen.findByTestId("reserve-bsc")).toHaveTextContent("桥合约余额 0");
    expect(await screen.findByTestId("reserve-wantos")).toHaveTextContent("今日已用");
    fireEvent.click(screen.getByRole("button", { name: /读取（需要签名登录）/ }));
    expect(await screen.findByText(/WANTOS 无短缺/)).toBeInTheDocument();
  });
});
