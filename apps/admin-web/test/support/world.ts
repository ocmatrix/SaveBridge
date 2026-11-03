import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import { makeChains, type Chains, type Signer } from "../../src/lib/chain";
import type { AppConfig, Side } from "../../src/lib/config";

const ROOT = resolve(__dirname, "../../../..");
function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(resolve(ROOT, "out", file, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}
export const tokenAbi = () => artifact("MockToken.sol", "MockToken").abi;

export const U = 10n ** 18n;
export const WANTOS_ID = 31337;
export const BSC_ID = 31338;

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

interface Node {
  url: string;
  proc: ChildProcess;
  client: PublicClient;
  test: ReturnType<typeof createTestClient>;
}

async function startAnvil(chainId: number): Promise<Node> {
  const port = await freePort();
  // --config-out carries a unique marker so leftover processes of THIS suite can be found by PID (never pkill -f).
  const marker = join(tmpdir(), `wantos-admin-web-anvil-${process.pid}-${port}.json`);
  const proc = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--silent", "--config-out", marker], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const transport = http(url, { retryCount: 0 });
  const client = createPublicClient({ transport, pollingInterval: 50 }) as PublicClient;
  for (let i = 0; i < 200; i++) {
    try {
      await client.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return { url, proc, client, test: createTestClient({ transport, mode: "anvil" }) };
}

export interface Actors {
  funder: PrivateKeyAccount;
  admin: PrivateKeyAccount;
  wl: PrivateKeyAccount;
  pauser: PrivateKeyAccount;
  relayer: PrivateKeyAccount;
  stranger: PrivateKeyAccount;
  newHolder: PrivateKeyAccount;
}

export interface World {
  cfg: AppConfig;
  chains: Chains;
  act: Actors;
  node: Record<Side, Node>;
  bridge: Address;
  token: Record<Side, Address>;
  /** advance both chains' clocks and mine */
  warp(seconds: number): Promise<void>;
  stop(): Promise<void>;
}

const BSC_PARAMS = { dailyCap: 5000n * U, perAddrDailyCap: 2000n * U, largeThreshold: 1000n * U, releaseDelay: 12n * 3600n, minDeposit: 10n * U, maxDepositPerTx: 2000n * U };
const WANTOS_PARAMS = { w2bMinAmount: 10n * U, w2bPerAddrDailyCap: 2000n * U, b2wDailyCap: 3000n * U, b2wDelay: 15n * 60n };

async function deploy(n: Node, chainId: number, side: Side, deployerKey: Hex, act: Actors, peerChainId: number): Promise<{ bridge: Address; token: Address }> {
  const chain = { id: chainId, name: side, nativeCurrency: { name: "E", symbol: "E", decimals: 18 }, rpcUrls: { default: { http: [n.url] } } };
  const w = createWalletClient({ chain, transport: http(n.url) });
  const dep = async (from: PrivateKeyAccount, a: { abi: Abi; bytecode: Hex }, args: unknown[] = []) => {
    const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args, account: from, chain });
    const r = await n.client.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error("deploy failed");
    return getAddress(r.contractAddress);
  };
  const token = await dep(act.funder, artifact("MockToken.sol", "MockToken"));
  const deployer = privateKeyToAccount(deployerKey);
  await n.test.setBalance({ address: deployer.address, value: parseEther("100") });
  const proxyAddr = getContractAddress({ from: deployer.address, nonce: 2n });
  const tl = await dep(deployer, artifact("BridgeTimelock.sol", "BridgeTimelock"), [act.admin.address, proxyAddr]);
  const impl = await dep(deployer, side === "bsc" ? artifact("BscVaultV2.sol", "BscVaultV2") : artifact("WantosBridgeV2.sol", "WantosBridgeV2"));
  const base = { timelock: tl, token, whitelistManager: act.wl.address, relayer: act.relayer.address, pauser: act.pauser.address, peerChainId: BigInt(peerChainId), peerBridge: proxyAddr };
  const init =
    side === "bsc"
      ? encodeFunctionData({ abi: bscVaultV2Abi as Abi, functionName: "initialize", args: [{ ...base, params: BSC_PARAMS }] })
      : encodeFunctionData({ abi: wantosBridgeV2Abi as Abi, functionName: "initialize", args: [{ ...base, params: WANTOS_PARAMS, supplyCeiling: 10_000_000n * U }] });
  const bridge = await dep(deployer, artifact("ERC1967Proxy.sol", "ERC1967Proxy"), [impl, init]);
  if (bridge !== proxyAddr) throw new Error("address prediction mismatch");
  return { bridge, token };
}

export async function startWorld(): Promise<World> {
  const [wn, bn] = await Promise.all([startAnvil(WANTOS_ID), startAnvil(BSC_ID)]);
  const node = { wantos: wn, bsc: bn };
  try {
    const k = (i: number) => privateKeyToAccount(generatePrivateKey());
    const act: Actors = { funder: k(0), admin: k(1), wl: k(2), pauser: k(3), relayer: k(4), stranger: k(5), newHolder: k(6) };
    for (const n of [wn, bn]) for (const a of Object.values(act)) await n.test.setBalance({ address: a.address, value: parseEther("1000") });
    const deployerKey = generatePrivateKey();
    const w = await deploy(wn, WANTOS_ID, "wantos", deployerKey, act, BSC_ID);
    const b = await deploy(bn, BSC_ID, "bsc", deployerKey, act, WANTOS_ID);
    const cfg: AppConfig = {
      wantos: { side: "wantos", chainId: WANTOS_ID, rpcUrl: wn.url, bridge: w.bridge, fromBlock: 0n },
      bsc: { side: "bsc", chainId: BSC_ID, rpcUrl: bn.url, bridge: b.bridge, fromBlock: 0n },
      adminApi: null,
      siweDomain: "admin.wanto.pro",
      submitApi: null,
    };
    const chains = makeChains(cfg, (c, chain) => createPublicClient({ chain, transport: http(c.rpcUrl, { retryCount: 0 }), pollingInterval: 50 }) as PublicClient);
    return {
      cfg,
      chains,
      act,
      node,
      bridge: w.bridge,
      token: { wantos: w.token, bsc: b.token },
      warp: async (s) => {
        for (const n of [wn, bn]) {
          await n.test.increaseTime({ seconds: s });
          await n.test.mine({ blocks: 1 });
        }
      },
      stop: async () => {
        wn.proc.kill("SIGTERM");
        bn.proc.kill("SIGTERM");
      },
    };
  } catch (e) {
    wn.proc.kill("SIGTERM");
    bn.proc.kill("SIGTERM");
    throw e;
  }
}

export interface LocalSigner extends Signer {
  /** Calls made, in order: "write:<chainId>:<fn>", "sign712:<chainId>", "sign:msg". */
  log: string[];
  /** Make the next matching call throw (simulates a wallet rejection / dropped connection). */
  failNext(pattern: RegExp, message?: string): void;
}

/** A Signer backed by a local test key (stands in for the browser wallet). */
export function localSigner(world: World, account: PrivateKeyAccount): LocalSigner {
  const fails: { re: RegExp; msg: string }[] = [];
  const log: string[] = [];
  const check = (tag: string) => {
    log.push(tag);
    const i = fails.findIndex((f) => f.re.test(tag));
    if (i >= 0) {
      const [f] = fails.splice(i, 1);
      throw new Error(f!.msg);
    }
  };
  const ctxFor = (chainId: number) => (chainId === BSC_ID ? world.chains.bsc : world.chains.wantos);
  return {
    address: account.address,
    log,
    failNext: (re, msg = "User rejected the request.") => fails.push({ re, msg }),
    async write(chainId, req) {
      check(`write:${chainId}:${req.functionName}`);
      const ctx = ctxFor(chainId);
      const w = createWalletClient({ chain: ctx.chain, transport: http(ctx.cfg.rpcUrl) });
      return w.writeContract({ address: req.address, abi: req.abi, functionName: req.functionName, args: req.args ?? [], account, chain: ctx.chain, gas: 5_000_000n });
    },
    async signTypedData(chainId, td) {
      check(`sign712:${chainId}`);
      // the whitelist domain carries no chainId (one signature serves both chains); a wallet must not be handed one either
      if ((td.domain as { chainId?: number | bigint }).chainId !== undefined) throw new Error("wallet: unexpected chainId in whitelist domain");
      return account.signTypedData(td as Parameters<PrivateKeyAccount["signTypedData"]>[0]);
    },
    async signMessage(message) {
      check("sign:msg");
      return account.signMessage({ message });
    },
  };
}
