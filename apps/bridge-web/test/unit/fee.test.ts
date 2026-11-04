import { describe, expect, it, vi } from "vitest";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, type Address, type PublicClient, type WalletClient } from "viem";
import { bscVaultV2Abi } from "@bridge/abi";
import { bridgeOutFlow, depositFlow, PreflightError, sendGuarded, type TxContext } from "../../src/lib/flows";
import { quoteBridgeOutFee, quoteDepositFee } from "../../src/lib/fee";
import { assertAllowedCall, TargetNotAllowedError } from "../../src/lib/guard";
import { ERROR_KEYS, translateError } from "../../src/lib/errors";
import { zh } from "../../src/i18n/zh";
import { en } from "../../src/i18n/en";
import { BRIDGE, B_USDT, W_USDT, testConfig } from "../fixtures";

const USER = "0x00000000000000000000000000000000000000aa" as Address;
const BIG = 10n ** 30n;
const STOP = new Error("STOP-after-wallet");

type Reads = Record<string, unknown>;
function fakeClient(reads: Reads, extra: Record<string, unknown> = {}) {
  const simulate = vi.fn(async (a: Record<string, unknown>) => ({ request: { ...a } }));
  const client = {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (!(functionName in reads)) throw new Error(`unexpected read ${functionName}`);
      const v = reads[functionName];
      return typeof v === "function" ? (v as () => unknown)() : v;
    }),
    getCode: vi.fn(async () => "0x"),
    getBalance: vi.fn(async () => 0n),
    getGasPrice: vi.fn(async () => 50_000_000n),
    simulateContract: simulate,
    chain: { id: 0 },
    ...extra,
  };
  return { client: client as unknown as PublicClient, raw: client, simulate };
}

function setup(opts: { wantos?: Reads; bsc?: Reads; wantosExtra?: Record<string, unknown>; bscExtra?: Record<string, unknown> }) {
  const w = fakeClient({ paused: false, whitelisted: true, supplyCeiling: BIG, totalSupply: 1n, currentDay: 1n, addrDailyUsed: 0n, dailyUsed: 0n, balanceOf: BIG, allowance: BIG, params: { w2bMinAmount: 1n, w2bPerAddrDailyCap: BIG, b2wDailyCap: BIG }, quoteNativeFee: 0n, ...opts.wantos }, opts.wantosExtra);
  const b = fakeClient({ paused: false, balanceOf: BIG, allowance: BIG, params: { minDeposit: 1n, maxDepositPerTx: BIG }, quoteNativeFee: 0n, MAX_FEE: 2_000_000_000_000_000n, ...opts.bsc }, opts.bscExtra);
  const write = vi.fn(async (_req: Record<string, unknown>): Promise<never> => {
    throw STOP;
  });
  const wallet = { account: { address: USER }, getChainId: vi.fn(async () => 0), writeContract: write } as unknown as WalletClient;
  const make = (chainId: number): TxContext => {
    (wallet.getChainId as ReturnType<typeof vi.fn>).mockResolvedValue(chainId);
    return { cfg: testConfig, clients: { wantos: w.client, bsc: b.client }, wallet };
  };
  return { w, b, write, make };
}

describe("quoteBridgeOutFee (WANTOS, tiered by amount)", () => {
  it("asks the contract for the fee of exactly this amount", async () => {
    const { w } = setup({ wantos: { quoteNativeFee: 12n * 10n ** 18n } });
    const fee = await quoteBridgeOutFee(w.client, testConfig, 500n);
    expect(fee).toBe(12n * 10n ** 18n);
    expect(w.raw.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "quoteNativeFee", args: [500n], address: BRIDGE }));
  });
});

describe("quoteDepositFee (BSC): quoted at the current gas price, attached exactly", () => {
  const FEE = 500_000_000_000_000n; // 0.0005 BNB at 0.05 gwei
  it("asks the contract at the node's current gas price and returns the fee", async () => {
    const { b } = setup({ bsc: { quoteNativeFee: FEE } });
    expect(await quoteDepositFee(b.client, testConfig)).toBe(FEE);
    expect(b.raw.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "quoteNativeFee", args: [50_000_000n], address: BRIDGE }));
  });
  it("fee off: 0", async () => {
    const { b } = setup({ bsc: { quoteNativeFee: 0n } });
    expect(await quoteDepositFee(b.client, testConfig)).toBe(0n);
  });
});

describe("old contract without quoteNativeFee (the page is published before the upgrade runs)", () => {
  // the shape viem really throws for a call that reverts without data (an old bridge has no quoteNativeFee)
  const revertErr = () =>
    new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: bscVaultV2Abi, functionName: "quoteNativeFee" }), {
      abi: bscVaultV2Abi,
      functionName: "quoteNativeFee",
      args: [1n],
    });
  const netErr = () => Object.assign(new Error("fetch failed"), { name: "HttpRequestError" });
  it("a reverting quote means no fee (WANTOS)", async () => {
    const { w } = setup({});
    w.raw.readContract.mockRejectedValueOnce(revertErr());
    expect(await quoteBridgeOutFee(w.client, testConfig, 500n)).toBe(0n);
  });
  it("a reverting quote means no fee (BSC)", async () => {
    const { b } = setup({});
    b.raw.readContract.mockRejectedValueOnce(revertErr());
    expect(await quoteDepositFee(b.client, testConfig)).toBe(0n);
  });
  it("a network error is NOT treated as 'no fee': it propagates", async () => {
    const { w, b } = setup({});
    w.raw.readContract.mockRejectedValueOnce(netErr());
    await expect(quoteBridgeOutFee(w.client, testConfig, 500n)).rejects.toMatchObject({ name: "HttpRequestError" });
    b.raw.readContract.mockRejectedValueOnce(netErr());
    await expect(quoteDepositFee(b.client, testConfig)).rejects.toMatchObject({ name: "HttpRequestError" });
  });
});

describe("guard: value only goes to the bridge entry points", () => {
  it("rejects value on a USDT approve", () => {
    expect(() => assertAllowedCall(testConfig, 56, B_USDT, "approve", [BRIDGE], 1n)).toThrow(TargetNotAllowedError);
  });
  it("allows value on deposit and bridgeOut, and zero value anywhere allowed", () => {
    expect(() => assertAllowedCall(testConfig, 56, BRIDGE, "deposit", [1n, USER], 5n)).not.toThrow();
    expect(() => assertAllowedCall(testConfig, 13555, BRIDGE, "bridgeOut", [1n], 5n)).not.toThrow();
    expect(() => assertAllowedCall(testConfig, 56, B_USDT, "approve", [BRIDGE], 0n)).not.toThrow();
  });
});

describe("sendGuarded passes the value to the simulation and the wallet", () => {
  it("same value in both", async () => {
    const s = setup({});
    await expect(sendGuarded(s.make(56), 56, { address: BRIDGE, abi: [], functionName: "deposit", args: [1n, USER], value: 7n })).rejects.toBe(STOP);
    expect(s.b.simulate).toHaveBeenCalledWith(expect.objectContaining({ value: 7n }));
    expect(s.write).toHaveBeenCalledWith(expect.objectContaining({ value: 7n }));
  });
  it("it never sets a gas price or gas limit of its own: pricing is the wallet's business", async () => {
    const s = setup({});
    await expect(sendGuarded(s.make(56), 56, { address: BRIDGE, abi: [], functionName: "deposit", args: [1n, USER], value: 7n })).rejects.toBe(STOP);
    const sim = s.b.simulate.mock.calls[0]![0] as { gas?: bigint; gasPrice?: bigint };
    const sent = s.write.mock.calls[0]![0] as { gas?: bigint; gasPrice?: bigint };
    expect([sim.gas, sim.gasPrice, sent.gas, sent.gasPrice]).toEqual([undefined, undefined, undefined, undefined]);
  });
  it("without value the request carries none (old behaviour)", async () => {
    const s = setup({});
    await expect(sendGuarded(s.make(56), 56, { address: B_USDT, abi: [], functionName: "approve", args: [BRIDGE, 1n] })).rejects.toBe(STOP);
    expect((s.write.mock.calls[0]![0] as { value?: bigint }).value).toBeUndefined();
  });
});

describe("bridgeOutFlow pays the WANTOS fee exactly", () => {
  it("sends value = quoted fee", async () => {
    const fee = 12n * 10n ** 18n;
    const s = setup({ wantos: { quoteNativeFee: fee }, wantosExtra: { getBalance: vi.fn(async () => fee * 2n) } });
    await expect(bridgeOutFlow(s.make(13555), 500n, vi.fn())).rejects.toBe(STOP);
    expect(s.write).toHaveBeenCalledWith(expect.objectContaining({ functionName: "bridgeOut", value: fee }));
  });
  it("fee 0: value is 0, nothing else changes", async () => {
    const s = setup({ wantos: { quoteNativeFee: 0n } });
    await expect(bridgeOutFlow(s.make(13555), 500n, vi.fn())).rejects.toBe(STOP);
    const sent = s.write.mock.calls[0]![0] as { value?: bigint };
    expect(sent.value ?? 0n).toBe(0n);
  });
  it("native balance below the fee: stops before the wallet is asked", async () => {
    const fee = 12n * 10n ** 18n;
    const s = setup({ wantos: { quoteNativeFee: fee }, wantosExtra: { getBalance: vi.fn(async () => fee - 1n) } });
    await expect(bridgeOutFlow(s.make(13555), 500n, vi.fn())).rejects.toMatchObject({ name: "PreflightError", errorName: "InsufficientNativeForFee" });
    expect(s.write).not.toHaveBeenCalled();
  });
});

describe("depositFlow attaches the quoted BSC fee exactly", () => {
  const fee = 500_000_000_000_000n;
  it("sends value = quoted fee and no gas price of its own", async () => {
    const s = setup({ bsc: { quoteNativeFee: fee }, bscExtra: { getBalance: vi.fn(async () => 10n ** 18n) } });
    await expect(depositFlow(s.make(56), 100n, USER, vi.fn())).rejects.toBe(STOP);
    const sent = s.write.mock.calls[0]![0] as { functionName: string; value?: bigint; gasPrice?: bigint };
    expect(sent.functionName).toBe("deposit");
    expect(sent.value).toBe(fee);
    expect(sent.gasPrice).toBeUndefined();
  });
  it("fee 0: no value", async () => {
    const s = setup({ bsc: { quoteNativeFee: 0n } });
    await expect(depositFlow(s.make(56), 100n, USER, vi.fn())).rejects.toBe(STOP);
    expect((s.write.mock.calls[0]![0] as { value?: bigint }).value ?? 0n).toBe(0n);
  });
  it("BNB below the fee: stops before the wallet is asked", async () => {
    const s = setup({ bsc: { quoteNativeFee: fee }, bscExtra: { getBalance: vi.fn(async () => fee - 1n) } });
    await expect(depositFlow(s.make(56), 100n, USER, vi.fn())).rejects.toBeInstanceOf(PreflightError);
    expect(s.write).not.toHaveBeenCalled();
  });
  // approve goes through, the deposit stops at the wallet; quotes come from a list, one per read
  function withQuotes(quotes: bigint[], balance: bigint) {
    let n = 0;
    const s = setup({ bsc: { quoteNativeFee: () => quotes[Math.min(n++, quotes.length - 1)]!, allowance: 0n }, bscExtra: { getBalance: vi.fn(async () => balance) } });
    s.write.mockImplementationOnce(async () => "0xabc" as never);
    (s.b.raw as Record<string, unknown>).waitForTransactionReceipt = vi.fn(async () => ({ status: "success", logs: [] }));
    return s;
  }
  it("sends the fee quoted AFTER the approval (the gas price may have moved a little)", async () => {
    const s = withQuotes([500_000_000_000_000n, 550_000_000_000_000n], 10n ** 18n); // +10%: inside the tolerance
    await expect(depositFlow(s.make(56), 100n, USER, vi.fn())).rejects.toBe(STOP);
    expect((s.write.mock.calls[1]![0] as { value?: bigint }).value).toBe(550_000_000_000_000n);
  });
  it("refuses to send when the fee jumped more than 25% since the user saw it: nothing is sent, nothing is charged", async () => {
    const s = withQuotes([500_000_000_000_000n, 800_000_000_000_000n], 10n ** 18n);
    await expect(depositFlow(s.make(56), 100n, USER, vi.fn())).rejects.toMatchObject({ name: "PreflightError", errorName: "FeeChanged" });
    expect(s.write).toHaveBeenCalledTimes(1); // only the approve
  });
  it("re-checks the balance against the fresh fee", async () => {
    const s = withQuotes([500_000_000_000_000n, 600_000_000_000_000n], 550_000_000_000_000n); // enough for the first, not the second
    await expect(depositFlow(s.make(56), 100n, USER, vi.fn())).rejects.toMatchObject({ name: "PreflightError", errorName: "InsufficientNativeForFee" });
    expect(s.write).toHaveBeenCalledTimes(1);
  });
});

describe("fee errors reach the user in plain words", () => {
  it.each(["WrongNativeFee", "NativeFeeTransferFailed"])("%s has keys in zh and en", (name) => {
    const key = ERROR_KEYS[name];
    expect(key).toBeDefined();
    expect(zh[key!].length).toBeGreaterThan(0);
    expect(en[key!].length).toBeGreaterThan(0);
  });
  it("a fee that jumped maps to its own message in zh and en", () => {
    const tr = translateError(new PreflightError("FeeChanged"), { decimals: 18 });
    expect(tr.key).toBe("err.feeChanged");
    expect(zh[tr.key].length).toBeGreaterThan(0);
    expect(en[tr.key].length).toBeGreaterThan(0);
  });
  it("the preflight 'not enough native coin' error maps to a message", () => {
    const tr = translateError(new PreflightError("InsufficientNativeForFee"), { decimals: 18 });
    expect(tr.key).toBe("err.insufficientNativeForFee");
    expect(zh[tr.key].length).toBeGreaterThan(0);
    expect(en[tr.key].length).toBeGreaterThan(0);
  });
});

void W_USDT;
