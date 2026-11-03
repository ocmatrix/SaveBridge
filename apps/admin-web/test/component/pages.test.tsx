import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { getAddress, keccak256, recoverMessageAddress, toBytes, type Hex } from "viem";
import { reviewMessage as relayerReviewMessage } from "../../../../packages/relayer/src/review";
import { readChainState } from "../../src/lib/state";
import { readParams, applyParams } from "../../src/lib/params";
import { executeProposal, listProposals, propose } from "../../src/lib/timelock";
import { actions } from "../../src/lib/handover";
import { readBoth } from "../../src/lib/state";
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

  it("emergency remove input is strict: a non-address first line is an error, not a skipped header", async () => {
    renderApp(w, localSigner(w, w.act.admin), "/emergency");
    fireEvent.change(await screen.findByLabelText("紧急移除地址"), { target: { value: `address\n${keccak256(toBytes("z2")).slice(0, 42)}` } });
    expect(screen.getByText(/有 1 行地址无效/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("先在下面填写正确的地址").length).toBeGreaterThan(0));
    expect(btn(/在 BSC 上紧急移除/)[0]).toBeDisabled();
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

describe("timelock page: targets", () => {
  it("shows the full target address and marks a foreign target 【其他】 in red, undecoded", async () => {
    const st = await readChainState(w.chains.bsc);
    const r = await propose(w.chains.bsc, localSigner(w, w.act.admin), st.timelock, [{ target: w.act.stranger.address, data: "0x8456cb59" }]);
    renderApp(w, localSigner(w, w.act.wl), "/timelock");
    const card = await screen.findByTestId(`proposal-${r.id}`);
    const call = within(card).getByTestId("call");
    expect(call).toHaveTextContent(w.act.stranger.address); // full, not shortened
    const tag = within(call).getByText(/【其他/);
    expect(tag).toHaveClass("err");
    expect(call).toHaveTextContent("目标不是本系统合约");
    expect(call).not.toHaveTextContent("pause(");
  });
});

describe("timelock page: look-alike target and value", () => {
  it("M36/M34: a target sharing the bridge's prefix is 【其他】 with its full address; attached value is shown", async () => {
    const st = await readChainState(w.chains.bsc);
    const b = w.bridge.toLowerCase();
    const lookalike = getAddress(b.slice(0, -1) + (b.endsWith("0") ? "1" : "0"));
    const r = await propose(w.chains.bsc, localSigner(w, w.act.admin), st.timelock, [{ target: lookalike, data: "0x8456cb59", value: 5n }]);
    renderApp(w, localSigner(w, w.act.wl), "/timelock");
    const call = within(await screen.findByTestId(`proposal-${r.id}`)).getByTestId("call");
    expect(call).toHaveTextContent(lookalike);
    expect(call).not.toHaveTextContent(w.bridge);
    expect(within(call).getByText(/【其他/)).toHaveClass("err");
    expect(call).toHaveTextContent("附带 5 wei");
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
    fireEvent.click(await screen.findByRole("radio", { name: "白名单钱包" }));
    await screen.findAllByRole("button", { name: "接收（新地址）" });
    expect(screen.getAllByText(w.bridge).length).toBeGreaterThan(2);
    expect(btn("接收（新地址）")[0]).toBeDisabled();
    expect(screen.getAllByText(/没有待接收的白名单钱包交接/).length).toBeGreaterThan(0);
    expect(btn("发起交接")[0]).toBeDisabled();
    fireEvent.click(btn("签名生成地址证明")[0]!);
    const proof = (await screen.findByTestId("proof")).textContent!;
    cleanup();

    renderApp(w, localSigner(w, w.act.wl), "/handover");
    fireEvent.click(await screen.findByRole("radio", { name: "白名单钱包" }));
    fireEvent.change(await screen.findByLabelText("粘贴地址证明"), { target: { value: proof } });
    fireEvent.click(screen.getByRole("button", { name: "验证证明" }));
    expect(await screen.findByTestId("verified")).toHaveTextContent(w.act.newHolder.address);
    expect(screen.getByLabelText("新地址")).toHaveValue(w.act.newHolder.address);
    expect(screen.queryByTestId("cand-mismatch")).toBeNull();
    fireEvent.change(screen.getByLabelText("新地址"), { target: { value: w.act.stranger.address } });
    expect(screen.getByTestId("cand-mismatch")).toHaveTextContent("与已验证的证明地址");
    fireEvent.change(screen.getByLabelText("新地址"), { target: { value: w.act.newHolder.address } });
    expect(screen.queryByTestId("cand-mismatch")).toBeNull();
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

describe("review / reserves (Worker API placeholder, fake fetch)", () => {
  const eventKey = keccak256(toBytes("order-1")) as Hex;
  function fakeApi() {
    const calls: { url: string; method: string; auth: string | null; body: unknown }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization");
      calls.push({ url, method: init.method ?? "GET", auth, body: init.body ? JSON.parse(init.body as string) : null });
      const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/admin/orders?status=REVIEW"))
        return json({ orders: [{ eventKey, direction: "W2B", srcEventNonce: "7", user: w.act.stranger.address, to: w.act.stranger.address, amount: (1500n * U).toString(), level: "freeze", reason: "onchain_mismatch", createdAt: "2026-11-02" }] });
      if (url.endsWith("/admin/review")) return json({ ok: true });
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
    expect(await screen.findByTestId("reason")).toHaveTextContent("来源检查冻结：源链订单与本单不一致（onchain_mismatch）");
    expect(screen.getByText(/冻结级/)).toBeInTheDocument();
    expect(screen.queryByText(/命中规则|资金来源路径/)).toBeNull();
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
    await screen.findByTestId("reason");
    expect(screen.getByRole("button", { name: "通过" })).toBeDisabled();
    expect(screen.getAllByText(/不是 BSC 的管理钱包/).length).toBeGreaterThan(0);
  });

  it("no admin API configured → placeholder message", async () => {
    renderApp(w, localSigner(w, w.act.admin), "/review");
    fireEvent.click(await screen.findByRole("button", { name: /读取/ }));
    expect(await screen.findByText(/未配置管理接口/)).toBeInTheDocument();
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

describe("/params page greys out what the connected wallet cannot do", () => {
  it("non-admin: every field disabled with the reason; contract-fixed values are read-only text", async () => {
    renderApp(w, localSigner(w, w.act.stranger), "/params");
    const f = await screen.findByLabelText("BSC 全局日额度");
    expect(f).toBeDisabled();
    expect(screen.getByLabelText("WANTOS B2W 日额度")).toBeDisabled();
    expect(screen.getByLabelText("新的发行上限")).toBeDisabled();
    expect(screen.getAllByText(/当前钱包不是 BSC 的管理钱包/).length).toBeGreaterThan(0);
    const fixed = screen.getByTestId("fixed-params");
    expect(fixed).toHaveTextContent("时间锁延迟");
    expect(fixed).toHaveTextContent("48 小时");
    expect(within(fixed).queryByRole("textbox")).toBeNull();
  });

  it("not connected: fields disabled too", async () => {
    renderApp(w, null, "/params");
    expect(await screen.findByLabelText("BSC 全局日额度")).toBeDisabled();
  });

  it("admin: fields editable", async () => {
    renderApp(w, localSigner(w, w.act.admin), "/params");
    expect(await screen.findByLabelText("BSC 全局日额度")).toBeEnabled();
    expect(screen.getByLabelText("新的发行上限")).toBeEnabled();
  });
});

describe("/handover page: admin-wallet handover", () => {
  it("defaults to the admin-wallet role with the four steps per chain; authorize then revoke", async () => {
    renderApp(w, localSigner(w, w.act.admin), "/handover");
    expect(await screen.findByRole("radio", { name: "管理钱包" })).toBeChecked();
    const bsc = await screen.findByTestId("admin-handover-bsc");
    for (const t of ["① 现管理员授权", "② 等待 48 小时", "③ 执行提议", "④ 新地址签名接收"]) expect(bsc).toHaveTextContent(t);
    expect(bsc).toHaveTextContent("待授权");
    expect(within(bsc).getByRole("button", { name: "撤销授权" })).toBeDisabled();
    expect(within(bsc).getByRole("button", { name: "接收管理钱包（新地址签名）" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("新地址"), { target: { value: w.act.newHolder.address } });
    const go = within(bsc).getByRole("button", { name: "授权新地址" });
    await waitFor(() => expect(go).toBeEnabled());
    fireEvent.click(go);
    fireEvent.click(within(bsc).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.getByTestId("admin-handover-bsc")).toHaveTextContent("已完成 ✓"), { timeout: 15_000 });
    expect(screen.getByTestId("admin-handover-bsc")).toHaveTextContent(/剩 \d+ 天|剩 47 小时|剩 48 小时/);
    expect(await screen.findByTestId("gaps")).toHaveTextContent("管理钱包交接");
    const revoke = within(screen.getByTestId("admin-handover-bsc")).getByRole("button", { name: "撤销授权" });
    await waitFor(() => expect(revoke).toBeEnabled());
    fireEvent.click(revoke);
    fireEvent.click(within(screen.getByTestId("admin-handover-bsc")).getByRole("button", { name: "确认" }));
    await waitFor(() => expect(screen.getByTestId("admin-handover-bsc")).toHaveTextContent("待授权"), { timeout: 15_000 });
    await waitFor(() => expect(screen.queryByTestId("gaps")).toBeNull(), { timeout: 15_000 });
  });

  it("a stranger sees the authorize/revoke buttons disabled with the reason", async () => {
    renderApp(w, localSigner(w, w.act.stranger), "/handover");
    const bsc = await screen.findByTestId("admin-handover-bsc");
    fireEvent.change(screen.getByLabelText("新地址"), { target: { value: w.act.newHolder.address } });
    expect(within(bsc).getByRole("button", { name: "授权新地址" })).toBeDisabled();
    expect(within(bsc).getAllByText(/当前钱包不是 BSC 的管理钱包/).length).toBeGreaterThan(0);
  });
});

// Last on purpose: it really hands the admin wallet over (warps 48h, executes, accepts) and changes the world's admin.
describe("/handover page: new address accepts (TP signature)", () => {
  it("shows the banner and per-chain accept; after both accepts the new address is effective", async () => {
    const admin = localSigner(w, w.act.admin);
    const both = await readBoth(w.chains);
    const ids: Record<string, Hex> = {};
    for (const s of ["bsc", "wantos"] as const) ids[s] = (await actions.proposeTransferAdmin(w.chains[s], admin, both[s].timelock, w.act.newHolder.address)).id;
    await w.warp(48 * 3600 + 5);
    for (const s of ["bsc", "wantos"] as const) {
      const p = (await listProposals(w.chains[s], both[s].timelock)).find((x) => x.id === ids[s])!;
      await executeProposal(w.chains[s], localSigner(w, w.act.pauser), both[s].timelock, p);
    }
    renderApp(w, localSigner(w, w.act.newHolder), "/handover");
    expect(await screen.findByTestId("new-admin-banner")).toHaveTextContent("你被指定为新的管理钱包");
    const bsc = await screen.findByTestId("admin-handover-bsc");
    expect(bsc).toHaveTextContent("待签名");
    const acceptBsc = within(bsc).getByRole("button", { name: "接收管理钱包（新地址签名）" });
    await waitFor(() => expect(acceptBsc).toBeEnabled());
    fireEvent.click(acceptBsc);
    await waitFor(async () => expect((await readChainState(w.chains.bsc)).admin).toBe(w.act.newHolder.address), { timeout: 15_000 });
    const acceptW = within(screen.getByTestId("admin-handover-wantos")).getByRole("button", { name: "接收管理钱包（新地址签名）" });
    fireEvent.click(acceptW);
    await waitFor(async () => expect((await readChainState(w.chains.wantos)).admin).toBe(w.act.newHolder.address), { timeout: 15_000 });
    fireEvent.change(screen.getByLabelText("新地址"), { target: { value: w.act.newHolder.address } });
    await waitFor(() => expect(screen.getByTestId("admin-handover-bsc")).toHaveTextContent("已生效 ✓"), { timeout: 15_000 });
  });
});
