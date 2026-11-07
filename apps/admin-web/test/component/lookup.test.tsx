import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { getAddress, keccak256, toBytes } from "viem";
import { startWorld, type World } from "../support/world";
import { renderApp } from "./render";
import { flakyWorld, whitelistOn } from "./precheck";

let w: World;
beforeAll(async () => {
  w = await startWorld();
});
afterEach(() => cleanup());
afterAll(async () => w?.stop());

const mk = (s: string) => keccak256(toBytes(`lk-${s}`)).slice(0, 42);
const input = () => screen.getByLabelText("查询地址");
const query = () => fireEvent.click(screen.getByRole("button", { name: "查询" }));

describe("/lookup 白名单查询", () => {
  it("is in the navigation and works without a connected wallet", async () => {
    renderApp(w, null, "/lookup");
    expect(await screen.findByRole("link", { name: "白名单查询" })).toBeInTheDocument();
    expect(input()).toBeEnabled();
  });

  it("shows, per address, whether each chain has it; invalid lines are listed and not queried; duplicates count once", async () => {
    const [both, onlyBsc, none] = [mk("both"), mk("bsc"), mk("none")];
    await whitelistOn(w, [both], ["bsc", "wantos"]);
    await whitelistOn(w, [onlyBsc], ["bsc"]);
    renderApp(w, null, "/lookup");
    fireEvent.change(input(), { target: { value: [both, onlyBsc, none, "0x12ab", both].join("\n") } });
    query();
    const summary = await screen.findByTestId("lookup-summary");
    expect(summary).toHaveTextContent("两条链都在 1");
    expect(summary).toHaveTextContent("只在一条链 1");
    expect(summary).toHaveTextContent("都不在 1");
    expect(screen.getByTestId(`lookup-row-${getAddress(both)}`)).toHaveTextContent(/BSC 是.*WANTOS 是/s);
    expect(screen.getByTestId(`lookup-row-${getAddress(onlyBsc)}`)).toHaveTextContent(/BSC 是.*WANTOS 否/s);
    expect(screen.getByTestId(`lookup-row-${getAddress(none)}`)).toHaveTextContent(/BSC 否.*WANTOS 否/s);
    expect(screen.getByTestId("lookup-errors")).toHaveTextContent("第 4 行");
    expect(screen.queryByTestId("lookup-row-0x12ab")).toBeNull();
  });

  it("refuses more than 500 addresses and queries nothing", async () => {
    renderApp(w, null, "/lookup");
    fireEvent.change(input(), { target: { value: Array.from({ length: 501 }, (_, i) => mk(`many-${i}`)).join("\n") } });
    query();
    expect(await screen.findByRole("alert")).toHaveTextContent("一次最多查 500 个");
    expect(screen.queryByTestId("lookup-summary")).toBeNull();
  });

  it("nothing valid to look up → asks for an address instead of showing an empty result", async () => {
    renderApp(w, null, "/lookup");
    fireEvent.change(input(), { target: { value: "not an address" } });
    query();
    expect(await screen.findByRole("alert")).toHaveTextContent(/没有可查询的地址|请输入/);
    expect(screen.queryByTestId("lookup-summary")).toBeNull();
  });

  it("a failed chain read is reported and no half result is shown", async () => {
    const state = { fail: true };
    renderApp(flakyWorld(w, "bsc", state), null, "/lookup");
    fireEvent.change(input(), { target: { value: mk("x") } });
    query();
    expect((await screen.findAllByText(/429/, {}, { timeout: 20_000 })).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("lookup-summary")).toBeNull();
    state.fail = false;
    query();
    await waitFor(() => expect(screen.getByTestId("lookup-summary")).toBeInTheDocument(), { timeout: 20_000 });
  });
});
