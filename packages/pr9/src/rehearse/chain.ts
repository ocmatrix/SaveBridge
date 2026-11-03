import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { bridgeTimelockAbi, bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  type Abi,
  type Account,
  type Address,
  type Chain as ViemChain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { assertChainAllowed, assertUrlAllowed, type Profile, type Side } from "./guard";

export const tokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const accessErrors = parseAbi([
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error TimelockUnexpectedOperationState(bytes32 operationId, bytes32 expectedStates)",
  "error TimelockUnauthorizedCaller(address caller)",
  "error TimelockInsufficientDelay(uint256 delay, uint256 minDelay)",
]);
export const ERRORS_ABI = [...bscVaultV2Abi, ...wantosBridgeV2Abi, ...bridgeTimelockAbi, ...accessErrors] as Abi;

/** Name of the custom error behind a revert, else a short message. */
export function revertName(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError && r.data?.errorName) return r.data.errorName;
    const raw = e.walk((x) => typeof (x as { data?: unknown }).data === "string" && /^0x[0-9a-f]{8}/i.test((x as { data: string }).data)) as { data?: Hex } | null;
    if (raw?.data) {
      try {
        return decodeErrorResult({ abi: ERRORS_ABI, data: raw.data }).errorName;
      } catch {
        /* unknown selector */
      }
    }
    const m = /reverted with reason string '([^']+)'|reverted: (.+)$/m.exec(e.message);
    if (m) return (m[1] ?? m[2] ?? "").trim();
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
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

export interface SentTx {
  hash: Hex;
  receipt: TransactionReceipt;
}

/** One chain: clients, a wallet per account, revert-aware sending, time control (anvil only). */
export class Chain {
  readonly pubs: PublicClient[];
  readonly viemChain: ViemChain;
  private id = 0;

  constructor(
    readonly side: Side,
    readonly chainId: number,
    readonly urls: string[],
    readonly profile: Profile,
    readonly proc: ChildProcess | null,
  ) {
    for (const u of urls) assertUrlAllowed(profile, u);
    this.viemChain = defineChain({ id: chainId, name: `pr9-${side}`, nativeCurrency: { name: "GAS", symbol: "GAS", decimals: 18 }, rpcUrls: { default: { http: [urls[0]!] } } });
    this.pubs = urls.map((u) => createPublicClient({ chain: this.viemChain, transport: http(u, { retryCount: profile === "local" ? 0 : 3, timeout: 30_000 }), pollingInterval: profile === "local" ? 50 : 1_000 }) as PublicClient);
  }

  get pub(): PublicClient {
    return this.pubs[0]!;
  }
  get url(): string {
    return this.urls[0]!;
  }
  get local(): boolean {
    return this.proc !== null;
  }

  /** Verifies every configured RPC serves the expected chain (guard re-check after eth_chainId). */
  async checkChainIds(): Promise<void> {
    for (const p of this.pubs) {
      const id = await p.getChainId();
      assertChainAllowed(this.profile, this.side, id);
      if (id !== this.chainId) throw new Error(`${this.side}: RPC serves chain ${id}, expected ${this.chainId}`);
    }
  }

  async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }) });
    const j = (await res.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result as T;
  }

  wallet(a: Account): WalletClient {
    return createWalletClient({ account: a, chain: this.viemChain, transport: http(this.url, { retryCount: this.local ? 0 : 3 }) });
  }

  /** Simulate (eth_call) then send; throws with the decoded revert name. Never broadcasts a tx that simulates to a revert. */
  async send(a: Account, to: Address | null, data: Hex, value = 0n): Promise<SentTx> {
    try {
      await this.pub.call({ account: a, to: to ?? undefined, data, value });
    } catch (e) {
      throw new Error(`revert:${revertName(e)}`);
    }
    const hash = await this.wallet(a).sendTransaction({ account: a, chain: this.viemChain, to: to ?? undefined, data, value } as never);
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: this.local ? 30_000 : 180_000 });
    if (receipt.status !== "success") throw new Error(`revert:mined-reverted ${hash}`);
    return { hash, receipt };
  }

  /**
   * Many txs from one account without waiting in between (explicit nonces), then all receipts.
   * Used for bulk test funding (mints / gas) so testnet setup is not N × block time.
   */
  async sendMany(a: Account, txs: Array<{ to: Address; data?: Hex; value?: bigint }>): Promise<void> {
    let nonce = await this.pub.getTransactionCount({ address: a.address, blockTag: "pending" });
    const w = this.wallet(a);
    const hashes: Hex[] = [];
    for (const t of txs) hashes.push(await w.sendTransaction({ account: a, chain: this.viemChain, to: t.to, data: t.data, value: t.value ?? 0n, nonce: nonce++, gas: t.data ? 200_000n : 21_000n } as never));
    for (const h of hashes) {
      const r = await this.pub.waitForTransactionReceipt({ hash: h, timeout: this.local ? 60_000 : 300_000 });
      if (r.status !== "success") throw new Error(`revert:bulk tx ${h}`);
    }
  }

  async write(a: Account, to: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<SentTx> {
    return this.send(a, to, encodeFunctionData({ abi, functionName, args } as never));
  }

  async read<T>(to: Address, abi: Abi, functionName: string, args: unknown[] = [], blockNumber?: bigint): Promise<T> {
    return (await this.pub.readContract({ address: to, abi, functionName, args, ...(blockNumber !== undefined ? { blockNumber } : {}) } as never)) as T;
  }

  /** Simulates the call and returns the revert name ("" if it would succeed). Sends nothing. */
  async simulateRevert(a: Account | Address, to: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<string> {
    try {
      await this.pub.call({ account: a, to, data: encodeFunctionData({ abi, functionName, args } as never) });
      return "";
    } catch (e) {
      return revertName(e);
    }
  }

  async latest(): Promise<{ number: bigint; timestamp: number; hash: Hex }> {
    const b = await this.pub.getBlock({ blockTag: "latest" });
    return { number: b.number, timestamp: Number(b.timestamp), hash: b.hash };
  }

  async mine(n = 1): Promise<void> {
    if (this.local) {
      await this.rpc("anvil_mine", [`0x${n.toString(16)}`, "0x1"]);
      return;
    }
    const target = (await this.pub.getBlockNumber()) + BigInt(n);
    while ((await this.pub.getBlockNumber()) < target) await new Promise((r) => setTimeout(r, 1_000));
  }

  async setNextTimestamp(ts: number): Promise<void> {
    if (!this.local) throw new Error("time travel is local-only");
    await this.rpc("evm_setNextBlockTimestamp", [ts]);
    await this.rpc("evm_mine", []);
  }

  async setBalance(addr: Address, wei: bigint): Promise<void> {
    if (!this.local) throw new Error("setBalance is local-only");
    await this.rpc("anvil_setBalance", [addr, `0x${wei.toString(16)}`]);
  }

  async snapshot(): Promise<Hex> {
    return this.rpc<Hex>("evm_snapshot");
  }
  async revertTo(id: Hex): Promise<void> {
    await this.rpc("evm_revert", [id]);
  }

  /** Stops only the anvil process this run spawned (by its own pid). */
  async stop(): Promise<void> {
    if (!this.proc || this.proc.exitCode !== null) return;
    const done = new Promise((r) => this.proc!.once("exit", r));
    this.proc.kill("SIGTERM");
    await Promise.race([done, new Promise((r) => setTimeout(r, 3_000))]);
  }
}

/** Spawns a local anvil on 127.0.0.1:<random port> (state is persisted through stage checkpoints, see checkpoint.ts). */
export async function spawnAnvil(side: Side, chainId: number, genesisTs: number, blockTimeSec?: number, loadStateFile?: string): Promise<Chain> {
  const port = await freePort();
  const args = ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--slots-in-an-epoch", "1", "--timestamp", String(genesisTs), "--silent", "--gas-price", "1000000000", "--base-fee", "1000000000"];
  if (blockTimeSec) args.push("--block-time", String(blockTimeSec));
  if (loadStateFile) args.push("--load-state", loadStateFile); // real-time rehearsal: interval mining like a testnet
  const proc = spawn("anvil", args, { stdio: "ignore" });
  const c = new Chain(side, chainId, [`http://127.0.0.1:${port}`], "local", proc);
  for (let i = 0; i < 200; i++) {
    try {
      await c.pub.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  await c.checkChainIds();
  return c;
}

/**
 * A second, independent client for the same local chain whose answers can be tampered with: RPC
 * disagreement / outage / stale-data fault injection (local profile only).
 */
export type Intercept = (method: string, params: unknown[]) => { handled: true; result: unknown } | { handled: false };
