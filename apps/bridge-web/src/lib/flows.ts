import { erc20Abi, parseEventLogs, zeroAddress, type Abi, type Account, type Address, type Hex, type WalletClient } from "viem";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import type { AppConfig } from "../config";
import { clientFor, type Clients } from "./clients";
import { assertAllowedCall, assertAllowedTarget } from "./guard";
import { buildExactApprove } from "./approve";

export interface TxContext {
  cfg: AppConfig;
  clients: Clients;
  /** Wallet client with an account; must be on the chain of the transaction. */
  wallet: WalletClient;
}

export type Step = "approve" | "send" | "confirming";
/** Progress callback; "confirming" carries the hash of the transaction just broadcast. */
export type StepFn = (s: Step, hash?: Hex) => void;

/** A check that the contract would fail, detected from reads before asking the wallet (same error names as on chain). */
export class PreflightError extends Error {
  constructor(
    readonly errorName: string,
    readonly args: readonly unknown[] = [],
  ) {
    super(`preflight: ${errorName}`);
    this.name = "PreflightError";
  }
}

export class WrongNetworkError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`wallet is on chain ${actual}, expected ${expected}`);
    this.name = "WrongNetworkError";
  }
}

/**
 * The transaction WAS broadcast (we have its hash) but waiting for the receipt failed (timeout, RPC down).
 * It may well be on chain: the page must not call this a failure nor invite a retry (B1).
 */
export class UnconfirmedTxError extends Error {
  constructor(
    readonly hash: Hex,
    readonly chainId: number,
    override readonly cause: unknown,
    /** "approve" = the allowance tx (the bridge tx was NOT sent); "send" = bridgeOut / deposit. */
    readonly kind: "approve" | "send" = "send",
    readonly nonce: number | null = null,
  ) {
    super(`transaction ${hash} sent but not confirmed`);
    this.name = "UnconfirmedTxError";
  }
}

export class TxRevertedError extends Error {
  constructor(readonly hash: Hex) {
    super(`transaction ${hash} reverted`);
    this.name = "TxRevertedError";
  }
}

function account(ctx: TxContext): Account {
  if (!ctx.wallet.account) throw new Error("wallet has no account");
  return ctx.wallet.account;
}

export interface GuardedRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

/**
 * The only path that asks the wallet to send a transaction. Asserts the target is one of the two bridges / two
 * USDT contracts of that chain (DESIGN §8.1), that the wallet is on that chain, and simulates first.
 */
export async function sendGuarded(ctx: TxContext, chainId: number, req: GuardedRequest): Promise<Hex> {
  assertAllowedCall(ctx.cfg, chainId, req.address, req.functionName, req.args);
  const actual = await ctx.wallet.getChainId();
  if (actual !== chainId) throw new WrongNetworkError(chainId, actual);
  const pc = clientFor(ctx.cfg, ctx.clients, chainId);
  const { request } = await pc.simulateContract({ ...req, account: account(ctx) } as never);
  const to = (request as { address: Address }).address;
  assertAllowedTarget(ctx.cfg, chainId, to);
  return ctx.wallet.writeContract({ ...(request as object), account: account(ctx), chain: pc.chain } as never);
}

async function confirm(ctx: TxContext, chainId: number, hash: Hex, kind: "approve" | "send") {
  const pc = clientFor(ctx.cfg, ctx.clients, chainId);
  let r;
  try {
    r = await pc.waitForTransactionReceipt({ hash });
  } catch (e) {
    // best effort: remember the nonce so a later re-check can tell "replaced / dropped" from "still pending"
    const nonce = await pc.getTransaction({ hash }).then((tx) => tx.nonce, () => null);
    throw new UnconfirmedTxError(hash, chainId, e, kind, nonce);
  }
  if (r.status !== "success") throw new TxRevertedError(hash);
  return r;
}

/** Approves exactly `amount` when the current allowance is lower; never an unlimited approval. */
async function ensureAllowance(ctx: TxContext, chainId: number, amount: bigint, onStep: StepFn): Promise<Hex | null> {
  const req = buildExactApprove(ctx.cfg, chainId, amount);
  const owner = account(ctx).address;
  const pc = clientFor(ctx.cfg, ctx.clients, chainId);
  const current = await pc.readContract({ address: req.address, abi: erc20Abi, functionName: "allowance", args: [owner, req.args[0]] });
  if (current >= amount) return null;
  onStep("approve");
  const hash = await sendGuarded(ctx, chainId, req);
  onStep("confirming", hash);
  await confirm(ctx, chainId, hash, "approve");
  return hash;
}

async function balanceCheck(ctx: TxContext, chainId: number, token: Address, amount: bigint) {
  const owner = account(ctx).address;
  const bal = await clientFor(ctx.cfg, ctx.clients, chainId).readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  if (bal < amount) throw new PreflightError("ERC20InsufficientBalance", [owner, bal, amount]);
}

/** WANTOS → BSC: preflight (§5.3 checks) → exact approve → bridgeOut → orderId. */
export async function bridgeOutFlow(ctx: TxContext, amount: bigint, onStep: StepFn) {
  const c = ctx.cfg.wantos;
  const user = account(ctx).address;
  const actual = await ctx.wallet.getChainId();
  if (actual !== c.id) throw new WrongNetworkError(c.id, actual);
  const pc = ctx.clients.wantos;
  const W = { address: c.bridge, abi: wantosBridgeV2Abi } as const;
  const [paused, wl, code, ceiling, ts, params, day] = await Promise.all([
    pc.readContract({ ...W, functionName: "paused" }),
    pc.readContract({ ...W, functionName: "whitelisted", args: [user] }),
    pc.getCode({ address: user }),
    pc.readContract({ ...W, functionName: "supplyCeiling" }),
    pc.readContract({ address: c.usdt, abi: erc20Abi, functionName: "totalSupply" }),
    pc.readContract({ ...W, functionName: "params" }),
    pc.readContract({ ...W, functionName: "currentDay" }),
  ]);
  if (paused) throw new PreflightError("EnforcedPause");
  const bscPaused = await ctx.clients.bsc.readContract({ address: ctx.cfg.bsc.bridge, abi: bscVaultV2Abi, functionName: "paused" });
  if (bscPaused) throw new PreflightError("EnforcedPause"); // B6: payout side paused
  if (!wl) throw new PreflightError("NotWhitelisted", [user]);
  if (code && code !== "0x") throw new PreflightError("ContractCaller", [user]);
  if (ts > ceiling) throw new PreflightError("SupplyCeilingExceeded", [ts, ceiling]);
  if (amount < params.w2bMinAmount) throw new PreflightError("AmountBelowMinimum", [amount, params.w2bMinAmount]);
  const used = await pc.readContract({ ...W, functionName: "addrDailyUsed", args: [day, user] });
  if (used + amount > params.w2bPerAddrDailyCap) {
    throw new PreflightError("AddrDailyCapExceeded", [user, used + amount, params.w2bPerAddrDailyCap]);
  }
  await balanceCheck(ctx, c.id, c.usdt, amount);

  const approveTxHash = await ensureAllowance(ctx, c.id, amount, onStep);
  onStep("send");
  const txHash = await sendGuarded(ctx, c.id, { ...W, abi: wantosBridgeV2Abi as Abi, functionName: "bridgeOut", args: [amount] });
  onStep("confirming", txHash);
  const r = await confirm(ctx, c.id, txHash, "send");
  const ev = parseEventLogs({ abi: wantosBridgeV2Abi, logs: r.logs, eventName: "BridgeOut" }).find(
    (l) => l.address.toLowerCase() === c.bridge.toLowerCase(),
  );
  if (!ev) throw new Error("BridgeOut event missing");
  return { orderId: ev.args.orderId, amount: ev.args.amount, txHash, approveTxHash };
}

/** BSC → WANTOS: preflight (§5.2 deposit checks) → exact approve → deposit(amount, recipient) → nonce. */
export async function depositFlow(ctx: TxContext, amount: bigint, recipient: Address, onStep: StepFn) {
  const c = ctx.cfg.bsc;
  if (!recipient || recipient.toLowerCase() === zeroAddress) throw new PreflightError("ZeroAddress");
  const actual = await ctx.wallet.getChainId();
  if (actual !== c.id) throw new WrongNetworkError(c.id, actual);
  const pc = ctx.clients.bsc;
  const B = { address: c.bridge, abi: bscVaultV2Abi } as const;
  const [paused, params] = await Promise.all([pc.readContract({ ...B, functionName: "paused" }), pc.readContract({ ...B, functionName: "params" })]);
  if (paused) throw new PreflightError("EnforcedPause");
  // the credit happens on WANTOS: refuse while it is paused or today's inbound cap cannot take the amount
  const W = { address: ctx.cfg.wantos.bridge, abi: wantosBridgeV2Abi } as const;
  const w = ctx.clients.wantos;
  const [wPaused, wParams, wDay] = await Promise.all([
    w.readContract({ ...W, functionName: "paused" }),
    w.readContract({ ...W, functionName: "params" }),
    w.readContract({ ...W, functionName: "currentDay" }),
  ]);
  if (wPaused) throw new PreflightError("EnforcedPause");
  const wUsed = await w.readContract({ ...W, functionName: "dailyUsed", args: [wDay] });
  if (wUsed + amount > wParams.b2wDailyCap) throw new PreflightError("DailyCapExceeded", [wUsed + amount, wParams.b2wDailyCap]);
  if (amount < params.minDeposit) throw new PreflightError("AmountBelowMinimum", [amount, params.minDeposit]);
  if (amount > params.maxDepositPerTx) throw new PreflightError("AmountAboveLimit", [amount, params.maxDepositPerTx]);
  await balanceCheck(ctx, c.id, c.usdt, amount);

  const approveTxHash = await ensureAllowance(ctx, c.id, amount, onStep);
  onStep("send");
  const txHash = await sendGuarded(ctx, c.id, { ...B, abi: bscVaultV2Abi as Abi, functionName: "deposit", args: [amount, recipient] });
  onStep("confirming", txHash);
  const r = await confirm(ctx, c.id, txHash, "send");
  const ev = parseEventLogs({ abi: bscVaultV2Abi, logs: r.logs, eventName: "Deposited" }).find(
    (l) => l.address.toLowerCase() === c.bridge.toLowerCase(),
  );
  if (!ev) throw new Error("Deposited event missing");
  return { nonce: ev.args.nonce, amount: ev.args.amount, txHash, approveTxHash };
}
