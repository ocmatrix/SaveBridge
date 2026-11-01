/**
 * Local two-chain harness: two `anvil` processes on random localhost ports (never a real network),
 * the PR-1 contracts deployed from `out/*.json`, anvil's public default accounts as keys.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  http,
  keccak256,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { bscVaultV2Abi, bridgeTimelockAbi, wantosBridgeV2Abi } from "@bridge/abi";
import type { ChainName } from "../../src/types.js";

const ROOT = join(__dirname, "../../../..");
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"; // anvil's public default

export const mockTokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

function artifact(file: string, name: string): { abi: unknown[]; bytecode: Hex } {
  const p = join(ROOT, "out", `${file}.sol`, `${name}.json`);
  if (!existsSync(p)) execSync("forge build", { cwd: ROOT, stdio: "ignore" });
  const j = JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export const acct = (i: number): Account => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i });
export const ACCOUNTS = {
  deployer: acct(0),
  admin: acct(1),
  wl: acct(2),
  relayer: acct(3),
  pauser: acct(4),
  user1: acct(5),
  user2: acct(6),
  user3: acct(7),
  attacker: acct(8),
  tokenDeployer: acct(9),
};

export const E = (n: number | string): bigint => parseEther(String(n));

export interface ChainH {
  name: ChainName;
  chainId: number;
  url: string;
  proc: ChildProcess;
  chain: Chain;
  pub: PublicClient;
  bridge: Address;
  timelock: Address;
  token: Address;
  abi: typeof bscVaultV2Abi | typeof wantosBridgeV2Abi;
  wallet(a: Account): WalletClient;
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  mine(n?: number): Promise<void>;
  increaseTime(sec: number): Promise<void>;
  latest(): Promise<{ number: bigint; timestamp: number }>;
  write(a: Account, fn: string, args: unknown[], to?: Address): Promise<{ hash: Hex; block: bigint; timestamp: number }>;
  snapshot(): Promise<Hex>;
  revert(id: Hex): Promise<void>;
}

async function startAnvil(name: ChainName, chainId: number, genesisTs: number): Promise<ChainH> {
  const port = await freePort();
  const proc = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--slots-in-an-epoch", "1", "--timestamp", String(genesisTs), "--silent"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({ id: chainId, name: `local-${name}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const pub = createPublicClient({ chain, transport: http(url, { retryCount: 0 }) }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  let id = 0;
  const rpc = async <T,>(method: string, params: unknown[] = []): Promise<T> => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = (await res.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result as T;
  };
  const h: ChainH = {
    name,
    chainId,
    url,
    proc,
    chain,
    pub,
    bridge: "0x" as Address,
    timelock: "0x" as Address,
    token: "0x" as Address,
    abi: name === "bsc" ? bscVaultV2Abi : wantosBridgeV2Abi,
    wallet: (a) => createWalletClient({ account: a, chain, transport: http(url, { retryCount: 0 }) }),
    rpc,
    mine: async (n = 1) => {
      await rpc("anvil_mine", [`0x${n.toString(16)}`, "0x1"]);
    },
    increaseTime: async (sec) => {
      await rpc("evm_increaseTime", [sec]);
      await rpc("evm_mine", []);
    },
    latest: async () => {
      const b = await pub.getBlock({ blockTag: "latest" });
      return { number: b.number, timestamp: Number(b.timestamp) };
    },
    write: async (a, fn, args, to) => {
      const target = to ?? h.bridge;
      const abi = target === h.token ? mockTokenAbi : target === h.timelock ? bridgeTimelockAbi : h.abi;
      const data = (encodeFunctionData as (x: unknown) => Hex)({ abi, functionName: fn, args });
      const hash = await h.wallet(a).sendTransaction({ account: a, chain, to: target, data });
      const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
      if (r.status !== "success") throw new Error(`${fn} reverted`);
      const b = await pub.getBlock({ blockNumber: r.blockNumber });
      return { hash, block: r.blockNumber, timestamp: Number(b.timestamp) };
    },
    snapshot: async () => rpc<Hex>("evm_snapshot"),
    revert: async (sid) => {
      await rpc("evm_revert", [sid]);
    },
  };
  return h;
}

async function deployRaw(h: ChainH, a: Account, bytecode: Hex, ctorArgs: Hex = "0x"): Promise<Address> {
  const hash = await h.wallet(a).sendTransaction({ account: a, chain: h.chain, data: (bytecode + ctorArgs.slice(2)) as Hex });
  const r = await h.pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (!r.contractAddress) throw new Error("deploy failed");
  return r.contractAddress;
}

export const BSC_PARAMS = { dailyCap: E(5000), perAddrDailyCap: E(2000), largeThreshold: E(1000), releaseDelay: 12n * 3600n, minDeposit: E(10), maxDepositPerTx: E(2000) };
export const WANTOS_PARAMS = { w2bMinAmount: E(10), w2bPerAddrDailyCap: E(2000), b2wDailyCap: E(3000), b2wDelay: 15n * 60n };

async function deployChain(h: ChainH, peerChainId: number): Promise<void> {
  const { deployer, admin, wl, relayer, pauser, tokenDeployer, user1, user2, user3 } = ACCOUNTS;
  h.token = await deployRaw(h, tokenDeployer, artifact("MockToken", "MockToken").bytecode);
  for (const u of [user1, user2, user3, admin]) await h.write(tokenDeployer, "mint", [u.address, E(100_000)], h.token);

  const proxyPred = getContractAddress({ from: deployer.address, nonce: 2n });
  const tl = artifact("BridgeTimelock", "BridgeTimelock");
  h.timelock = await deployRaw(h, deployer, tl.bytecode, encodeAbiParameters([{ type: "address" }, { type: "address" }], [admin.address, proxyPred]));
  const implName = h.name === "bsc" ? "BscVaultV2" : "WantosBridgeV2";
  const impl = await deployRaw(h, deployer, artifact(implName, implName).bytecode);
  const base = { timelock: h.timelock, token: h.token, whitelistManager: wl.address, relayer: relayer.address, pauser: pauser.address, peerChainId: BigInt(peerChainId), peerBridge: proxyPred };
  const init =
    h.name === "bsc"
      ? encodeFunctionData({ abi: bscVaultV2Abi, functionName: "initialize", args: [{ ...base, params: BSC_PARAMS }] })
      : encodeFunctionData({
          abi: wantosBridgeV2Abi,
          functionName: "initialize",
          args: [{ ...base, params: WANTOS_PARAMS, supplyCeiling: (await h.pub.readContract({ address: h.token, abi: mockTokenAbi, functionName: "totalSupply" })) + E(10_000) }],
        });
  const proxy = artifact("ERC1967Proxy", "ERC1967Proxy");
  h.bridge = await deployRaw(h, deployer, proxy.bytecode, encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [impl, init]));
  if (h.bridge.toLowerCase() !== proxyPred.toLowerCase()) throw new Error("proxy address mismatch");
}

export async function whitelist(h: ChainH, addrs: Address[], allowed = true): Promise<void> {
  const sorted = [...addrs].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const nonce = (await h.pub.readContract({ address: h.bridge, abi: h.abi as typeof bscVaultV2Abi, functionName: "whitelistNonce" })) as bigint;
  const deadline = BigInt((await h.latest()).timestamp + 3600);
  const listHash = keccak256(encodeAbiParameters([{ type: "address[]" }], [sorted]));
  const sig = await h.wallet(ACCOUNTS.wl).signTypedData({
    account: ACCOUNTS.wl,
    domain: { name: h.name === "bsc" ? "BscVaultV2" : "WantosBridgeV2", version: "1", chainId: h.chainId, verifyingContract: h.bridge },
    types: { WhitelistBatch: [{ name: "listHash", type: "bytes32" }, { name: "count", type: "uint32" }, { name: "allowed", type: "bool" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "WhitelistBatch",
    message: { listHash, count: sorted.length, allowed, nonce, deadline },
  });
  await h.write(ACCOUNTS.tokenDeployer, "applyWhitelistBatch", [sorted, allowed, nonce, deadline, sig]);
}

export interface Harness {
  bsc: ChainH;
  wantos: ChainH;
  /** Chain snapshot ids taken right after the base setup. */
  base: { bsc: Hex; wantos: Hex };
  reset(): Promise<void>;
  stop(): void;
  /** Mine enough blocks that both chains' heads (BSC finalized / WANTOS -6) cover everything so far. */
  settle(): Promise<void>;
  isPaused(c: ChainName): Promise<boolean>;
}

export const BSC_LOCAL_ID = 5600;
export const WANTOS_LOCAL_ID = 13500;

export async function startHarness(): Promise<Harness> {
  const genesis = Math.floor(Date.now() / 1000);
  const [bsc, wantos] = await Promise.all([startAnvil("bsc", BSC_LOCAL_ID, genesis), startAnvil("wantos", WANTOS_LOCAL_ID, genesis)]);
  try {
    await deployChain(bsc, WANTOS_LOCAL_ID);
    await deployChain(wantos, BSC_LOCAL_ID);
    if (bsc.bridge !== wantos.bridge) throw new Error("bridges must share an address");
    for (const h of [bsc, wantos]) {
      await whitelist(h, [ACCOUNTS.user1.address, ACCOUNTS.user2.address, ACCOUNTS.user3.address]);
      await h.write(ACCOUNTS.admin, "approve", [h.bridge, E(50_000)], h.token);
      await h.write(ACCOUNTS.admin, "fund", [E(20_000)]);
    }
  } catch (e) {
    bsc.proc.kill();
    wantos.proc.kill();
    throw e;
  }
  const base = { bsc: await bsc.snapshot(), wantos: await wantos.snapshot() };
  const H: Harness = {
    bsc,
    wantos,
    base,
    reset: async () => {
      await bsc.revert(H.base.bsc);
      await wantos.revert(H.base.wantos);
      H.base = { bsc: await bsc.snapshot(), wantos: await wantos.snapshot() };
    },
    stop: () => {
      bsc.proc.kill();
      wantos.proc.kill();
    },
    settle: async () => {
      await bsc.mine(3);
      await wantos.mine(7);
    },
    isPaused: async (c) => {
      const h = c === "bsc" ? bsc : wantos;
      return (await h.pub.readContract({ address: h.bridge, abi: h.abi as typeof bscVaultV2Abi, functionName: "paused" })) as boolean;
    },
  };
  return H;
}
