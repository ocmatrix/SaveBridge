import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { keccak256, toBytes } from "viem";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/App";
import type { Chains, Signer } from "../../src/lib/chain";
import { parseAddressList } from "../../src/lib/normalize";
import { readWhitelisted } from "../../src/lib/whitelist";
import { localSigner, startWorld, type World } from "../support/world";
import { precheck, whitelistOn } from "./precheck";

/**
 * Round-2 A-1: the form must not change what gets prepared/signed while 「准备本批」 or 「签名并写入」 is in flight.
 * Modelled on the reviewer's probes P1–P3 (whitelistNonce read held for a while).
 */
let w: World;
beforeAll(async () => {
  w = await startWorld();
});
afterEach(() => cleanup());
afterAll(async () => w?.stop());

const paste = (text: string) => fireEvent.change(screen.getByLabelText("地址列表"), { target: { value: text } });
const prepareBtn = () => screen.getByRole("button", { name: /准备本批/ });
const radio = (name: "添加" | "移除") => screen.getByLabelText(name, { selector: "input" }) as HTMLInputElement;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chains whose whitelistNonce reads wait on a gate (prepare is "in flight" while armed). */
function gatedChains(): { chains: Chains; arm: () => void; release: () => void } {
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  const wrap = (c: Chains["bsc"]) => ({
    ...c,
    client: new Proxy(c.client, {
      get(t, k, r) {
        if (k === "readContract")
          return async (a: { functionName: string }) => {
            if (gate && a.functionName === "whitelistNonce") await gate;
            return (t.readContract as (x: unknown) => Promise<unknown>)(a);
          };
        return Reflect.get(t, k, r);
      },
    }),
  });
  return {
    chains: { bsc: wrap(w.chains.bsc), wantos: wrap(w.chains.wantos) } as Chains,
    arm: () => (gate = new Promise((r) => (open = r))),
    release: () => {
      open();
      gate = null;
    },
  };
}

const formControls = () => [
  radio("添加"),
  radio("移除"),
  screen.getByLabelText("地址列表"),
  screen.getByLabelText("选择地址文件"),
  ...screen.getAllByRole("checkbox"),
  ...(screen.queryByLabelText("选择批次") ? [screen.getByLabelText("选择批次")] : []),
];

describe("A-1: preparing locks the form", () => {
  it("P1/P3: while preparing every form control is disabled; clicking 移除 does nothing; the prepared add matches the form", async () => {
    const wl = localSigner(w, w.act.wl);
    const g = gatedChains();
    render(<App cfg={w.cfg} chains={g.chains} signer={wl} initialPath="/" />);
    const list = [keccak256(toBytes("r1a")).slice(0, 42)];
    paste(list.join("\n"));
    await precheck();
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
    g.arm();
    fireEvent.click(prepareBtn());
    await tick(200);
    for (const c of formControls()) expect(c, (c as HTMLInputElement).getAttribute("aria-label") ?? "").toBeDisabled();
    // a real user's click (user-event models the browser: disabled controls receive no click)
    await userEvent.setup().click(radio("移除"));
    expect(radio("移除").checked).toBe(false);
    g.release();
    await screen.findByTestId("listHash", {}, { timeout: 10_000 });
    expect(screen.getByTestId("op")).toHaveTextContent("添加");
    expect(screen.getByTestId("offline-cmd")).toHaveTextContent("--action add");
    for (const c of formControls()) expect(c).toBeEnabled();
  });

  it("P2: the batch selector is locked while preparing; the shown batch is the selected one", async () => {
    const g = gatedChains();
    render(<App cfg={w.cfg} chains={g.chains} signer={localSigner(w, w.act.wl)} initialPath="/" />);
    paste(Array.from({ length: 501 }, (_, i) => keccak256(toBytes(`r2-${i}`)).slice(0, 42)).join("\n"));
    const sel = (await screen.findByLabelText("选择批次")) as HTMLSelectElement;
    await precheck();
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
    g.arm();
    fireEvent.click(prepareBtn());
    await tick(200);
    expect(sel).toBeDisabled();
    g.release();
    await screen.findByTestId("listHash", {}, { timeout: 20_000 });
    expect(sel.value).toBe("0");
    expect(screen.getByTestId("offline-cmd")).toHaveTextContent("--batch 1 ");
    expect(screen.getByTestId("count")).toHaveTextContent("500");
  }, 60_000);

  it("generation guard: a form change that still lands during prepare (e.g. programmatic) discards the result", async () => {
    const g = gatedChains();
    render(<App cfg={w.cfg} chains={g.chains} signer={localSigner(w, w.act.wl)} initialPath="/" />);
    paste(keccak256(toBytes("r3a")).slice(0, 42));
    await precheck();
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
    g.arm();
    fireEvent.click(prepareBtn());
    await tick(200);
    paste(keccak256(toBytes("r3b")).slice(0, 42)); // React still delivers a change event to a disabled textarea
    g.release();
    expect(await screen.findByText(/准备期间表单已改动，请重新准备/, {}, { timeout: 10_000 })).toBeInTheDocument();
    await tick(300);
    expect(screen.queryByTestId("hashes")).toBeNull();
    expect(screen.queryByRole("button", { name: /签名并写入|重试/ })).toBeNull();
  });
});

describe("A-1: events that still reach disabled controls never produce a batch different from the form (T22/T23)", () => {
  for (const kind of ["radio", "checkbox"] as const) {
    it(`fireEvent.click on the disabled ${kind} during prepare → result discarded or consistent, never stale`, async () => {
      const g = gatedChains();
      render(<App cfg={w.cfg} chains={g.chains} signer={localSigner(w, w.act.wl)} initialPath="/" />);
      const list = [keccak256(toBytes(`t2${kind}a`)).slice(0, 42), keccak256(toBytes(`t2${kind}b`)).slice(0, 42)];
      await whitelistOn(w, list, ["bsc"]); // on one chain only: kept by the pre-check in both 添加 and 移除 mode
      paste(list.join("\n"));
      await precheck();
      await waitFor(() => expect(prepareBtn()).toBeEnabled());
      g.arm();
      fireEvent.click(prepareBtn());
      await tick(200);
      const target = kind === "radio" ? radio("移除") : (screen.getByLabelText(`选择 ${list[0]}`) as HTMLInputElement);
      expect(target).toBeDisabled();
      fireEvent.click(target); // jsdom still dispatches it
      g.release();
      await tick(500);
      const hashes = screen.queryByTestId("hashes");
      if (hashes === null) {
        expect(screen.getByText(/准备期间表单已改动，请重新准备/)).toBeInTheDocument();
      } else {
        expect(screen.getByTestId("op")).toHaveTextContent(radio("移除").checked ? "移除" : "添加");
        const selected = screen.getAllByRole("checkbox").filter((c) => (c as HTMLInputElement).checked).length;
        expect(screen.getByTestId("count")).toHaveTextContent(String(selected));
      }
      // the form is consistent again afterwards and can be prepared
      await precheck();
      await waitFor(() => expect(prepareBtn()).toBeEnabled());
    });
  }
});

describe("A-1 (runJob path): the form is locked while signing/writing; a change that still lands stops the run", () => {
  /** wraps a signer so that its first EIP-712 signature waits on a gate */
  function gatedSigner(base: Signer) {
    let open: () => void = () => {};
    let armed = false;
    const gate = new Promise<void>((r) => (open = r));
    const s: Signer = {
      ...base,
      signTypedData: async (chainId, td) => {
        if (!armed) {
          armed = true;
          await gate;
        }
        return base.signTypedData(chainId, td);
      },
    };
    return { s, release: () => open() };
  }

  it("while the wallet is asked to sign, form controls are disabled; a programmatic change stops before submitting", async () => {
    const wl = localSigner(w, w.act.wl);
    const g = gatedSigner(wl);
    render(<App cfg={w.cfg} chains={w.chains} signer={g.s} initialPath="/" />);
    const list = [keccak256(toBytes("r4a")).slice(0, 42)];
    paste(list.join("\n"));
    await precheck();
    await waitFor(() => expect(prepareBtn()).toBeEnabled());
    fireEvent.click(prepareBtn());
    await screen.findByTestId("listHash");
    fireEvent.click(screen.getByRole("button", { name: "签名并写入两条链" }));
    await tick(200);
    for (const c of formControls()) expect(c).toBeDisabled();
    paste(keccak256(toBytes("r4b")).slice(0, 42)); // lands anyway
    g.release();
    expect(await screen.findByText(/准备期间表单已改动|表单已改动，已停止/, {}, { timeout: 10_000 })).toBeInTheDocument();
    await tick(500);
    expect(wl.log.filter((x) => x.startsWith("write:"))).toEqual([]);
    expect(screen.queryByTestId("progress")).toBeNull();
    expect(await readWhitelisted(w.chains.bsc, parseAddressList(list.join("\n")).addresses)).toEqual([false]);
  });
});
