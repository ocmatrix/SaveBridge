import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderApp } from "./renderApp";
import { parseConfig } from "../../src/config";
import { testEnv } from "../fixtures";

const ALICE = "0x5555555555555555555555555555555555555555";
afterEach(() => cleanup());

describe("testnet banner (round-3 B3)", () => {
  it("a testnet build shows a permanent 测试网 banner", () => {
    renderApp(parseConfig({ ...testEnv, VITE_NETWORK: "testnet" }), ALICE);
    expect(screen.getByRole("alert", { name: "测试网" })).toHaveTextContent("测试网");
  });
  it("a mainnet build never shows it", () => {
    renderApp(parseConfig(testEnv), ALICE);
    expect(screen.queryByRole("alert", { name: "测试网" })).toBeNull();
    expect(screen.queryByText(/测试网/)).toBeNull();
  });
});
