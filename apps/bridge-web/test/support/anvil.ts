/**
 * Local-only test harness: two anvil chains (chain ids 13555 / 56, loopback only) with the PR-1 contracts
 * deployed from forge's out/*.json. Keys are anvil's well-known default test accounts — never real keys.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  getAddress,
  getContractAddress,
  http,
  parseUnits,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { bridgeTimelockAbi, bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import { parseConfig, type AppConfig } from "../../src/config";

const OUT = resolve(__dirname, "../../../../out");
// anvil's public default mnemonic (test-only, holds nothing anywhere real)
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
export const acct = (i: number): HDAccount => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i });
export const KEYS = { deployer: acct(0), admin: acct(1), wl: acct(2), relayer: acct(3), pauser: acct(4), alice: acct(5), bob: acct(6) };
export const U = 10n ** 18n;

function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(`${OUT}/${file}/${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

export interface Anvil {
  url: string;
  chain: Chain;
  proc: ChildProcess;
  pc: PublicClient;
  test: ReturnType<typeof createTestClient>;
}

async function startAnvil(chainId: number, name: string): Promise<Anvil> {
  const port = await freePort();
  const proc = spawn("anvil", ["--chain-id", String(chainId), "--port", String(port), "--host", "127.0.0.1", "--silent"], {
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({
    id: chainId,
    name,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
  const pc = createPublicClient({ chain, transport: http(url) }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await pc.getBlockNumber();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const test = createTestClient({ chain, mode: "anvil", transport: http(url) });
  return { url, chain, proc, pc, test };
}

export interface Side {
  anvil: Anvil;
  bridge: Address;
  usdt: Address;
}

export interface Env {
  wantos: Side;
  bsc: Side;
  cfg: AppConfig;
  stop(): void;
}

async function deploySide(a: Anvil, kind: "wantos" | "bsc"): Promise<Side> {
  const w = createWalletClient({ chain: a.chain, transport: http(a.url), account: KEYS.deployer });
  const deploy = async (abi: Abi, bytecode: Hex, args: unknown[] = []) => {
    const hash = await w.deployContract({ abi, bytecode, args });
    const r = await a.pc.waitForTransactionReceipt({ hash });
    if (!r.contractAddress) throw new Error("deploy failed");
    return getAddress(r.contractAddress);
  };
  const token = artifact("MockToken.sol", "MockToken");
  const usdt = await deploy(token.abi, token.bytecode);
  // user balances first so supplyCeiling = totalSupply + 10,000 (DESIGN §5.5)
  for (const [to, amt] of [
    [KEYS.alice.address, 10_000n * U],
    [KEYS.bob.address, 10_000n * U],
    [KEYS.deployer.address, 50_000n * U], // reserve, transferred (not minted) to the bridge after deployment
  ] as const) {
    await a.pc.waitForTransactionReceipt({
      hash: await w.writeContract({ address: usdt, abi: token.abi, functionName: "mint", args: [to, amt] }),
    });
  }
  const nonce = BigInt(await a.pc.getTransactionCount({ address: KEYS.deployer.address }));
  const proxyAddr = getContractAddress({ from: KEYS.deployer.address, nonce: nonce + 2n });
  const tl = artifact("BridgeTimelock.sol", "BridgeTimelock");
  const timelock = await deploy(bridgeTimelockAbi as Abi, tl.bytecode, [KEYS.admin.address, proxyAddr]);
  const implArt = kind === "wantos" ? artifact("WantosBridgeV2.sol", "WantosBridgeV2") : artifact("BscVaultV2.sol", "BscVaultV2");
  const impl = await deploy(implArt.abi, implArt.bytecode);
  const base = {
    timelock,
    token: usdt,
    whitelistManager: KEYS.wl.address,
    relayer: KEYS.relayer.address,
    pauser: KEYS.pauser.address,
    peerChainId: BigInt(kind === "wantos" ? 56 : 13555),
    peerBridge: proxyAddr,
  };
  const { encodeFunctionData } = await import("viem");
  let initData: Hex;
  if (kind === "wantos") {
    const ts = (await a.pc.readContract({ address: usdt, abi: token.abi, functionName: "totalSupply" })) as bigint;
    initData = encodeFunctionData({
      abi: wantosBridgeV2Abi,
      functionName: "initialize",
      args: [
        {
          ...base,
          params: { w2bMinAmount: 10n * U, w2bPerAddrDailyCap: 2000n * U, b2wDailyCap: 3000n * U, b2wDelay: 15n * 60n },
          supplyCeiling: ts + 10_000n * U,
        },
      ],
    });
  } else {
    initData = encodeFunctionData({
      abi: bscVaultV2Abi,
      functionName: "initialize",
      args: [
        {
          ...base,
          params: {
            dailyCap: 5000n * U,
            perAddrDailyCap: 2000n * U,
            largeThreshold: 1000n * U,
            releaseDelay: 12n * 3600n,
            minDeposit: 10n * U,
            maxDepositPerTx: 2000n * U,
          },
        },
      ],
    });
  }
  const proxy = artifact("ERC1967Proxy.sol", "ERC1967Proxy");
  const bridge = await deploy(proxy.abi, proxy.bytecode, [impl, initData]);
  if (bridge.toLowerCase() !== proxyAddr.toLowerCase()) throw new Error("proxy address mismatch");
  // reserves
  await a.pc.waitForTransactionReceipt({
    hash: await w.writeContract({ address: usdt, abi: token.abi, functionName: "transfer", args: [bridge, 50_000n * U] }),
  });
  return { anvil: a, bridge, usdt };
}

export async function startEnv(): Promise<Env> {
  const [wa, ba] = await Promise.all([startAnvil(13555, "WANTOS"), startAnvil(56, "BSC")]);
  const [wantos, bsc] = await Promise.all([deploySide(wa, "wantos"), deploySide(ba, "bsc")]);
  const cfg = parseConfig({
    VITE_WANTOS_CHAIN_ID: "13555",
    VITE_WANTOS_CHAIN_NAME: "WANTOS",
    VITE_WANTOS_NATIVE_SYMBOL: "WANT",
    VITE_WANTOS_RPC_URL: wa.url,
    VITE_WANTOS_EXPLORER_URL: "http://localhost/scan-wantos",
    VITE_WANTOS_BRIDGE: wantos.bridge,
    VITE_WANTOS_USDT: wantos.usdt,
    VITE_BSC_CHAIN_ID: "56",
    VITE_BSC_CHAIN_NAME: "BSC",
    VITE_BSC_NATIVE_SYMBOL: "BNB",
    VITE_BSC_RPC_URL: ba.url,
    VITE_BSC_EXPLORER_URL: "http://localhost/scan-bsc",
    VITE_BSC_BRIDGE: bsc.bridge,
    VITE_BSC_USDT: bsc.usdt,
  });
  return {
    wantos,
    bsc,
    cfg,
    stop() {
      wa.proc.kill();
      ba.proc.kill();
    },
  };
}

const bridgeAbi = (s: Side, env: Env) => (s === env.wantos ? (wantosBridgeV2Abi as Abi) : (bscVaultV2Abi as Abi));

async function send(s: Side, account: HDAccount, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const w = createWalletClient({ chain: s.anvil.chain, transport: http(s.anvil.url), account });
  const hash = await w.writeContract({ address, abi, functionName, args } as never);
  const r = await s.anvil.pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return r;
}

/** Whitelist writer flow (EIP-712 batch signed by the whitelist manager test key; any account submits). */
export async function whitelist(env: Env, s: Side, addrs: Address[], allowed = true) {
  const abi = bridgeAbi(s, env);
  const sorted = [...addrs].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
  const nonce = (await s.anvil.pc.readContract({ address: s.bridge, abi, functionName: "whitelistNonce" })) as bigint;
  const block = await s.anvil.pc.getBlock();
  const deadline = block.timestamp + 3600n;
  const digest = (await s.anvil.pc.readContract({
    address: s.bridge,
    abi,
    functionName: "hashWhitelistBatch",
    args: [sorted, allowed, nonce, deadline],
  })) as Hex;
  const sig = await KEYS.wl.sign({ hash: digest });
  await send(s, KEYS.deployer, s.bridge, abi, "applyWhitelistBatch", [sorted, allowed, nonce, deadline, sig]);
}

export async function pause(env: Env, s: Side) {
  await send(s, KEYS.pauser, s.bridge, bridgeAbi(s, env), "pause", []);
}

/** Relayer: BSC release for a W2B order (≤ largeThreshold). */
export async function relayerRelease(env: Env, orderId: bigint, to: Address, amount: bigint) {
  await send(env.bsc, KEYS.relayer, env.bsc.bridge, bscVaultV2Abi as Abi, "release", [orderId, to, amount]);
}

/** Relayer: WANTOS queue + 15 min + execute for a B2W deposit. */
export async function relayerCredit(env: Env, nonce: bigint, to: Address, amount: bigint) {
  const abi = wantosBridgeV2Abi as Abi;
  await send(env.wantos, KEYS.relayer, env.wantos.bridge, abi, "queueRelease", [nonce, to, amount]);
  await env.wantos.anvil.test.increaseTime({ seconds: 15 * 60 + 1 });
  await env.wantos.anvil.test.mine({ blocks: 1 });
  await send(env.wantos, KEYS.relayer, env.wantos.bridge, abi, "executeRelease", [nonce]);
}

/** Snapshot both chains; returns a revert function. */
export async function snapshot(env: Env): Promise<() => Promise<void>> {
  const [a, b] = await Promise.all([env.wantos.anvil.test.snapshot(), env.bsc.anvil.test.snapshot()]);
  return async () => {
    await Promise.all([env.wantos.anvil.test.revert({ id: a }), env.bsc.anvil.test.revert({ id: b })]);
  };
}

export const amount = (n: string) => parseUnits(n, 18);

/** Relayer: WANTOS queueRelease only (uses up b2wDailyCap without executing). */
export async function relayerQueue(env: Env, nonce: bigint, to: Address, amount: bigint) {
  await send(env.wantos, KEYS.relayer, env.wantos.bridge, wantosBridgeV2Abi as Abi, "queueRelease", [nonce, to, amount]);
}

/** MockToken has an open mint: raise WANTOS-USDT totalSupply (to trip supplyCeiling). */
export async function mintWantosUsdt(env: Env, to: Address, amount: bigint) {
  const token = artifact("MockToken.sol", "MockToken");
  await send(env.wantos, KEYS.deployer, env.wantos.usdt, token.abi, "mint", [to, amount]);
}

/** Alice spends W2B quota directly on chain (approve + bridgeOut), bypassing the page. */
export async function bridgeOutDirect(env: Env, account: HDAccount, amount: bigint) {
  await send(env.wantos, account, env.wantos.usdt, artifact("MockToken.sol", "MockToken").abi, "approve", [env.wantos.bridge, amount]);
  await send(env.wantos, account, env.wantos.bridge, wantosBridgeV2Abi as Abi, "bridgeOut", [amount]);
}
