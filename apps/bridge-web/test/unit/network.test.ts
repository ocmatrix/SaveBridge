import { describe, expect, it, vi } from "vitest";
import { buildAddChainParams, addWantosNetwork } from "../../src/wallet/network";
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
  it("calls the EIP-1193 provider", async () => {
    const request = vi.fn().mockResolvedValue(null);
    await addWantosNetwork({ request }, testConfig);
    expect(request).toHaveBeenCalledWith({ method: "wallet_addEthereumChain", params: [buildAddChainParams(testConfig.wantos)] });
  });
});
