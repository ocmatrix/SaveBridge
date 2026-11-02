import { describe, expect, it } from "vitest";
import { checkRpcConfig, loadFromRpc, type OrderEventSpec, type PayoutEventSpec, type RpcSourceConfig, type SourceClient } from "../../src/source-rpc.js";
import { scanLegacy } from "../../src/scan.js";
import { R, T, tx } from "../helpers.js";

interface Call {
  address: string;
  fromBlock: bigint;
  toBlock: bigint;
  args?: Record<string, string>;
}

type FakeLog = { block: bigint; tx: string; li: number; args: Record<string, unknown>; addr?: string; emitter?: string; removed?: boolean };

function fakeClient(logs: FakeLog[], calls: Call[] = [], decimals: Record<string, number> = {}, head = 25n, chainId?: number): SourceClient {
  return {
    getChainId: (async () => chainId ?? -1) as unknown as SourceClient["getChainId"],
    getBlockNumber: (async () => head) as unknown as SourceClient["getBlockNumber"],
    readContract: (async ({ address }: { address: string }) => decimals[address] ?? 18) as unknown as SourceClient["readContract"],
    getLogs: (async (p: Call) => {
      calls.push({ address: p.address, fromBlock: p.fromBlock, toBlock: p.toBlock, ...(p.args ? { args: p.args } : {}) });
      return logs.filter((l) => l.block >= p.fromBlock && l.block <= p.toBlock && (l.addr === undefined || l.addr === p.address)).map((l) => ({ address: l.emitter ?? p.address, removed: l.removed, args: l.args, transactionHash: l.tx, logIndex: l.li, blockNumber: l.block }));
    }) as unknown as SourceClient["getLogs"],
    getBlock: (async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(T - 1000) + blockNumber })) as unknown as SourceClient["getBlock"],
  };
}

const OLD_BRIDGE = R(700);
const OLD_VAULT = R(701);
const TOKEN = R(800);
const TRANSFER = "event Transfer(address indexed from, address indexed to, uint256 value)";
const W_OUT = { chainId: 13555, address: TOKEN, event: TRANSFER, args: { from: OLD_BRIDGE }, fromBlock: 0n, toBlock: "latest" as const, decimals: 18, fields: { to: "to", amount: "value" } };
const W_OUT_LOG: FakeLog = { block: 2n, tx: tx("e"), li: 0, args: { from: OLD_BRIDGE, to: R(50), value: 1n }, addr: TOKEN };

describe("loadFromRpc", () => {
  it("chunks getLogs, maps fields, converts decimals, links payouts, resolves latest, stamps payout times", async () => {
    const wCalls: Call[] = [];
    const bCalls: Call[] = [];
    const wantos = fakeClient(
      [
        { block: 10n, tx: tx("a"), li: 0, args: { user: R(1), to: R(2), amount: 12_500_000n }, addr: OLD_BRIDGE },
        { block: 25n, tx: tx("a"), li: 1, args: { user: R(1), to: R(3), amount: 1n }, addr: OLD_BRIDGE },
        W_OUT_LOG,
      ],
      wCalls,
      {},
      25n,
      13555,
    );
    const bsc = fakeClient(
      [
        { block: 5n, tx: tx("b"), li: 0, args: { to: R(2), amount: 12_500_000n * 10n ** 12n, srcTx: tx("a"), srcIndex: 0n }, addr: OLD_VAULT },
        { block: 6n, tx: tx("c"), li: 2, args: { from: OLD_VAULT, to: R(9), value: 10n ** 18n }, addr: TOKEN },
      ],
      bCalls,
      {},
      9n,
      56,
    );
    const cfg: RpcSourceConfig = {
      chunk: 10n,
      orders: [{ chainId: 13555, address: OLD_BRIDGE, event: "event Locked(address indexed user, address to, uint256 amount)", fromBlock: 0n, toBlock: 25n, decimals: 6, direction: "W2B", fields: { from: "user", recipient: "to", amount: "amount" } }],
      payouts: [
        { chainId: 56, address: OLD_VAULT, event: "event Released(address indexed to, uint256 amount, bytes32 srcTx, uint256 srcIndex)", fromBlock: 0n, toBlock: "latest", decimals: 18, fields: { to: "to", amount: "amount", srcTxHash: "srcTx", srcLogIndex: "srcIndex" } },
        { chainId: 56, address: TOKEN, event: TRANSFER, args: { from: OLD_VAULT }, fromBlock: 0n, toBlock: "latest", decimals: 18, fields: { to: "to", amount: "value" } },
        W_OUT,
      ],
    };
    const d = await loadFromRpc(cfg, { 13555: wantos, 56: bsc });
    expect(wCalls.slice(0, 3).map((c) => [c.fromBlock, c.toBlock])).toEqual([
      [0n, 9n],
      [10n, 19n],
      [20n, 25n],
    ]);
    expect(bCalls[1]).toMatchObject({ args: { from: OLD_VAULT }, toBlock: 9n }); // "latest" -> head 9
    expect(d.orders).toEqual([
      { srcChainId: 13555, txHash: tx("a"), logIndex: 0, timestamp: T - 990, direction: "W2B", from: R(1), recipient: R(2), amount: "12.5" },
      { srcChainId: 13555, txHash: tx("a"), logIndex: 1, timestamp: T - 975, direction: "W2B", from: R(1), recipient: R(3), amount: "0.000001" },
    ]);
    expect(d.payouts[0]).toEqual({ chainId: 56, txHash: tx("b"), logIndex: 0, timestamp: T - 995, to: R(2), amount: "12.5", srcTxHash: tx("a"), srcLogIndex: 0 });
    expect(d.payouts[1]).toEqual({ chainId: 56, txHash: tx("c"), logIndex: 2, timestamp: T - 994, to: R(9), amount: "1" });
    const s = scanLegacy(d, { cutoverT: T });
    expect(s.entries.map((e) => e.status)).toEqual(["OLD_PAID", "PAYABLE"]);
  });

  const dep: OrderEventSpec = { chainId: 56, address: OLD_VAULT, event: "event Deposit(address indexed user, uint256 amount)", fromBlock: 0n, toBlock: 1n, decimals: 0, direction: "B2W", fields: { from: "user", amount: "amount" } };
  const bOut: PayoutEventSpec = { chainId: 56, address: TOKEN, event: TRANSFER, args: { from: OLD_VAULT }, fromBlock: 0n, toBlock: "latest", decimals: 18, fields: { to: "to", amount: "value" } };
  const wIn: PayoutEventSpec = { ...W_OUT, args: { from: OLD_BRIDGE } };
  const DEP_LOG: FakeLog = { block: 1n, tx: tx("a"), li: 0, args: { user: R(1), amount: 5n }, addr: OLD_VAULT };
  const OUT_LOG: FakeLog = { block: 1n, tx: tx("f"), li: 0, args: { from: OLD_VAULT, to: R(51), value: 1n }, addr: TOKEN };
  const clients = (bscLogs: FakeLog[], dec: Record<string, number> = {}, head = 1n) => ({ 56: fakeClient(bscLogs, [], dec, head, 56), 13555: fakeClient([W_OUT_LOG], [], {}, 2n, 13555) });

  it("orders without a recipient field; field / config errors", async () => {
    const d = await loadFromRpc({ orders: [dep], payouts: [bOut, wIn] }, clients([DEP_LOG, OUT_LOG]));
    expect(d.orders[0]).toMatchObject({ direction: "B2W", from: R(1), amount: "5" });
    expect(d.orders[0]!.recipient).toBeUndefined();
    await expect(loadFromRpc({ orders: [dep], payouts: [bOut, wIn] }, {})).rejects.toThrow(/no RPC client/);
    await expect(loadFromRpc({ orders: [{ ...dep, fields: { from: "nope", amount: "amount" } }], payouts: [bOut, wIn] }, clients([DEP_LOG, OUT_LOG]))).rejects.toThrow(/no argument "nope"/);
    await expect(loadFromRpc({ orders: [{ ...dep, fields: { from: "user", amount: "user" } }], payouts: [bOut, wIn] }, clients([DEP_LOG, OUT_LOG]))).rejects.toThrow(/not a uint/);
    await expect(loadFromRpc({ orders: [{ ...dep, toBlock: 0n, fromBlock: 1n }], payouts: [bOut, wIn] }, clients([DEP_LOG, OUT_LOG]))).rejects.toThrow(/toBlock < fromBlock/);
    await expect(loadFromRpc({ chunk: 0n, orders: [dep], payouts: [bOut, wIn] }, clients([DEP_LOG, OUT_LOG]))).rejects.toThrow(/chunk/);
    await expect(loadFromRpc({ orders: [{ ...dep, event: "function x()" }], payouts: [bOut, wIn] }, clients([DEP_LOG, OUT_LOG]))).rejects.toThrow();
    const pending = clients([]);
    pending[56].getLogs = (async () => [{ args: {}, transactionHash: null, logIndex: null, blockNumber: null }]) as unknown as SourceClient["getLogs"];
    await expect(loadFromRpc({ orders: [dep], payouts: [bOut, wIn] }, pending)).rejects.toThrow(/pending/);
  });

  it("rejects removed logs, logs from another contract, logs outside the asked range, and a decimals mismatch", async () => {
    const one = (l: Partial<FakeLog>) => clients([{ ...DEP_LOG, ...l }, OUT_LOG], { [TOKEN]: 18 });
    const spec = { ...dep, decimals: 6 };
    await expect(loadFromRpc({ orders: [spec], payouts: [bOut, wIn] }, one({ removed: true }))).rejects.toThrow(/removed/);
    await expect(loadFromRpc({ orders: [spec], payouts: [bOut, wIn] }, one({ emitter: R(1) }))).rejects.toThrow(/log from/);
    const wide = clients([OUT_LOG]);
    const real = wide[56].getLogs;
    wide[56].getLogs = (async (p: { address: string }) => (p.address === OLD_VAULT ? [{ address: p.address, args: { user: R(1), amount: 5n }, transactionHash: tx("a"), logIndex: 0, blockNumber: 9n }] : real(p as never))) as unknown as SourceClient["getLogs"];
    await expect(loadFromRpc({ orders: [spec], payouts: [bOut, wIn] }, wide)).rejects.toThrow(/outside 0\.\.1/);
    await expect(loadFromRpc({ orders: [{ ...spec, token: TOKEN }], payouts: [bOut, wIn] }, one({}))).rejects.toThrow(/has 18 decimals, config says 6/);
    expect((await loadFromRpc({ orders: [{ ...spec, decimals: 18, token: TOKEN }], payouts: [bOut, wIn] }, one({}))).orders).toHaveLength(1);
  });

  describe("A-1 / A-2: payout coverage fails closed", () => {
    it("A-R3-1: payout toBlock must be the literal \"latest\" — hex / decimal strings, numbers, bigints, wrong case, null, missing are config errors", async () => {
      const bad: unknown[] = ["0x1", "0x8", "1", 1, 1n, "Latest", "LATEST", "latest ", null, undefined, "", "finalized"];
      for (const toBlock of bad) {
        const cfg = { orders: [dep], payouts: [{ ...bOut, toBlock }, wIn] } as unknown as RpcSourceConfig;
        await expect(loadFromRpc(cfg, clients([DEP_LOG, OUT_LOG])), String(toBlock)).rejects.toThrow(/rpc-config: payout spec #0: toBlock must be the literal "latest"/);
        expect(() => checkRpcConfig(cfg), String(toBlock)).toThrow(/toBlock must be the literal "latest"/);
      }
      expect((await loadFromRpc({ orders: [dep], payouts: [bOut, wIn] }, clients([DEP_LOG, OUT_LOG]))).payouts).toHaveLength(2);
    });
    it("order toBlock: bigint or \"latest\" only; fromBlock and chunk must be bigints", async () => {
      for (const toBlock of ["0x1", "1", 1, "Latest", null, undefined]) {
        const cfg = { orders: [{ ...dep, toBlock }], payouts: [bOut, wIn] } as unknown as RpcSourceConfig;
        await expect(loadFromRpc(cfg, clients([DEP_LOG, OUT_LOG])), String(toBlock)).rejects.toThrow(/rpc-config: order spec #0: toBlock must be a bigint/);
      }
      expect((await loadFromRpc({ orders: [{ ...dep, toBlock: "latest" }], payouts: [bOut, wIn] }, clients([DEP_LOG, OUT_LOG]))).orders).toHaveLength(1);
      for (const fromBlock of ["0", "0x0", 0, null, -1n]) {
        const cfg = { orders: [{ ...dep, fromBlock }], payouts: [bOut, wIn] } as unknown as RpcSourceConfig;
        expect(() => checkRpcConfig(cfg), String(fromBlock)).toThrow(/fromBlock must be a bigint/);
        const cfg2 = { orders: [dep], payouts: [{ ...bOut, fromBlock }, wIn] } as unknown as RpcSourceConfig;
        expect(() => checkRpcConfig(cfg2), String(fromBlock)).toThrow(/payout spec #0: fromBlock must be a bigint/);
      }
      for (const chunk of ["5", 5, 0n]) expect(() => checkRpcConfig({ chunk, orders: [], payouts: [] })).toThrow(/chunk must be a bigint/);
      expect(() => checkRpcConfig({ chunk: 5n, orders: [], payouts: [] })).not.toThrow();
    });
    it("other config fields are checked too", () => {
      const ok = { orders: [dep], payouts: [bOut, wIn] };
      const bad: [Record<string, unknown>, RegExp][] = [
        [{ ...ok, orders: undefined }, /orders\[\] and payouts\[\]/],
        [{ ...ok, orders: [null] }, /order spec #0 is not an object/],
        [{ ...ok, orders: [{ ...dep, chainId: "56" }] }, /bad chainId/],
        [{ ...ok, orders: [{ ...dep, address: "0x12" }] }, /bad address/],
        [{ ...ok, orders: [{ ...dep, decimals: "18" }] }, /bad decimals/],
        [{ ...ok, orders: [{ ...dep, event: undefined }] }, /event signature/],
        [{ ...ok, orders: [{ ...dep, direction: "w2b" }] }, /bad direction/],
      ];
      for (const [c, re] of bad) expect(() => checkRpcConfig(c), String(re)).toThrow(re);
      expect(() => checkRpcConfig(null)).toThrow(/not an object/);
    });
    it("a payout spec returning no logs (e.g. wrong address) is an error", async () => {
      await expect(loadFromRpc({ orders: [dep], payouts: [{ ...bOut, address: R(999) }, wIn] }, clients([DEP_LOG, OUT_LOG]))).rejects.toThrow(/payout spec #0 .* returned no logs/);
    });
    it("orders need payout specs on their own chain and on another chain", async () => {
      await expect(loadFromRpc({ orders: [dep], payouts: [] }, clients([DEP_LOG]))).rejects.toThrow(/chain 56 has order specs but no payout spec/);
      await expect(loadFromRpc({ orders: [dep], payouts: [wIn] }, clients([DEP_LOG]))).rejects.toThrow(/chain 56 has order specs but no payout spec/);
      await expect(loadFromRpc({ orders: [dep], payouts: [bOut] }, clients([DEP_LOG, OUT_LOG]))).rejects.toThrow(/payout spec on the other chain/);
      expect((await loadFromRpc({ orders: [], payouts: [] }, {})).orders).toEqual([]);
    });
    it("an RPC serving another chain id is an error", async () => {
      await expect(loadFromRpc({ orders: [dep], payouts: [bOut, wIn] }, { 56: fakeClient([DEP_LOG, OUT_LOG], [], {}, 1n, 97), 13555: fakeClient([W_OUT_LOG], [], {}, 2n, 13555) })).rejects.toThrow(/RPC for chain 56 serves chain 97/);
    });
    it("a tx captured by two order specs is an error; two logs of one tx in one spec are fine", async () => {
      const both = clients([DEP_LOG, { ...DEP_LOG, li: 1, args: { user: R(1), amount: 6n } }, OUT_LOG]);
      await expect(loadFromRpc({ orders: [dep, { ...dep, direction: "W2B" }], payouts: [bOut, wIn] }, both)).rejects.toThrow(/captured by order specs #0 and #1/);
      expect((await loadFromRpc({ orders: [dep], payouts: [bOut, wIn] }, both)).orders).toHaveLength(2);
    });
  });
});
