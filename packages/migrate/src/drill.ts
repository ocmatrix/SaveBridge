/**
 * Local drill on anvil (random localhost port, never a real network): deploy the PR-1 BSC vault +
 * timelock, fund it, schedule the legacy batches, verify the scheduled calldata against the manifest,
 * wait 48h, preflight, execute, check paid[oldKey] / balances / ΣLegacyPaid, and prove a second payment
 * of the same oldKey is rejected by the contract.
 */
import { bridgeTimelockAbi, bscVaultV2Abi } from "@bridge/abi";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  http,
  parseAbi,
  parseEther,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { buildManifest } from "./manifest.js";
import { buildProposals, verifyScheduledCall, type LegacyProposal } from "./proposal.js";
import { legacyPaidReader, preflightBatch, readLegacyPaid, reconcileLegacy, type ReconcileResult } from "./reconcile.js";
import type { Manifest, OldPayout } from "./types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"; // anvil's public default
export const LOCAL_CHAIN_ID = 5600;
const acct = (i: number): Account => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: i });
export const DRILL_ACCOUNTS = { deployer: acct(0), admin: acct(1), wl: acct(2), relayer: acct(3), pauser: acct(4), executor: acct(7), tokenDeployer: acct(9) };

export const tokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const ERR_ABI = [...bridgeTimelockAbi, ...bscVaultV2Abi];

function artifact(file: string, name: string): { bytecode: Hex } {
  const p = join(ROOT, "out", `${file}.sol`, `${name}.json`);
  if (!existsSync(p)) execSync("forge build", { cwd: ROOT, stdio: "ignore" });
  const j = JSON.parse(readFileSync(p, "utf8")) as { bytecode: { object: Hex } };
  return { bytecode: j.bytecode.object };
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

export interface LocalVault {
  url: string;
  chain: Chain;
  pub: PublicClient;
  proc: ChildProcess;
  vault: Address;
  timelock: Address;
  token: Address;
  /** Sends a tx and waits; throws `Error(revertName)` on revert. */
  send(a: Account, to: Address, data: Hex): Promise<{ hash: Hex; block: bigint }>;
  increaseTime(sec: number): Promise<void>;
  stop(): void;
}

export async function startLocalVault(chainId: number = LOCAL_CHAIN_ID): Promise<LocalVault> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--silent"], { stdio: "ignore" });
  const chain = defineChain({ id: chainId, name: `local-${chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const pub = createPublicClient({ chain, transport: http(url, { retryCount: 0 }) }) as PublicClient;
  const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try {
        up = (await pub.getChainId()) === chainId;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (!up) throw new Error("anvil did not start");
    const send = async (a: Account, to: Address | null, data: Hex): Promise<{ hash: Hex; block: bigint; created?: Address }> => {
      const w = createWalletClient({ account: a, chain, transport: http(url, { retryCount: 0 }) });
      if (to) {
        try {
          await pub.call({ account: a.address, to, data });
        } catch (e) {
          throw new Error(revertName(e));
        }
      }
      const hash = await w.sendTransaction({ account: a, chain, ...(to ? { to } : {}), data });
      const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 20 });
      if (r.status !== "success") throw new Error("reverted");
      return { hash, block: r.blockNumber, ...(r.contractAddress ? { created: r.contractAddress } : {}) };
    };
    const deploy = async (a: Account, bytecode: Hex, args: Hex = "0x"): Promise<Address> => {
      const r = await send(a, null, (bytecode + args.slice(2)) as Hex);
      if (!r.created) throw new Error("deploy failed");
      return getAddress(r.created);
    };
    const A = DRILL_ACCOUNTS;
    const token = await deploy(A.tokenDeployer, artifact("MockToken", "MockToken").bytecode);
    const proxyPred = getContractAddress({ from: A.deployer.address, nonce: 2n });
    const timelock = await deploy(A.deployer, artifact("BridgeTimelock", "BridgeTimelock").bytecode, encodeAbiParameters([{ type: "address" }, { type: "address" }], [A.admin.address, proxyPred]));
    const impl = await deploy(A.deployer, artifact("BscVaultV2", "BscVaultV2").bytecode);
    const E = (n: number): bigint => parseEther(String(n));
    const init = encodeFunctionData({
      abi: bscVaultV2Abi,
      functionName: "initialize",
      args: [{ timelock, token, whitelistManager: A.wl.address, relayer: A.relayer.address, pauser: A.pauser.address, peerChainId: 13500n, peerBridge: proxyPred, params: { dailyCap: E(5000), perAddrDailyCap: E(2000), largeThreshold: E(1000), releaseDelay: 12n * 3600n, minDeposit: E(10), maxDepositPerTx: E(2000) } }],
    });
    const vault = await deploy(A.deployer, artifact("ERC1967Proxy", "ERC1967Proxy").bytecode, encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [impl, init]));
    if (vault !== getAddress(proxyPred)) throw new Error("proxy address mismatch");
    return {
      url,
      chain,
      pub,
      proc,
      vault,
      timelock,
      token,
      send: (a, to, data) => send(a, to, data),
      increaseTime: async (sec) => {
        await rpc("evm_increaseTime", [sec]);
        await rpc("evm_mine", []);
      },
      stop: () => {
        proc.kill();
      },
    };
  } catch (e) {
    proc.kill();
    throw e;
  }
}

/** Name of the custom error behind a revert (timelock or vault ABI), else the short message. */
export function revertName(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError && r.data?.errorName) return r.data.errorName;
    const raw = e.walk((x) => typeof (x as { data?: unknown }).data === "string") as { data?: Hex } | null;
    if (raw?.data) {
      try {
        return decodeErrorResult({ abi: ERR_ABI, data: raw.data }).errorName;
      } catch {
        /* unknown selector */
      }
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Re-targets a manifest's entries at another vault (the local drill vault). */
export function retarget(m: Manifest, vault: Address, bscChainId: number): Manifest {
  return buildManifest(
    m.entries.map((e) => ({ oldKey: e.oldKey, srcChainId: e.srcChainId, srcTxHash: e.srcTxHash, srcLogIndex: e.srcLogIndex, direction: e.direction, timestamp: 1, payee: e.to, srcRecipient: e.srcRecipient, amount: e.amount, status: "PAYABLE" as const })),
    { bscChainId, vault, cutoverT: m.header.cutoverT },
  );
}

export interface DrillReport {
  manifestHash: Hex;
  batches: number;
  scheduled: Hex[];
  executed: Hex[];
  allPaidOnChain: boolean;
  vaultSpent: bigint;
  reconcile: ReconcileResult;
  duplicateRejectedWith: string;
  earlyExecuteRejectedWith: string;
}

export async function runDrill(lv: LocalVault, source: Manifest, oldPayouts: OldPayout[] = []): Promise<DrillReport> {
  const A = DRILL_ACCOUNTS;
  const m = retarget(source, lv.vault, LOCAL_CHAIN_ID);
  const startBlock = await lv.pub.getBlockNumber({ cacheTime: 0 });
  // 1. fund the vault with exactly the manifest total
  await lv.send(A.tokenDeployer, lv.token, encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [A.admin.address, m.total] }));
  await lv.send(A.admin, lv.token, encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [lv.vault, m.total] }));
  await lv.send(A.admin, lv.vault, encodeFunctionData({ abi: bscVaultV2Abi, functionName: "fund", args: [m.total] }));
  const balance = async (a: Address): Promise<bigint> => lv.pub.readContract({ address: lv.token, abi: tokenAbi, functionName: "balanceOf", args: [a] });
  const vaultBefore = await balance(lv.vault);
  const recipients = [...new Set(m.entries.map((e) => e.to))];
  const before = new Map(await Promise.all(recipients.map(async (r) => [r, await balance(r)] as const)));

  // 2. admin wallet schedules every batch; on-chain id must equal ours
  const ps = buildProposals(m, { timelock: lv.timelock });
  for (const p of ps) {
    await lv.send(A.admin, lv.timelock, p.scheduleCalldata);
    const id = await lv.pub.readContract({ address: lv.timelock, abi: bridgeTimelockAbi, functionName: "hashOperation", args: [p.target, p.value, p.payCalldata, p.predecessor, p.salt] });
    if (id !== p.operationId) throw new Error(`operation id mismatch for batch ${p.index}`);
  }

  // 3. whitelist wallet's check: every CallScheduled must decode to manifest rows
  const scheduled = await lv.pub.getContractEvents({ address: lv.timelock, abi: bridgeTimelockAbi, eventName: "CallScheduled", fromBlock: startBlock, strict: true });
  for (const ev of scheduled) {
    const a = ev.args as { target: Address; value: bigint; data: Hex; predecessor: Hex; delay: bigint };
    const c = verifyScheduledCall(a, m);
    if (!c.ok) throw new Error(`scheduled call does not match manifest: ${c.errors.join("; ")}`);
  }
  if (scheduled.length !== ps.length) throw new Error("CallScheduled count mismatch");

  // 4. too early -> timelock refuses
  let earlyExecuteRejectedWith = "";
  try {
    await lv.send(A.executor, lv.timelock, ps[0]!.executeCalldata);
  } catch (e) {
    earlyExecuteRejectedWith = (e as Error).message;
  }
  if (!earlyExecuteRejectedWith) throw new Error("execute before 48h succeeded");

  // 5. wait 48h, preflight, execute (anyone)
  await lv.increaseTime(48 * 3600 + 1);
  const isPaid = legacyPaidReader(lv.pub, lv.vault);
  const executed: Hex[] = [];
  for (const p of ps) {
    const pf = await preflightBatch(p.entries, { isLegacyPaid: isPaid, oldPayouts });
    if (!pf.ok) throw new Error(`preflight blocked batch ${p.index}: ${pf.blockers.join("; ")}`);
    executed.push((await lv.send(A.executor, lv.timelock, p.executeCalldata)).hash);
  }

  // 6. verify: paid[oldKey], balances, ΣLegacyPaid
  const paidFlags = await Promise.all(m.entries.map((e) => isPaid(e.oldKey)));
  const expectedPerRecipient = new Map<Address, bigint>();
  for (const e of m.entries) expectedPerRecipient.set(e.to, (expectedPerRecipient.get(e.to) ?? 0n) + e.amount);
  for (const [r, exp] of expectedPerRecipient) {
    const got = (await balance(r)) - before.get(r)!;
    if (got !== exp) throw new Error(`recipient ${r} received ${got}, expected ${exp}`);
  }
  const vaultSpent = vaultBefore - (await balance(lv.vault));
  const reconcile = reconcileLegacy([m], await readLegacyPaid(lv.pub, lv.vault, startBlock));

  // 7. a second payment of an already-paid oldKey (fresh salt so the timelock accepts the proposal) must revert
  const dup = buildProposals(m, { timelock: lv.timelock, exclude: new Set(m.entries.slice(1).map((e) => e.oldKey)) }, 1)[0]!;
  await lv.send(A.admin, lv.timelock, dup.scheduleCalldata);
  await lv.increaseTime(48 * 3600 + 1);
  const pf = await preflightBatch(dup.entries, { isLegacyPaid: isPaid, oldPayouts });
  if (pf.ok) throw new Error("preflight did not flag an already-paid oldKey");
  let duplicateRejectedWith = "";
  try {
    await lv.send(A.executor, lv.timelock, dup.executeCalldata);
  } catch (e) {
    duplicateRejectedWith = (e as Error).message;
  }
  return { manifestHash: m.hash, batches: ps.length, scheduled: ps.map((p: LegacyProposal) => p.operationId), executed, allPaidOnChain: paidFlags.every(Boolean), vaultSpent, reconcile, duplicateRejectedWith, earlyExecuteRejectedWith };
}
