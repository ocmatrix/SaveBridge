import { describe, expect, it, vi } from "vitest";
import { buildAddChainParams, requestChain } from "../../src/wallet/network";
import { testConfig } from "../fixtures";

describe("wallet_addEthereumChain", () => {
  it("builds params from config (chainId 13555 = 0x34f3)", () => {
    expect(buildAddChainParams(testConfig.wantos)).toEqual({
      chainId: "0x34f3",
      chainName: "WANTOS",
      nativeCurrency: { name: "WANT", symbol: "WANT", decimals: 18 },
      rpcUrls: ["https://rpc.wantos.io"],
      blockExplorerUrls: ["https://scan.wantos.io"],
    });
  });
});

describe("requestChain", () => {
  const chain = testConfig.wantos;
  const answer = (fail: Record<string, unknown>) =>
    vi.fn(async ({ method }: { method: string }) => {
      if (method in fail) throw fail[method];
      return method === "eth_chainId" ? "0x34f3" : null;
    });

  it("switch ok → returns the wallet's chain id, never adds", async () => {
    const request = answer({});
    expect(await requestChain({ request }, chain, true)).toBe(13555);
    expect(request.mock.calls.map((c) => c[0].method)).toEqual(["wallet_switchEthereumChain", "eth_chainId"]);
  });
  it("switch fails + add allowed → asks the wallet to add the chain", async () => {
    const request = answer({ wallet_switchEthereumChain: { code: 4902 } });
    await requestChain({ request }, chain, true);
    expect(request).toHaveBeenCalledWith({ method: "wallet_addEthereumChain", params: [buildAddChainParams(chain)] });
  });
  it("switch fails + add not allowed (the silent first try) → rejects, no add prompt", async () => {
    const request = answer({ wallet_switchEthereumChain: { code: 4902 } });
    await expect(requestChain({ request }, chain, false)).rejects.toBeTruthy();
    expect(request.mock.calls.some((c) => c[0].method === "wallet_addEthereumChain")).toBe(false);
  });
  it("user rejected (4001) → no add attempt", async () => {
    const request = answer({ wallet_switchEthereumChain: { code: 4001 } });
    await expect(requestChain({ request }, chain, true)).rejects.toBeTruthy();
    expect(request.mock.calls.some((c) => c[0].method === "wallet_addEthereumChain")).toBe(false);
  });
});
