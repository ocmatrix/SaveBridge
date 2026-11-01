import { describe, expect, it } from "vitest";
import { parseConfig, ConfigError } from "../../src/config";
import { testEnv, BRIDGE, W_USDT } from "../fixtures";

describe("parseConfig", () => {
  it("parses a complete env", () => {
    const c = parseConfig(testEnv);
    expect(c.wantos.id).toBe(13555);
    expect(c.bsc.id).toBe(56);
    expect(c.wantos.bridge).toBe(BRIDGE);
    expect(c.wantos.usdt).toBe(W_USDT);
    expect(c.wantos.rpcUrl).toBe("https://rpc.wantos.io");
    expect(c.wantos.fromBlock).toBe(100n);
    expect(c.relayerApi).toBeNull();
    expect(c.walletConnectProjectId).toBeNull();
  });

  it.each(["VITE_WANTOS_BRIDGE", "VITE_BSC_USDT", "VITE_WANTOS_RPC_URL", "VITE_BSC_CHAIN_ID", "VITE_WANTOS_NATIVE_SYMBOL"])(
    "rejects missing %s",
    (k) => {
      const env = { ...testEnv };
      delete env[k];
      expect(() => parseConfig(env)).toThrow(ConfigError);
    },
  );

  it("rejects the zero address, a bad address, and bridge == usdt", () => {
    expect(() => parseConfig({ ...testEnv, VITE_WANTOS_BRIDGE: "0x0000000000000000000000000000000000000000" })).toThrow(ConfigError);
    expect(() => parseConfig({ ...testEnv, VITE_WANTOS_BRIDGE: "0x1234" })).toThrow(ConfigError);
    expect(() => parseConfig({ ...testEnv, VITE_BSC_USDT: BRIDGE })).toThrow(ConfigError);
  });

  it("requires https except for localhost", () => {
    expect(() => parseConfig({ ...testEnv, VITE_WANTOS_RPC_URL: "http://rpc.wantos.io" })).toThrow(ConfigError);
    expect(parseConfig({ ...testEnv, VITE_WANTOS_RPC_URL: "http://127.0.0.1:8545" }).wantos.rpcUrl).toBe("http://127.0.0.1:8545");
    expect(() => parseConfig({ ...testEnv, VITE_RELAYER_API: "javascript:alert(1)" })).toThrow(ConfigError);
  });

  it("rejects identical chain ids", () => {
    expect(() => parseConfig({ ...testEnv, VITE_BSC_CHAIN_ID: "13555" })).toThrow(ConfigError);
  });

  it("reads optional relayer API and WalletConnect id", () => {
    const c = parseConfig({ ...testEnv, VITE_RELAYER_API: "https://api.example.org/", VITE_WC_PROJECT_ID: "abc123" });
    expect(c.relayerApi).toBe("https://api.example.org");
    expect(c.walletConnectProjectId).toBe("abc123");
  });
});

describe("placeholder builds are inert", () => {
  it("VITE_CONFIG_PLACEHOLDER=1 marks the config so the app refuses to run", async () => {
    const { parseConfig: p, isPlaceholder } = await import("../../src/config");
    expect(isPlaceholder(p({ ...testEnv, VITE_CONFIG_PLACEHOLDER: "1" }))).toBe(true);
    expect(isPlaceholder(p(testEnv))).toBe(false);
  });
});

describe("bridge address identical on both chains (B3, DESIGN §5.1)", () => {
  it("rejects different bridge addresses", () => {
    expect(() => parseConfig({ ...testEnv, VITE_BSC_BRIDGE: "0x4444444444444444444444444444444444444444" })).toThrow(ConfigError);
  });
});
