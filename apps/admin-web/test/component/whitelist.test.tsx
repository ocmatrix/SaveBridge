import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { keccak256, toBytes } from "viem";
import * as tool from "@bridge/offline-check";
import { parseAddressList } from "../../src/lib/normalize";
import { readWhitelisted } from "../../src/lib/whitelist";
import { localSigner, startWorld, type World } from "../support/world";
import { renderApp } from "./render";

let w: World;
beforeAll(async () => {
  w = await startWorld();
});
afterEach(() => cleanup());
afterAll(async () => w?.stop());

const RED = "0x9272f360b98160c1662abb6d2df9e4f313b39502"; // appendix A (controlled)
const plain = [keccak256(toBytes("c1")).slice(0, 42), keccak256(toBytes("c2")).slice(0, 42)];

const paste = (text: string) => fireEvent.change(screen.getByLabelText("地址列表"), { target: { value: text } });
const prepareBtn = () => screen.getByRole("button", { name: /准备本批/ });

describe("whitelist page", () => {
  it("not connected / wrong wallet: write buttons disabled with the reason", async () => {
    renderApp(w, null);
    paste(plain.join("\n"));
    expect((await screen.findAllByText("未连接钱包")).length).toBeGreaterThan(0);
    expect(prepareBtn()).toBeDisabled();
    cleanup();
    renderApp(w, localSigner(w, w.act.admin)); // admin is not the whitelist wallet
    paste(plain.join("\n"));
    await waitFor(() => expect(screen.getAllByText(/当前钱包不是 BSC 的白名单钱包/).length).toBeGreaterThan(0));
    expect(prepareBtn()).toBeDisabled();
    cleanup();
  });

  it("file errors are listed and block hashing", async () => {
    renderApp(w, localSigner(w, w.act.wl));
    paste(`${plain[0]}\n0x1234\n`);
    expect(await screen.findByRole("alert")).toHaveTextContent("第 2 行");
    expect(screen.queryByRole("button", { name: /准备本批/ })).toBeNull();
    cleanup();
  });

  it("🔴 row starts unchecked and needs a second confirmation; listHash on screen == offline tool; write both chains", async () => {
    const wl = localSigner(w, w.act.wl);
    renderApp(w, wl);
    const text = ["address", ...plain, RED].join("\n");
    paste(text);
    const redBox = await screen.findByLabelText(`选择 ${RED}`);
    expect(redBox).not.toBeChecked();
    expect(screen.getByLabelText(`选择 ${plain[0]}`)).toBeChecked();
    expect(within(screen.getByTestId(`row-${RED}`)).getByText(/🔴/)).toBeInTheDocument();
    // the deselected red row is reported
    expect(screen.getByText(/你在页面上取消了 1 个地址/)).toBeInTheDocument();
    fireEvent.click(redBox);
    const dlg = screen.getByRole("alertdialog");
    expect(dlg).toHaveTextContent("受控来源地址");
    fireEvent.click(within(dlg).getByRole("button", { name: "不勾选" }));
    expect(redBox).not.toBeChecked();

    // prepare: hashes shown == tool over the same (selected) list
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
    fireEvent.click(prepareBtn());
    const lh = await screen.findByTestId("listHash");
    const selected = parseAddressList(plain.join("\n")).addresses;
    expect(lh).toHaveTextContent(tool.listHash(selected));
    expect(screen.getByTestId("count")).toHaveTextContent("2");
    expect(screen.getByText(/--expect-list-hash/)).toHaveTextContent(tool.listHash(selected));

    fireEvent.click(screen.getByRole("button", { name: "签名并写入两条链" }));
    await waitFor(() => expect(screen.getByTestId("progress")).toHaveTextContent(/BSC：已写入.*WANTOS：已写入/s), { timeout: 20_000 });
    expect(await readWhitelisted(w.chains.wantos, selected)).toEqual([true, true]);
    expect(await readWhitelisted(w.chains.bsc, [RED])).toEqual([false]);

    // history shows both chains consistent
    fireEvent.click(screen.getByRole("button", { name: "读取链上记录" }));
    expect(await screen.findByTestId("history")).toHaveTextContent("两链一致");
    cleanup();
  });

  it("confirming a 🔴 row includes it", async () => {
    renderApp(w, localSigner(w, w.act.wl));
    paste([plain[0], RED].join("\n"));
    const redBox = await screen.findByLabelText(`选择 ${RED}`);
    fireEvent.click(redBox);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "确认勾选" }));
    expect(redBox).toBeChecked();
    expect(screen.queryByText(/你在页面上取消了/)).toBeNull();
    cleanup();
  });

  it("partial failure is visible and the retry button finishes the other chain", async () => {
    const wl = localSigner(w, w.act.wl);
    const list = [keccak256(toBytes("c9")).slice(0, 42)];
    renderApp(w, wl);
    paste(list.join("\n"));
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
    fireEvent.click(prepareBtn());
    await screen.findByTestId("listHash");
    wl.failNext(/^write:31337:/, "User rejected the request.");
    fireEvent.click(screen.getByRole("button", { name: "签名并写入两条链" }));
    await waitFor(() => expect(screen.getByTestId("progress")).toHaveTextContent(/BSC：已写入.*WANTOS：失败.*钱包里拒绝了/s), { timeout: 20_000 });
    fireEvent.click(screen.getByRole("button", { name: "重试未完成的链" }));
    await waitFor(() => expect(screen.getByTestId("progress")).toHaveTextContent(/WANTOS：已写入/), { timeout: 20_000 });
    expect(await readWhitelisted(w.chains.wantos, parseAddressList(list.join("\n")).addresses)).toEqual([true]);
    cleanup();
  });
});
