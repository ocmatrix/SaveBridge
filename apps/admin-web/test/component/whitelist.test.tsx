import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { keccak256, toBytes } from "viem";
import writeXlsxFile from "write-excel-file/node";
import * as tool from "@bridge/offline-check";
import { parseAddressList } from "../../src/lib/normalize";
import { readWhitelisted } from "../../src/lib/whitelist";
import { localSigner, startWorld, type World } from "../support/world";
import { renderApp } from "./render";
import { flakyWorld, precheck, whitelistOn } from "./precheck";
import { render } from "@testing-library/react";
import { App } from "../../src/App";
import { invalidateNonce, readNonce } from "../../src/lib/whitelist";
import { BSC_ID, WANTOS_ID } from "../support/world";
import { getAddress } from "viem";
import { vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chainNow } from "../../src/lib/chain";
import { submitWhitelist, type SubmitEnv } from "../../functions/_lib/submit";

let w: World;
beforeAll(async () => {
  w = await startWorld();
});
afterEach(() => cleanup());
afterAll(async () => w?.stop());

const plain = [keccak256(toBytes("c1")).slice(0, 42), keccak256(toBytes("c2")).slice(0, 42)];

const paste = (text: string) => fireEvent.change(screen.getByLabelText("地址列表"), { target: { value: text } });
const prepareBtn = () => screen.getByRole("button", { name: /准备本批/ });

describe("whitelist page: spreadsheet upload", () => {
  const upload = (file: File) => fireEvent.change(screen.getByLabelText("选择地址文件"), { target: { files: [file] } });
  const xlsxFile = async (rows: string[][]) => {
    const buf = await writeXlsxFile(rows.map((r) => r.map((value) => ({ value }))) as never).toBuffer();
    return new File([new Uint8Array(buf)], "list.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  };

  it("reads an .xlsx (first column only) through the same rules as pasted text", async () => {
    renderApp(w, null);
    upload(await xlsxFile([["地址"], [plain[0]!], [plain[1]!]]));
    await waitFor(() => expect(screen.getByTestId("parse-summary")).toHaveTextContent("有效地址 2 个"));
    expect(screen.getByTestId("parse-summary")).toHaveTextContent("表头已跳过");
  });

  it("an unreadable .xlsx shows a readable error and imports nothing", async () => {
    renderApp(w, null);
    upload(new File([new TextEncoder().encode("not a spreadsheet")], "bad.xlsx"));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取这个文件");
    expect(screen.getByTestId("parse-summary")).toHaveTextContent("有效地址 0 个");
  });

  it("remove mode shows the warning, add mode does not", async () => {
    renderApp(w, null);
    expect(screen.queryByTestId("remove-warning")).toBeNull();
    fireEvent.click(screen.getByLabelText("移除", { selector: "input" }));
    expect(screen.getByTestId("remove-warning")).toHaveTextContent("这些地址将立即无法跨链");
    fireEvent.click(screen.getByLabelText("添加", { selector: "input" }));
    expect(screen.queryByTestId("remove-warning")).toBeNull();
  });

  it("a slow earlier file never overwrites a later one", async () => {
    renderApp(w, null);
    const slow = new File([`${plain[0]}\n`], "slow.csv", { type: "text/csv" });
    const bytes = new TextEncoder().encode(`${plain[0]}\n`).buffer as ArrayBuffer;
    slow.arrayBuffer = () => new Promise((r) => setTimeout(() => r(bytes), 250)); // finishes AFTER the second file
    const fast = new File([`${plain[1]}\n`], "fast.csv", { type: "text/csv" });
    upload(slow);
    upload(fast);
    await waitFor(() => expect(screen.getByLabelText("地址列表")).toHaveValue(`${plain[1]}\n`));
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.getByLabelText("地址列表")).toHaveValue(`${plain[1]}\n`);
  });

  it("a stale file error disappears once the text is edited", async () => {
    renderApp(w, null);
    upload(new File([new TextEncoder().encode("not a spreadsheet")], "bad.xlsx"));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取这个文件");
    paste(plain[0]!);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("a .csv still works as before", async () => {
    renderApp(w, null);
    upload(new File([`address\n${plain[0]}\n${plain[1]}\n`], "list.csv", { type: "text/csv" }));
    await waitFor(() => expect(screen.getByTestId("parse-summary")).toHaveTextContent("有效地址 2 个"));
  });
});

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
    await precheck();
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
    await precheck();
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
    fireEvent.click(prepareBtn());
    await screen.findByTestId("listHash");
    wl.failNext(/^write:31337:/, "User rejected the request.");
    fireEvent.click(screen.getByRole("button", { name: "签名并写入两条链" }));
    await waitFor(() => expect(screen.getByTestId("progress")).toHaveTextContent(/BSC：已写入.*WANTOS：失败.*钱包里拒绝了/s), { timeout: 20_000 });
    // B1: no green 「已完成」 next to the button while a chain failed
    const runAction = () => screen.getByRole("button", { name: /重试未完成的链|已完成|签名并写入/ }).closest(".action")!;
    expect(runAction().querySelector(".ok")).toBeNull();
    expect(runAction().querySelector(".err")).toHaveTextContent(/WANTOS/);
    fireEvent.click(screen.getByRole("button", { name: "重试未完成的链" }));
    await waitFor(() => expect(screen.getByTestId("progress")).toHaveTextContent(/WANTOS：已写入/), { timeout: 20_000 });
    await waitFor(() => expect(runAction().querySelector(".ok")).toHaveTextContent("已完成"));
    expect(await readWhitelisted(w.chains.wantos, parseAddressList(list.join("\n")).addresses)).toEqual([true]);
    cleanup();
  });

  it("A1: switching 添加/移除 after preparing voids the prepared batch; the remove must be prepared (and signed) again", async () => {
    const wl = localSigner(w, w.act.wl);
    const list = [keccak256(toBytes("a1x")).slice(0, 42), keccak256(toBytes("a1y")).slice(0, 42)];
    const sorted = parseAddressList(list.join("\n")).addresses;
    renderApp(w, wl);
    paste(list.join("\n"));
    await precheck();
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
    await precheck(); // switching the mode voided the pre-check too
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
    fireEvent.click(prepareBtn());
    await screen.findByTestId("listHash");
    expect(screen.getByTestId("offline-cmd")).toHaveTextContent("--action remove");
    // and back: 移除 → 添加 also voids the prepared batch
    fireEvent.click(screen.getByLabelText("添加", { selector: "input" }));
    expect(screen.getByTestId("op")).toHaveTextContent("添加");
    expect(screen.queryByTestId("hashes")).toBeNull();
    expect(screen.queryByRole("button", { name: /签名并写入|重试/ })).toBeNull();
    fireEvent.click(screen.getByLabelText("移除", { selector: "input" }));
    await precheck();
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
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
    await precheck();
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
    await precheck();
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

  describe("round-2 small items", () => {
    const two = [keccak256(toBytes("s2a")).slice(0, 42), keccak256(toBytes("s2b")).slice(0, 42)];
    const prepared = async () => {
      renderApp(w, localSigner(w, w.act.wl));
      paste(two.join("\n"));
      await precheck();
      await waitFor(() => expect(prepareBtn()).toBeEnabled());
      fireEvent.click(prepareBtn());
      await screen.findByTestId("listHash");
    };

    it("M06: unticking a row after preparing voids the prepared batch", async () => {
      await prepared();
      fireEvent.click(screen.getByLabelText(`选择 ${two[0]}`));
      expect(screen.queryByTestId("hashes")).toBeNull();
      expect(screen.queryByRole("button", { name: /签名并写入|重试/ })).toBeNull();
    });

    it("M07: editing the list after preparing voids the prepared batch", async () => {
      await prepared();
      paste(two[0]!);
      await waitFor(() => expect(screen.queryByTestId("hashes")).toBeNull());
      expect(screen.queryByRole("button", { name: /签名并写入|重试/ })).toBeNull();
    });

    it("M04/M08: each chain's line shows its own nonce, domain hash and message hash", async () => {
      await invalidateNonce(w.chains.bsc, localSigner(w, w.act.wl)); // make the nonces differ
      await prepared();
      const sorted = parseAddressList(two.join("\n")).addresses;
      const deadline = BigInt(/--deadline (\d+)/.exec(screen.getByTestId("offline-cmd").textContent!)![1]!);
      for (const [side, chainId] of [["bsc", BSC_ID], ["wantos", WANTOS_ID]] as const) {
        const nonce = await readNonce(w.chains[side]);
        expect(screen.getByTestId(`nonce-${side}`)).toHaveTextContent(new RegExp(`^${nonce}$`));
        expect(screen.getByTestId(`domain-${side}`)).toHaveTextContent(tool.domainHash({ verifyingContract: w.bridge }));
        expect(screen.getByTestId(`msg-${side}`)).toHaveTextContent(tool.messageHash({ listHash: tool.listHash(sorted), count: 2, allowed: true, nonce, deadline }));
        expect(screen.getByTestId(`chain-${side}`)).toHaveTextContent(`chainId ${chainId}`);
      }
      expect(await readNonce(w.chains.bsc)).not.toBe(await readNonce(w.chains.wantos));
    });

    it("export: only after preparing; file name and contents come from the prepared batch", async () => {
      const blobs: Blob[] = [];
      const names: string[] = [];
      const u = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
      const saved = { c: u.createObjectURL, r: u.revokeObjectURL };
      u.createObjectURL = (b: Blob) => (blobs.push(b), "blob:x");
      u.revokeObjectURL = () => {};
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        names.push(this.download);
      });
      try {
        const mine = [keccak256(toBytes("ex1")).slice(0, 42), keccak256(toBytes("ex2")).slice(0, 42)];
        await whitelistOn(w, mine, ["bsc", "wantos"]); // remove mode leaves out addresses that are not on the whitelist
        renderApp(w, localSigner(w, w.act.wl));
        paste(mine.join("\n"));
        const exp = await screen.findByRole("button", { name: /导出已准备批次的清单/ });
        expect(exp).toBeDisabled();
        expect(screen.getByText(/离线核对请用你自己的原始文件/)).toBeInTheDocument();
        fireEvent.click(screen.getByLabelText("移除", { selector: "input" }));
        await precheck();
        await waitFor(() => expect(prepareBtn()).toBeEnabled());
        fireEvent.click(prepareBtn());
        await screen.findByTestId("listHash");
        fireEvent.click(exp);
        expect(names).toEqual(["whitelist-remove-batch1.txt"]);
        const text = await new Promise<string>((r) => {
          const fr = new FileReader();
          fr.onload = () => r(String(fr.result));
          fr.readAsText(blobs[0]!);
        });
        expect(text).toBe(parseAddressList(mine.join("\n")).addresses.map((a) => getAddress(a)).join("\n") + "\n");
      } finally {
        click.mockRestore();
        u.createObjectURL = saved.c;
        u.revokeObjectURL = saved.r;
      }
    });
  });

  it("B3: double-clicking 「签名并写入两条链」 runs once (one signature per chain)", async () => {
    const wl = localSigner(w, w.act.wl);
    renderApp(w, wl);
    paste(keccak256(toBytes("dbl")).slice(0, 42));
    await precheck();
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
    fireEvent.click(prepareBtn());
    await screen.findByTestId("listHash");
    wl.log.length = 0;
    const b = screen.getByRole("button", { name: "签名并写入两条链" });
    fireEvent.click(b);
    fireEvent.click(b);
    await waitFor(() => expect(screen.getByTestId("progress")).toHaveTextContent(/BSC：已写入.*WANTOS：已写入/s), { timeout: 20_000 });
    expect(wl.log.filter((x) => x.startsWith("sign712")).length).toBe(2);
    expect(wl.log.filter((x) => x.startsWith("write:")).length).toBe(2);
  });
});

describe("whitelist page: one-signature mode (submission service configured)", () => {
  it("one wallet signature, no wallet transaction, both chains written by the service", async () => {
    const key = generatePrivateKey();
    const submitter = privateKeyToAccount(key);
    for (const n of [w.node.bsc, w.node.wantos]) await n.test.setBalance({ address: submitter.address, value: 10n ** 21n });
    const env: SubmitEnv = { BRIDGE: w.bridge, BSC_CHAIN_ID: String(BSC_ID), BSC_RPC_URL: w.cfg.bsc.rpcUrl, WANTOS_CHAIN_ID: String(WANTOS_ID), WANTOS_RPC_URL: w.cfg.wantos.rpcUrl, SUBMITTER_KEY: key };
    // earlier tests in this file leave the two chains on different whitelist nonces on purpose; one signature needs equal nonces
    for (let guard = 0; guard < 20; guard++) {
      const [nb, nw] = [await readNonce(w.chains.bsc), await readNonce(w.chains.wantos)];
      if (nb === nw) break;
      await invalidateNonce(nb < nw ? w.chains.bsc : w.chains.wantos, localSigner(w, w.act.wl));
    }
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (u: Parameters<typeof fetch>[0], init?: RequestInit) => {
      // only the submission endpoint is served in-process; everything else (viem's JSON-RPC) goes to the real fetch
      if (String(u) !== "/api/whitelist") return realFetch(u, init);
      const t = Number(await chainNow(w.chains.bsc)) * 1000;
      const r = await submitWhitelist(env, JSON.parse(String(init?.body)), () => t);
      return new Response(JSON.stringify(r.json), { status: r.status });
    });
    try {
      const wl = localSigner(w, w.act.wl);
      const list = [keccak256(toBytes("os1")).slice(0, 42), keccak256(toBytes("os2")).slice(0, 42)];
      render(<App cfg={{ ...w.cfg, submitApi: "/api/whitelist" }} chains={w.chains} signer={wl} initialPath="/" />);
      paste(["address", ...list].join("\n"));
      await precheck();
      await waitFor(() => expect(prepareBtn()).toBeEnabled());
      fireEvent.click(prepareBtn());
      await screen.findByTestId("listHash");
      expect(screen.getByTestId("d1-note")).toHaveTextContent("只需在钱包里签名一次");
      expect(screen.getByTestId("d1-note")).not.toHaveTextContent("共 4 次");
      fireEvent.click(screen.getByRole("button", { name: "签名并写入两条链" }));
      await waitFor(() => expect(screen.getByTestId("progress")).toHaveTextContent(/BSC：已写入.*WANTOS：已写入/s), { timeout: 20_000 });
      expect(wl.log.filter((x) => x.startsWith("sign712"))).toHaveLength(1);
      expect(wl.log.filter((x) => x.startsWith("write:"))).toEqual([]);
      const selected = parseAddressList(list.join("\n")).addresses;
      for (const side of ["bsc", "wantos"] as const) expect(await readWhitelisted(w.chains[side], selected)).toEqual([true, true]);
    } finally {
      vi.unstubAllGlobals();
      cleanup();
    }
  });
});

describe("先核对：添加/移除前先核实是否已在白名单，已在的自动排除", () => {
  const mk = (s: string) => keccak256(toBytes(`pc-${s}`)).slice(0, 42);
  const radio = (name: "添加" | "移除") => screen.getByLabelText(name, { selector: "input" }) as HTMLInputElement;

  it("准备本批 stays disabled, with the reason, until the list has been checked", async () => {
    renderApp(w, localSigner(w, w.act.wl));
    paste([mk("n1"), mk("n2")].join("\n"));
    await screen.findByRole("button", { name: /^先核对/ });
    expect(prepareBtn()).toBeDisabled();
    expect(screen.getAllByText(/请先核对/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("precheck-done")).toBeNull();
  });

  it("an address already on both chains is excluded and listed; only the rest is prepared", async () => {
    const have = mk("a");
    const fresh = mk("b");
    await whitelistOn(w, [have], ["bsc", "wantos"]);
    renderApp(w, localSigner(w, w.act.wl));
    paste([have, fresh].join("\n"));
    await precheck();
    expect(screen.getByTestId("pc-total")).toHaveTextContent("2");
    expect(screen.getByTestId("pc-excluded")).toHaveTextContent("1");
    expect(screen.getByTestId("pc-submit")).toHaveTextContent("1");
    expect(screen.getByTestId("pc-excluded-list")).toHaveTextContent(getAddress(have));
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
    fireEvent.click(prepareBtn());
    await screen.findByTestId("listHash");
    expect(screen.getByTestId("count")).toHaveTextContent("1");
    // the excluded address is no longer in the batch that will be signed
    const prepared = await readWhitelisted(w.chains.bsc, [have, fresh]);
    expect(prepared).toEqual([true, false]);
    expect(screen.getByText(/已排除 1 个已在白名单的地址/)).toBeInTheDocument();
  });

  it("an address on one chain only is kept (the other chain still needs it) and shown as partial", async () => {
    const half = mk("c");
    await whitelistOn(w, [half], ["bsc"]);
    renderApp(w, localSigner(w, w.act.wl));
    paste(half);
    await precheck();
    expect(screen.getByTestId("pc-excluded")).toHaveTextContent("0");
    expect(screen.getByTestId("pc-partial")).toHaveTextContent("1");
    expect(screen.getByTestId("pc-submit")).toHaveTextContent("1");
    expect(screen.getByTestId("pc-partial-list")).toHaveTextContent(getAddress(half));
    expect(screen.getByTestId("pc-partial-list")).toHaveTextContent("BSC");
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
  });

  it("everything already whitelisted → nothing to submit, no prepare button", async () => {
    const [x, y] = [mk("d1"), mk("d2")];
    await whitelistOn(w, [x, y], ["bsc", "wantos"]);
    renderApp(w, localSigner(w, w.act.wl));
    paste([x, y].join("\n"));
    await precheck();
    expect(screen.getByTestId("pc-nothing")).toHaveTextContent("无需提交");
    expect(screen.queryByRole("button", { name: /准备本批/ })).toBeNull();
  });

  it("changing the list or the add/remove mode voids the check", async () => {
    renderApp(w, localSigner(w, w.act.wl));
    paste(mk("e1"));
    await precheck();
    paste(mk("e2"));
    await waitFor(() => expect(screen.queryByTestId("precheck-done")).toBeNull());
    expect(prepareBtn()).toBeDisabled();
    await precheck();
    fireEvent.click(radio("移除"));
    await waitFor(() => expect(screen.queryByTestId("precheck-done")).toBeNull());
    expect(prepareBtn()).toBeDisabled();
  });

  it("remove mode: an address on neither chain is excluded, one still whitelisted is kept", async () => {
    const [on, off] = [mk("r1"), mk("r2")];
    await whitelistOn(w, [on], ["bsc", "wantos"]);
    renderApp(w, localSigner(w, w.act.wl));
    fireEvent.click(radio("移除"));
    paste([on, off].join("\n"));
    await precheck();
    expect(screen.getByTestId("pc-excluded")).toHaveTextContent("1");
    expect(screen.getByTestId("pc-excluded-list")).toHaveTextContent(getAddress(off));
    expect(screen.getByTestId("pc-excluded-list")).not.toHaveTextContent(getAddress(on));
    expect(screen.getByTestId("pc-submit")).toHaveTextContent("1");
  });

  it("a read failure does not let you through; the check can be retried", async () => {
    const state = { fail: true };
    renderApp(flakyWorld(w, "wantos", state), localSigner(w, w.act.wl));
    paste(mk("f1"));
    fireEvent.click(await screen.findByRole("button", { name: /^先核对/ }));
    expect((await screen.findAllByText(/429/, {}, { timeout: 20_000 })).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("precheck-done")).toBeNull();
    expect(prepareBtn()).toBeDisabled();
    state.fail = false;
    await precheck();
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
  });
});
