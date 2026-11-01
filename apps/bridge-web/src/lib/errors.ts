import { ContractFunctionRevertedError, decodeErrorResult, type Abi, type Hex } from "viem";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import { t, type I18nKey, type Lang } from "../i18n";
import { formatAmount } from "./amount";

/** OZ v5 ERC-20 custom errors (a token may revert with these during transferFrom/approve). */
const erc20Errors = [
  { type: "error", name: "ERC20InsufficientBalance", inputs: [{ type: "address", name: "sender" }, { type: "uint256", name: "balance" }, { type: "uint256", name: "needed" }] },
  { type: "error", name: "ERC20InsufficientAllowance", inputs: [{ type: "address", name: "spender" }, { type: "uint256", name: "allowance" }, { type: "uint256", name: "needed" }] },
  { type: "error", name: "ERC20InvalidSender", inputs: [{ type: "address", name: "sender" }] },
  { type: "error", name: "ERC20InvalidReceiver", inputs: [{ type: "address", name: "receiver" }] },
  { type: "error", name: "ERC20InvalidApprover", inputs: [{ type: "address", name: "approver" }] },
  { type: "error", name: "ERC20InvalidSpender", inputs: [{ type: "address", name: "spender" }] },
] as const;

const ERROR_ABI: Abi = (() => {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  for (const item of [...(bscVaultV2Abi as Abi), ...(wantosBridgeV2Abi as Abi), ...(erc20Errors as unknown as Abi)]) {
    if (item.type !== "error") continue;
    const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
    if (!seen.has(sig)) (seen.add(sig), out.push(item));
  }
  return out;
})();

/**
 * Every custom error of both bridge ABIs (PR1-NOTES §5.11) → user message key.
 * Errors a normal user cannot trigger (admin / whitelist-signing / upgrade paths) share generic keys.
 */
export const ERROR_KEYS: Record<string, I18nKey> = {
  // user-facing reasons
  NotWhitelisted: "err.notWhitelisted",
  EnforcedPause: "err.paused",
  SupplyCeilingExceeded: "err.supplyCeiling",
  AmountBelowMinimum: "err.amountBelowMinimum",
  AmountAboveLimit: "err.amountAboveLimit",
  AddrDailyCapExceeded: "err.addrDailyCapExceeded",
  DailyCapExceeded: "err.dailyCapExceeded",
  ContractCaller: "err.contractCaller",
  ZeroAmount: "err.zeroAmount",
  ZeroAddress: "err.zeroAddress",
  SafeERC20FailedOperation: "err.tokenTransfer",
  FailedCall: "err.tokenTransfer",
  AddressEmptyCode: "err.tokenTransfer",
  ERC20InsufficientBalance: "err.insufficientBalance",
  ERC20InsufficientAllowance: "err.insufficientAllowance",
  ERC20InvalidSender: "err.tokenTransfer",
  ERC20InvalidReceiver: "err.tokenTransfer",
  ERC20InvalidApprover: "err.tokenTransfer",
  ERC20InvalidSpender: "err.tokenTransfer",
  // order / payout / deposit state
  BadOrderStatus: "err.orderState",
  BadDepositStatus: "err.orderState",
  BadPayoutStatus: "err.orderState",
  UnknownDeposit: "err.orderState",
  LegacyAlreadyPaid: "err.orderState",
  NotReady: "err.orderState",
  // operator-only paths
  AccessControlUnauthorizedAccount: "err.notPermitted",
  AccessControlBadConfirmation: "err.notPermitted",
  NotAdmin: "err.notPermitted",
  NotWhitelistManager: "err.notPermitted",
  NotAdminOrWhitelistManager: "err.notPermitted",
  NotTimelock: "err.notPermitted",
  NotAuthorized: "err.notPermitted",
  NotCandidate: "err.notPermitted",
  InvalidRole: "err.notPermitted",
  KeyConflict: "err.notPermitted",
  InvalidSigner: "err.notPermitted",
  // administrative procedures in progress / whitelist batch & parameter validation
  RecoveryInProgress: "err.adminState",
  RecoveryCooldown: "err.adminState",
  NoRecovery: "err.adminState",
  NothingPending: "err.adminState",
  Expired: "err.adminState",
  WhitelistWritesBlocked: "err.adminState",
  BadBatchSize: "err.adminState",
  AddressesNotSorted: "err.adminState",
  BadNonce: "err.adminState",
  SignatureExpired: "err.adminState",
  DeadlineTooFar: "err.adminState",
  ECDSAInvalidSignature: "err.adminState",
  ECDSAInvalidSignatureLength: "err.adminState",
  ECDSAInvalidSignatureS: "err.adminState",
  LengthMismatch: "err.adminState",
  NotTightening: "err.adminState",
  ParamOutOfRange: "err.adminState",
  ParamConstraint: "err.adminState",
  CeilingBelowSupply: "err.adminState",
  InvalidInit: "err.adminState",
  // framework internals
  ExpectedPause: "err.contractInternal",
  InvalidInitialization: "err.contractInternal",
  NotInitializing: "err.contractInternal",
  ReentrancyGuardReentrantCall: "err.contractInternal",
  UUPSUnauthorizedCallContext: "err.contractInternal",
  UUPSUnsupportedProxiableUUID: "err.contractInternal",
  ERC1967InvalidImplementation: "err.contractInternal",
  ERC1967NonPayable: "err.contractInternal",
};

export interface Translated {
  key: I18nKey;
  params?: Record<string, string>;
}

export interface ErrorContext {
  decimals: number;
}

function causes(err: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 20 && cur && typeof cur === "object"; i++) {
    out.push(cur as Record<string, unknown>);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

function fromCustomError(name: string, args: readonly unknown[] | undefined, ctx: ErrorContext): Translated | null {
  const key = ERROR_KEYS[name];
  if (!key) return null;
  const f = (x: unknown) => (typeof x === "bigint" ? formatAmount(x, ctx.decimals) : String(x));
  const a = args ?? [];
  switch (name) {
    case "AmountBelowMinimum":
    case "AmountAboveLimit":
      return { key, params: { amount: f(a[0]), limit: f(a[1]) } };
    case "AddrDailyCapExceeded":
      return { key, params: { used: f(a[1]), cap: f(a[2]) } };
    default:
      return { key };
  }
}

function fromText(text: string): Translated | null {
  const s = text.toLowerCase();
  if (/user (rejected|denied)|rejected the request|user cancel/.test(s)) return { key: "err.userRejected" };
  if (/insufficient funds/.test(s)) return { key: "err.insufficientGas" };
  if (/exceeds allowance|insufficient allowance/.test(s)) return { key: "err.insufficientAllowance" };
  if (/exceeds balance|insufficient balance/.test(s)) return { key: "err.insufficientBalance" };
  return null;
}

/** Turns any wallet / RPC / revert error into a fixed, user-safe message key (never raw text). */
export function translateError(err: unknown, ctx: ErrorContext): Translated {
  const chain = causes(err);
  for (const e of chain) {
    if (e.name === "TargetNotAllowedError") return { key: "err.targetNotAllowed" };
    if (e.code === 4001 || e.name === "UserRejectedRequestError") return { key: "err.userRejected" };
    if (e.name === "ChainMismatchError" || e.name === "ChainNotConfiguredError" || e.name === "WrongNetworkError") {
      return { key: "err.wrongNetwork" };
    }
  }
  for (const e of chain) {
    if (e instanceof ContractFunctionRevertedError && e.data?.errorName) {
      if (e.data.errorName === "Error") {
        const r = fromText(String(e.data.args?.[0] ?? ""));
        if (r) return r;
        continue;
      }
      const r = fromCustomError(e.data.errorName, e.data.args, ctx);
      if (r) return r;
    }
    for (const field of ["data", "raw"] as const) {
      const d = e[field];
      if (typeof d === "string" && /^0x[0-9a-fA-F]{8,}$/.test(d)) {
        try {
          const dec = decodeErrorResult({ abi: ERROR_ABI, data: d as Hex });
          const r = fromCustomError(dec.errorName, dec.args as readonly unknown[] | undefined, ctx);
          if (r) return r;
        } catch {
          /* not one of ours */
        }
      }
    }
  }
  for (const e of chain) {
    for (const field of ["reason", "details", "shortMessage", "message"] as const) {
      const v = e[field];
      if (typeof v === "string") {
        const r = fromText(v);
        if (r) return r;
      }
    }
  }
  for (const e of chain) {
    if (e.name === "HttpRequestError" || e.name === "TimeoutError" || e.name === "WebSocketRequestError") return { key: "err.network" };
  }
  return { key: "err.unknown" };
}

export function describeError(tr: Translated, lang: Lang): string {
  return t(lang, tr.key, tr.params);
}
