import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs helper without types
import { checkCsp, checkFile, checkIndexHtml } from "../../scripts/distChecks.mjs";
import { buildHeadersFile } from "../../src/csp";
import { testConfig } from "../fixtures";

describe("post-build checks", () => {
  it("accepts our generated headers, rejects unsafe ones", () => {
    expect(checkCsp(buildHeadersFile(testConfig))).toEqual([]);
    expect(checkCsp(null)).not.toEqual([]);
    expect(checkCsp("/*\n  Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'\n")).not.toEqual([]);
    expect(checkCsp("/*\n  Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-eval'\n")).not.toEqual([]);
  });
  it("flags inline scripts / handlers", () => {
    expect(checkIndexHtml('<script type="module" src="/a.js"></script>')).toEqual([]);
    expect(checkIndexHtml("<script>alert(1)</script>")).not.toEqual([]);
    expect(checkIndexHtml('<div onclick="x()"></div>')).not.toEqual([]);
  });
  it("flags MaxUint256 approvals, anvil keys, env files, eval", () => {
    expect(checkFile("a.js", 'approve(s,"0x' + "f".repeat(64) + '")')).not.toEqual([]);
    expect(checkFile("a.js", "approve(s, maxUint256)")).not.toEqual([]);
    expect(checkFile("a.js", "approve(s, 2n ** 256n - 1n)")).not.toEqual([]);
    expect(checkFile("a.js", "const bound=2n**256n-1n;function fee(){}")).toEqual([]); // viem's numeric bound
    expect(checkFile("a.js", "0x1" + "f".repeat(130))).toEqual([]); // P-521 constant in a crypto lib is fine
    expect(checkFile("a.js", "k='ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'")).not.toEqual([]);
    expect(checkFile(".env", "")).not.toEqual([]);
    expect(checkFile("a.js", "eval('1')")).not.toEqual([]);
    expect(checkFile("a.js", "const ok = 1;")).toEqual([]);
  });
});

describe("real-build connect-src gate (review finding 2)", () => {
  it("rejects extra or plain-http origins", async () => {
    // @ts-expect-error plain .mjs
    const { checkConnectSrc } = await import("../../scripts/distChecks.mjs");
    const ok = "/*\n  Content-Security-Policy: default-src 'none'; connect-src 'self' https://a.io https://b.io wss://relay.walletconnect.com wss://relay.walletconnect.org; frame-ancestors 'none'\n";
    expect(checkConnectSrc(ok)).toEqual([]);
    expect(checkConnectSrc(ok.replace("https://b.io", "https://b.io https://evil.io https://c.io"))).not.toEqual([]);
    expect(checkConnectSrc(ok.replace("https://b.io", "http://127.0.0.1:8545"))).not.toEqual([]);
  });
});

describe("real-build config pinning (B3)", () => {
  const good = {
    VITE_WANTOS_CHAIN_ID: "13555",
    VITE_BSC_CHAIN_ID: "56",
    VITE_WANTOS_USDT: "0xc74F2e7fBdA2af9D1fc26b85E341229063Dc0873",
    VITE_BSC_USDT: "0x55d398326f99059fF775485246999027B3197955",
  };
  it("accepts mainnet ids and the USDT addresses written in DESIGN", async () => {
    // @ts-expect-error plain .mjs
    const { checkRealConfig } = await import("../../scripts/distChecks.mjs");
    expect(checkRealConfig(good, { testnet: false })).toEqual([]);
    expect(checkRealConfig({ ...good, VITE_BSC_USDT: good.VITE_BSC_USDT.toLowerCase() }, { testnet: false })).toEqual([]);
  });
  it("rejects other chain ids / USDT addresses unless built as testnet", async () => {
    // @ts-expect-error plain .mjs
    const { checkRealConfig } = await import("../../scripts/distChecks.mjs");
    expect(checkRealConfig({ ...good, VITE_WANTOS_CHAIN_ID: "1345" }, { testnet: false })).not.toEqual([]);
    expect(checkRealConfig({ ...good, VITE_BSC_CHAIN_ID: "97" }, { testnet: false })).not.toEqual([]);
    expect(checkRealConfig({ ...good, VITE_BSC_USDT: "0x4444444444444444444444444444444444444444" }, { testnet: false })).not.toEqual([]);
    expect(checkRealConfig({ ...good, VITE_WANTOS_USDT: "0x4444444444444444444444444444444444444444" }, { testnet: false })).not.toEqual([]);
    expect(checkRealConfig({ ...good, VITE_WANTOS_CHAIN_ID: "1345", VITE_BSC_CHAIN_ID: "97", VITE_BSC_USDT: "0x4444444444444444444444444444444444444444" }, { testnet: true })).toEqual([]);
  });
});
