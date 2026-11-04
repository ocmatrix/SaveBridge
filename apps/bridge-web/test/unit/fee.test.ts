import { describe, expect, it, vi } from "vitest";
import type { Address, PublicClient, WalletClient } from "viem";
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
      return reads[functionName];
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
  const b = fakeClient({ paused: false, balanceOf: BIG, allowance: BIG, params: { minDeposit: 1n, maxDepositPerTx: BIG }, quoteNativeFee: 0n, ...opts.bsc }, opts.bscExtra);
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

describe("quoteDepositFee (BSC, follows the gas price)", () => {
  it("quotes at the current gas price and sends 20% above the fee", async () => {
    const { b } = setup({ bsc: { quoteNativeFee: 500_000_000_000_000n } });
    const q = await quoteDepositFee(b.client, testConfig);
    expect(q.gasPrice).toBe(50_000_000n);
    expect(q.fee).toBe(500_000_000_000_000n);
    expect(q.value).toBe(600_000_000_000_000n);
    expect(b.raw.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "quoteNativeFee", args: [50_000_000n] }));
  });
  it("fee 0 (switched off) means no value and no gas price override", async () => {
    const { b } = setup({ bsc: { quoteNativeFee: 0n } });
    const q = await quoteDepositFee(b.client, testConfig);
    expect(q).toEqual({ fee: 0n, value: 0n, gasPrice: undefined });
  });
});

describe("old contract without quoteNativeFee (the page is published before the upgrade runs)", () => {
  const revertErr = () => Object.assign(new Error("reverted"), { name: "ContractFunctionExecutionError", cause: Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" }) });
  const netErr = () => Object.assign(new Error("fetch failed"), { name: "HttpRequestError" });
  it("a reverting quote means no fee (WANTOS)", async () => {
    const { w } = setup({});
    w.raw.readContract.mockRejectedValueOnce(revertErr());
    expect(await quoteBridgeOutFee(w.client, testConfig, 500n)).toBe(0n);
  });
  it("a reverting quote means no fee, no value, no gas price override (BSC)", async () => {
    const { b } = setup({});
    b.raw.readContract.mockRejectedValueOnce(revertErr());
    expect(await quoteDepositFee(b.client, testConfig)).toEqual({ fee: 0n, value: 0n, gasPrice: undefined });
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

describe("sendGuarded passes value and gasPrice to the simulation and the wallet", () => {
  it("same value and gasPrice in both, so the simulated tx.gasprice is the real one", async () => {
    const s = setup({});
    await expect(
      sendGuarded(s.make(56), 56, { address: BRIDGE, abi: [], functionName: "deposit", args: [1n, USER], value: 7n, gasPrice: 9n }),
    ).rejects.toBe(STOP);
    expect(s.b.simulate).toHaveBeenCalledWith(expect.objectContaining({ value: 7n, gasPrice: 9n }));
    expect(s.write).toHaveBeenCalledWith(expect.objectContaining({ value: 7n, gasPrice: 9n }));
  });
  it("without value the request carries none (old behaviour)", async () => {
    const s = setup({});
    await expect(sendGuarded(s.make(56), 56, { address: B_USDT, abi: [], functionName: "approve", args: [BRIDGE, 1n] })).rejects.toBe(STOP);
    const sent = s.write.mock.calls[0]![0];
    expect(sent.value).toBeUndefined();
    expect(sent.gasPrice).toBeUndefined();
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

describe("depositFlow pays the BSC fee with headroom at the quoted gas price", () => {
  const fee = 500_000_000_000_000n;
  it("sends value = fee x 1.2 and the same gasPrice it quoted at", async () => {
    const s = setup({ bsc: { quoteNativeFee: fee }, bscExtra: { getBalance: vi.fn(async () => 10n ** 18n) } });
    await expect(depositFlow(s.make(56), 100n, USER, vi.fn())).rejects.toBe(STOP);
    expect(s.write).toHaveBeenCalledWith(expect.objectContaining({ functionName: "deposit", value: 600_000_000_000_000n, gasPrice: 50_000_000n }));
  });
  it("fee 0: no value, no gas price override", async () => {
    const s = setup({ bsc: { quoteNativeFee: 0n } });
    await expect(depositFlow(s.make(56), 100n, USER, vi.fn())).rejects.toBe(STOP);
    const sent = s.write.mock.calls[0]![0] as { value?: bigint; gasPrice?: bigint };
    expect(sent.value ?? 0n).toBe(0n);
    expect(sent.gasPrice).toBeUndefined();
  });
  it("BNB below value: stops before the wallet is asked", async () => {
    const s = setup({ bsc: { quoteNativeFee: fee }, bscExtra: { getBalance: vi.fn(async () => 599_999_999_999_999n) } });
    await expect(depositFlow(s.make(56), 100n, USER, vi.fn())).rejects.toBeInstanceOf(PreflightError);
    expect(s.write).not.toHaveBeenCalled();
  });
});

describe("fee errors reach the user in plain words", () => {
  it.each(["WrongNativeFee", "NativeFeeTransferFailed"])("%s has keys in zh and en", (name) => {
    const key = ERROR_KEYS[name];
    expect(key).toBeDefined();
    expect(zh[key!].length).toBeGreaterThan(0);
    expect(en[key!].length).toBeGreaterThan(0);
  });
  it("the preflight 'not enough native coin' error maps to a message", () => {
    const tr = translateError(new PreflightError("InsufficientNativeForFee"), { decimals: 18 });
    expect(tr.key).toBe("err.insufficientNativeForFee");
    expect(zh[tr.key].length).toBeGreaterThan(0);
    expect(en[tr.key].length).toBeGreaterThan(0);
  });
});

void W_USDT;
