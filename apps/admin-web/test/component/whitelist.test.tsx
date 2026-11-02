import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { keccak256, toBytes } from "viem";
import * as tool from "@bridge/offline-check";
import { parseAddressList } from "../../src/lib/normalize";
import { readWhitelisted } from "../../src/lib/whitelist";
import { localSigner, startWorld, type World } from "../support/world";
import { renderApp } from "./render";
import { render } from "@testing-library/react";
import { App } from "../../src/App";
import { invalidateNonce } from "../../src/lib/whitelist";

let w: World;
beforeAll(async () => {
  w = await startWorld();
});
afterEach(() => cleanup());
afterAll(async () => w?.stop());

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

  it("all rows start selected (no source-of-funds flags, v0.9.5); listHash on screen == offline tool; write both chains", async () => {
    const wl = localSigner(w, w.act.wl);
    renderApp(w, wl);
    paste(["address", ...plain].join("\n"));
    for (const a of plain) expect(await screen.findByLabelText(`选择 ${a}`)).toBeChecked();
    expect(screen.queryByText(/🔴|🟠|受控/)).toBeNull();
    expect(screen.queryByText(/你在页面上取消了/)).toBeNull();

    // prepare: hashes shown == tool over the same (selected) list
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
    fireEvent.click(prepareBtn());
    const lh = await screen.findByTestId("listHash");
    const selected = parseAddressList(plain.join("\n")).addresses;
    expect(lh).toHaveTextContent(tool.listHash(selected));
    expect(screen.getByTestId("count")).toHaveTextContent("2");
    expect(screen.getByTestId("d1-note")).toHaveTextContent("两条链共 4 次");
    expect(screen.getByTestId("d1-note")).toHaveTextContent(/BNB.*WANT/);
    expect(screen.getByText(/--expect-list-hash/)).toHaveTextContent(tool.listHash(selected));

    fireEvent.click(screen.getByRole("button", { name: "签名并写入两条链" }));
    await waitFor(() => expect(screen.getByTestId("progress")).toHaveTextContent(/BSC：已写入.*WANTOS：已写入/s), { timeout: 20_000 });
    expect(await readWhitelisted(w.chains.wantos, selected)).toEqual([true, true]);

    // history shows both chains consistent
    fireEvent.click(screen.getByRole("button", { name: "读取链上记录" }));
    expect(await screen.findByTestId("history")).toHaveTextContent("两链一致");
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

  it("A1: switching 添加/移除 after preparing voids the prepared batch; the remove must be prepared (and signed) again", async () => {
    const wl = localSigner(w, w.act.wl);
    const list = [keccak256(toBytes("a1x")).slice(0, 42), keccak256(toBytes("a1y")).slice(0, 42)];
    const sorted = parseAddressList(list.join("\n")).addresses;
    renderApp(w, wl);
    paste(list.join("\n"));
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
    fireEvent.click(prepareBtn());
    await screen.findByTestId("listHash");
    fireEvent.click(screen.getByRole("button", { name: "签名并写入两条链" }));
    await waitFor(() => expect(screen.getByTestId("progress")).toHaveTextContent(/BSC：已写入.*WANTOS：已写入/s), { timeout: 20_000 });
    // both addresses now whitelisted. Prepare again under 添加, then switch to 移除.
    fireEvent.click(prepareBtn());
    await screen.findByTestId("listHash");
    expect(screen.getByTestId("offline-cmd")).toHaveTextContent("--action add");
    fireEvent.click(screen.getByLabelText("移除", { selector: "input" }) ?? screen.getByRole("radio", { name: /移除/ }));
    expect(screen.getByTestId("op")).toHaveTextContent("移除");
    expect(screen.queryByTestId("hashes")).toBeNull();
    expect(screen.queryByTestId("offline-cmd")).toBeNull();
    expect(screen.queryByRole("button", { name: /签名并写入|重试/ })).toBeNull(); // must prepare again
    fireEvent.click(prepareBtn());
    await screen.findByTestId("listHash");
    expect(screen.getByTestId("offline-cmd")).toHaveTextContent("--action remove");
    // and back: 移除 → 添加 also voids the prepared batch
    fireEvent.click(screen.getByLabelText("添加", { selector: "input" }));
    expect(screen.getByTestId("op")).toHaveTextContent("添加");
    expect(screen.queryByTestId("hashes")).toBeNull();
    expect(screen.queryByRole("button", { name: /签名并写入|重试/ })).toBeNull();
    fireEvent.click(screen.getByLabelText("移除", { selector: "input" }));
    fireEvent.click(prepareBtn());
    await screen.findByTestId("listHash");
    expect(screen.getByTestId("offline-cmd")).toHaveTextContent("--action remove");
    wl.log.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "签名并写入两条链" }));
    await waitFor(() => expect(screen.getByTestId("progress")).toHaveTextContent(/WANTOS：已写入.*BSC：已写入/s), { timeout: 20_000 });
    expect(wl.log.filter((x) => x.startsWith("sign712")).length).toBe(2); // really signed
    expect(await readWhitelisted(w.chains.bsc, sorted)).toEqual([false, false]);
    expect(await readWhitelisted(w.chains.wantos, sorted)).toEqual([false, false]);
  });

  it("A2: the page's own offline command (multi-batch, batch 2) makes the tool print exactly the message hashes on screen", async () => {
    const list = Array.from({ length: 501 }, (_, i) => keccak256(toBytes(`a2-${i}`)).slice(0, 42));
    const rawFile = list.join("\n");
    // make the two chains' nonces differ so a swapped --bsc-nonce/--wantos-nonce would show
    const wl = localSigner(w, w.act.wl);
    await invalidateNonce(w.chains.bsc, wl);
    await invalidateNonce(w.chains.bsc, wl);
    renderApp(w, wl);
    paste(rawFile);
    const sel = await screen.findByLabelText("选择批次");
    fireEvent.change(sel, { target: { value: "1" } });
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
    fireEvent.click(prepareBtn());
    await screen.findByTestId("listHash", {}, { timeout: 20_000 });
    const cmd = screen.getByTestId("offline-cmd").textContent!;
    expect(cmd).toContain("--batch 2");
    expect(cmd).toContain("--deadline ");
    const argv = cmd.split(/\s+/).slice(2).map((t) => (t === "<原始文件>" ? "raw.txt" : t));
    const r = tool.runCli([...argv, "--json"], () => rawFile);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.match).toBe(true);
    expect(out.batches[0].bsc.messageHash).toBe(screen.getByTestId("msg-bsc").textContent);
    expect(out.batches[0].wantos.messageHash).toBe(screen.getByTestId("msg-wantos").textContent);
    expect(out.batches[0].count).toBe(1);
  }, 60_000);

  it("B2: nonce moved after preparing → run stops, retry disabled until prepared again; a failed prepare clears old hashes", async () => {
    const wl = localSigner(w, w.act.wl);
    let failBlocks = false;
    const wrap = (c: typeof w.chains.bsc) => ({
      ...c,
      client: new Proxy(c.client, {
        get(t, k, r) {
          if (k === "getBlock" && failBlocks) return () => Promise.reject(new Error("rpc down"));
          return Reflect.get(t, k, r);
        },
      }),
    });
    const chains = { bsc: wrap(w.chains.bsc), wantos: wrap(w.chains.wantos) };
    render(<App cfg={w.cfg} chains={chains} signer={wl} initialPath="/" />);
    paste(keccak256(toBytes("b2c")).slice(0, 42));
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
    fireEvent.click(prepareBtn());
    await screen.findByTestId("listHash");
    // the nonce moves (e.g. another batch landed) → stop, no signature
    await invalidateNonce(w.chains.bsc, wl);
    wl.log.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "签名并写入两条链" }));
    await waitFor(() => expect(screen.getByTestId("progress")).toHaveTextContent(/BSC：失败.*重新「准备本批」/s), { timeout: 20_000 });
    expect(wl.log.filter((x) => x.startsWith("sign712"))).toEqual([]);
    expect(screen.getByRole("button", { name: "重试未完成的链" })).toBeDisabled();
    expect(screen.getByText("需要重新准备本批并重新离线核对")).toBeInTheDocument();
    // a failing prepare must not leave the previous hashes on screen
    failBlocks = true;
    fireEvent.click(prepareBtn());
    await waitFor(() => expect(screen.queryByTestId("hashes")).toBeNull());
    expect(await screen.findByText(/rpc down/)).toBeInTheDocument();
  });
});
