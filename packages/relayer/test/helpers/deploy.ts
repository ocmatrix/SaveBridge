import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  keccak256,
  parseEther,
  type Abi,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import type { Anvil } from "./anvil";
import type { Address, Hex } from "../../src/types";

const ROOT = resolve(__dirname, "../../../..");
function artifact(file: string, name: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(resolve(ROOT, "out", file, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export const U = 10n ** 18n;

/** anvil's well-known dev keys (public, local-only) */
const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
];

export interface Actors {
  funder: PrivateKeyAccount;
  admin: PrivateKeyAccount;
  wl: PrivateKeyAccount;
  pauser: PrivateKeyAccount;
  user: PrivateKeyAccount;
  user2: PrivateKeyAccount;
}

export function actors(): Actors {
  const [funder, admin, wl, pauser, user, user2] = ANVIL_KEYS.map((k) => privateKeyToAccount(k));
  return { funder: funder!, admin: admin!, wl: wl!, pauser: pauser!, user: user!, user2: user2! };
}

export interface Deployed {
  token: Address;
  timelock: Address;
  bridge: Address;
}

async function deployRaw(a: Anvil, from: PrivateKeyAccount, abi: Abi, bytecode: Hex, args: unknown[] = []): Promise<Address> {
  const hash = await a.walletClient.deployContract({ abi, bytecode, args, account: from, chain: a.chain });
  const r = await a.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error("deploy failed");
  return getAddress(r.contractAddress);
}

export async function deployToken(a: Anvil, from: PrivateKeyAccount): Promise<Address> {
  const t = artifact("MockToken.sol", "MockToken");
  return deployRaw(a, from, t.abi, t.bytecode);
}

export const BSC_PARAMS = {
  dailyCap: 5000n * U,
  perAddrDailyCap: 2000n * U,
  largeThreshold: 1000n * U,
  releaseDelay: 12n * 3600n,
  minDeposit: 10n * U,
  maxDepositPerTx: 2000n * U,
};
export const WANTOS_PARAMS = {
  w2bMinAmount: 10n * U,
  w2bPerAddrDailyCap: 2000n * U,
  b2wDailyCap: 3000n * U,
  b2wDelay: 15n * 60n,
};

/**
 * §5.1 deterministic deployment with a fresh deployer at nonce 0/1/2 (same deployer key on both chains
 * → same proxy address on both chains, which `initialize` enforces via peerBridge == address(this)).
 */
export async function deployBridge(
  a: Anvil,
  side: "bsc" | "wantos",
  o: { deployerKey: Hex; token: Address; relayer: Address; peerChainId: bigint; act: Actors; supplyCeiling?: bigint },
): Promise<Deployed> {
  const deployer = privateKeyToAccount(o.deployerKey);
  await a.testClient.setBalance({ address: deployer.address, value: parseEther("100") });
  const nonce = await a.publicClient.getTransactionCount({ address: deployer.address });
  if (nonce !== 0) throw new Error("deployer nonce must be 0");
  const tlAddr = getContractAddress({ from: deployer.address, nonce: 0n });
  const proxyAddr = getContractAddress({ from: deployer.address, nonce: 2n });
  const tl = artifact("BridgeTimelock.sol", "BridgeTimelock");
  const impl = artifact(side === "bsc" ? "BscVaultV2.sol" : "WantosBridgeV2.sol", side === "bsc" ? "BscVaultV2" : "WantosBridgeV2");
  const proxy = artifact("ERC1967Proxy.sol", "ERC1967Proxy");
  const timelock = await deployRaw(a, deployer, tl.abi, tl.bytecode, [o.act.admin.address, proxyAddr]);
  const implementation = await deployRaw(a, deployer, impl.abi, impl.bytecode);
  const base = {
    timelock: tlAddr,
    token: o.token,
    whitelistManager: o.act.wl.address,
    relayer: o.relayer,
    pauser: o.act.pauser.address,
    peerChainId: o.peerChainId,
    peerBridge: proxyAddr,
  };
  const initData =
    side === "bsc"
      ? encodeFunctionData({ abi: bscVaultV2Abi as Abi, functionName: "initialize", args: [{ ...base, params: BSC_PARAMS }] })
      : encodeFunctionData({
          abi: wantosBridgeV2Abi as Abi,
          functionName: "initialize",
          args: [{ ...base, params: WANTOS_PARAMS, supplyCeiling: o.supplyCeiling! }],
        });
  const bridge = await deployRaw(a, deployer, proxy.abi, proxy.bytecode, [implementation, initData]);
  if (timelock !== tlAddr || bridge !== proxyAddr) throw new Error("address prediction mismatch");
  return { token: o.token, timelock, bridge };
}

export const tokenAbi = artifact("MockToken.sol", "MockToken").abi;

export async function applyWhitelist(
  a: Anvil,
  side: "bsc" | "wantos",
  bridge: Address,
  act: Actors,
  addrs: Address[],
  allowed: boolean,
): Promise<void> {
  const abi = (side === "bsc" ? bscVaultV2Abi : wantosBridgeV2Abi) as Abi;
  const sorted = [...addrs].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
  const nonce = (await a.publicClient.readContract({ address: bridge, abi, functionName: "whitelistNonce" })) as bigint;
  const blk = await a.publicClient.getBlock();
  const deadline = blk.timestamp + 3600n;
  const listHash = keccak256(encodeAbiParameters([{ type: "address[]" }], [sorted]));
  const sig = await act.wl.signTypedData({
    domain: { name: side === "bsc" ? "BscVaultV2" : "WantosBridgeV2", version: "1", chainId: a.chain.id, verifyingContract: bridge },
    types: {
      WhitelistBatch: [
        { name: "listHash", type: "bytes32" },
        { name: "count", type: "uint32" },
        { name: "allowed", type: "bool" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "WhitelistBatch",
    message: { listHash, count: sorted.length, allowed, nonce, deadline },
  });
  await write(a, act.funder, bridge, abi, "applyWhitelistBatch", [sorted, allowed, nonce, deadline, sig]);
}

export async function write(a: Anvil, from: PrivateKeyAccount, address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<Hex> {
  const hash = await a.walletClient.writeContract({ address, abi, functionName, args, account: from, chain: a.chain });
  const r = await a.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted`);
  return hash;
}

export function newKey(): Hex {
  return generatePrivateKey();
}
