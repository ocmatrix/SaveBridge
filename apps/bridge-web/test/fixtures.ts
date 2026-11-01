import { parseConfig, type AppConfig } from "../src/config";

/** Placeholder addresses (no real contract). Bridge address is the same on both chains (DESIGN §5.1). */
export const BRIDGE = "0x1111111111111111111111111111111111111111";
export const W_USDT = "0x2222222222222222222222222222222222222222";
export const B_USDT = "0x3333333333333333333333333333333333333333";

export const testEnv: Record<string, string> = {
  VITE_WANTOS_CHAIN_ID: "13555",
  VITE_WANTOS_CHAIN_NAME: "WANTOS",
  VITE_WANTOS_NATIVE_SYMBOL: "WANT",
  VITE_WANTOS_RPC_URL: "https://rpc.wantos.io",
  VITE_WANTOS_EXPLORER_URL: "https://scan.wantos.io",
  VITE_WANTOS_BRIDGE: BRIDGE,
  VITE_WANTOS_USDT: W_USDT,
  VITE_WANTOS_FROM_BLOCK: "100",
  VITE_BSC_CHAIN_ID: "56",
  VITE_BSC_CHAIN_NAME: "BNB Smart Chain",
  VITE_BSC_NATIVE_SYMBOL: "BNB",
  VITE_BSC_RPC_URL: "https://bsc-rpc.example.org",
  VITE_BSC_EXPLORER_URL: "https://bscscan.com",
  VITE_BSC_BRIDGE: BRIDGE,
  VITE_BSC_USDT: B_USDT,
  VITE_BSC_FROM_BLOCK: "200",
};

export const testConfig: AppConfig = parseConfig(testEnv);
