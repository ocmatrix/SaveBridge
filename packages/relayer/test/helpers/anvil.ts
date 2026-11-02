import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, type Chain } from "viem";

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

export interface Anvil {
  url: string;
  chain: Chain;
  publicClient: ReturnType<typeof createPublicClient>;
  testClient: ReturnType<typeof createTestClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  stop(): Promise<void>;
}

/** Starts a local anvil bound to 127.0.0.1 only. Never connects anywhere else. */
export async function startAnvil(chainId: number): Promise<Anvil> {
  const port = await freePort();
  const proc: ChildProcess = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--silent", "--gas-price", "1000000000", "--base-fee", "1000000000"],
    { stdio: "ignore" },
  );
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({
    id: chainId,
    name: `anvil-${chainId}`,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const transport = http(url, { retryCount: 0 });
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 50 });
  for (let i = 0; i < 100; i++) {
    try {
      await publicClient.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return {
    url,
    chain,
    publicClient,
    testClient: createTestClient({ chain, transport, mode: "anvil" }),
    walletClient: createWalletClient({ chain, transport }),
    stop: async () => {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 20));
    },
  };
}
