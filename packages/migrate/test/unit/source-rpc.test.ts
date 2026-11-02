import { describe, expect, it } from "vitest";
import { loadFromRpc, type RpcSourceConfig, type SourceClient } from "../../src/source-rpc.js";
import { scanLegacy } from "../../src/scan.js";
import { R, T, tx } from "../helpers.js";

interface Call {
  address: string;
  fromBlock: bigint;
  toBlock: bigint;
  args?: Record<string, string>;
}

type FakeLog = { block: bigint; tx: string; li: number; args: Record<string, unknown>; addr?: string; emitter?: string; removed?: boolean };

function fakeClient(logs: FakeLog[], calls: Call[], decimals: Record<string, number> = {}): SourceClient {
  return {
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

describe("loadFromRpc", () => {
  it("chunks getLogs, maps fields, converts decimals, links payouts", async () => {
    const wCalls: Call[] = [];
    const bCalls: Call[] = [];
    const wantos = fakeClient(
      [
        { block: 10n, tx: tx("a"), li: 0, args: { user: R(1), to: R(2), amount: 12_500_000n } },
        { block: 25n, tx: tx("a"), li: 1, args: { user: R(1), to: R(3), amount: 1n } },
      ],
      wCalls,
    );
    const bsc = fakeClient(
      [
        { block: 5n, tx: tx("b"), li: 0, args: { to: R(2), amount: 12_500_000n * 10n ** 12n, srcTx: tx("a"), srcIndex: 0n }, addr: OLD_VAULT },
        { block: 6n, tx: tx("c"), li: 2, args: { from: OLD_VAULT, to: R(9), value: 10n ** 18n }, addr: R(800) },
      ],
      bCalls,
    );
    const cfg: RpcSourceConfig = {
      chunk: 10n,
      orders: [{ chainId: 13555, address: OLD_BRIDGE, event: "event Locked(address indexed user, address to, uint256 amount)", fromBlock: 0n, toBlock: 25n, decimals: 6, direction: "W2B", fields: { from: "user", recipient: "to", amount: "amount" } }],
      payouts: [
        { chainId: 56, address: OLD_VAULT, event: "event Released(address indexed to, uint256 amount, bytes32 srcTx, uint256 srcIndex)", fromBlock: 0n, toBlock: 9n, decimals: 18, fields: { to: "to", amount: "amount", srcTxHash: "srcTx", srcLogIndex: "srcIndex" } },
        { chainId: 56, address: R(800), event: "event Transfer(address indexed from, address indexed to, uint256 value)", args: { from: OLD_VAULT }, fromBlock: 0n, toBlock: 9n, decimals: 18, fields: { to: "to", amount: "value" } },
      ],
    };
    const d = await loadFromRpc(cfg, { 13555: wantos, 56: bsc });
    expect(wCalls.map((c) => [c.fromBlock, c.toBlock])).toEqual([
      [0n, 9n],
      [10n, 19n],
      [20n, 25n],
    ]);
    expect(bCalls[1]!.args).toEqual({ from: OLD_VAULT });
    expect(d.orders).toEqual([
      { srcChainId: 13555, txHash: tx("a"), logIndex: 0, timestamp: T - 990, direction: "W2B", from: R(1), recipient: R(2), amount: "12.5" },
      { srcChainId: 13555, txHash: tx("a"), logIndex: 1, timestamp: T - 975, direction: "W2B", from: R(1), recipient: R(3), amount: "0.000001" },
    ]);
    expect(d.payouts[0]).toEqual({ chainId: 56, txHash: tx("b"), logIndex: 0, to: R(2), amount: "12.5", srcTxHash: tx("a"), srcLogIndex: 0 });
    expect(d.payouts[1]).toEqual({ chainId: 56, txHash: tx("c"), logIndex: 2, to: R(9), amount: "1" });
    const s = scanLegacy(d, { cutoverT: T });
    expect(s.entries.map((e) => e.status)).toEqual(["OLD_PAID", "PAYABLE"]);
  });
  it("orders without a recipient field, and errors", async () => {
    const c = fakeClient([{ block: 1n, tx: tx("a"), li: 0, args: { user: R(1), amount: 5n } }], []);
    const spec = { chainId: 56, address: OLD_VAULT, event: "event Deposit(address indexed user, uint256 amount)", fromBlock: 0n, toBlock: 1n, decimals: 0, direction: "B2W" as const, fields: { from: "user", amount: "amount" } };
    const d = await loadFromRpc({ orders: [spec], payouts: [] }, { 56: c });
    expect(d.orders[0]).toMatchObject({ direction: "B2W", from: R(1), amount: "5" });
    expect(d.orders[0]!.recipient).toBeUndefined();
    await expect(loadFromRpc({ orders: [spec], payouts: [] }, {})).rejects.toThrow(/no RPC client/);
    await expect(loadFromRpc({ orders: [{ ...spec, fields: { from: "nope", amount: "amount" } }], payouts: [] }, { 56: c })).rejects.toThrow(/no argument "nope"/);
    await expect(loadFromRpc({ orders: [{ ...spec, fields: { from: "user", amount: "user" } }], payouts: [] }, { 56: c })).rejects.toThrow(/not a uint/);
    await expect(loadFromRpc({ orders: [{ ...spec, toBlock: 0n, fromBlock: 1n }], payouts: [] }, { 56: c })).rejects.toThrow(/toBlock < fromBlock/);
    await expect(loadFromRpc({ chunk: 0n, orders: [spec], payouts: [] }, { 56: c })).rejects.toThrow(/chunk/);
    await expect(loadFromRpc({ orders: [{ ...spec, event: "function x()" }], payouts: [] }, { 56: c })).rejects.toThrow();
    const pending = fakeClient([], []);
    pending.getLogs = (async () => [{ args: {}, transactionHash: null, logIndex: null, blockNumber: null }]) as unknown as SourceClient["getLogs"];
    await expect(loadFromRpc({ orders: [spec], payouts: [] }, { 56: pending })).rejects.toThrow(/pending/);
  });
  it("rejects removed logs, logs from another contract, logs outside the asked range, and a decimals mismatch", async () => {
    const spec = { chainId: 56, address: OLD_VAULT, event: "event Deposit(address indexed user, uint256 amount)", fromBlock: 0n, toBlock: 1n, decimals: 6, direction: "B2W" as const, fields: { from: "user", amount: "amount" } };
    const one = (l: Partial<FakeLog>) => ({ 56: fakeClient([{ block: 1n, tx: tx("a"), li: 0, args: { user: R(1), amount: 5n }, ...l }], [], { [R(800)]: 18 }) });
    await expect(loadFromRpc({ orders: [spec], payouts: [] }, one({ removed: true }))).rejects.toThrow(/removed/);
    await expect(loadFromRpc({ orders: [spec], payouts: [] }, one({ emitter: R(1) }))).rejects.toThrow(/log from/);
    const wide = { 56: fakeClient([{ block: 1n, tx: tx("a"), li: 0, args: { user: R(1), amount: 5n } }], []) };
    wide[56].getLogs = (async (p: { address: string }) => [{ address: p.address, args: { user: R(1), amount: 5n }, transactionHash: tx("a"), logIndex: 0, blockNumber: 9n }]) as unknown as SourceClient["getLogs"];
    await expect(loadFromRpc({ orders: [spec], payouts: [] }, wide)).rejects.toThrow(/outside 0\.\.1/);
    await expect(loadFromRpc({ orders: [{ ...spec, token: R(800) }], payouts: [] }, one({}))).rejects.toThrow(/has 18 decimals, config says 6/);
    expect((await loadFromRpc({ orders: [{ ...spec, decimals: 18, token: R(800) }], payouts: [] }, one({}))).orders).toHaveLength(1);
  });
  it("warns on a payout spec with no logs and on a tx captured by two order specs", async () => {
    const spec = { chainId: 56, address: OLD_VAULT, event: "event Deposit(address indexed user, uint256 amount)", fromBlock: 0n, toBlock: 1n, decimals: 0, direction: "B2W" as const, fields: { from: "user", amount: "amount" } };
    const c = fakeClient([{ block: 1n, tx: tx("a"), li: 0, args: { user: R(1), amount: 5n } }, { block: 1n, tx: tx("a"), li: 1, args: { user: R(1), amount: 6n } }], []);
    const pay = { chainId: 56, address: R(801), event: "event Transfer(address indexed from, address indexed to, uint256 value)", fromBlock: 0n, toBlock: 1n, decimals: 18, fields: { to: "to", amount: "value" } };
    const empty = fakeClient([], []);
    const d = await loadFromRpc({ orders: [spec, { ...spec, direction: "W2B" }], payouts: [pay] }, { 56: { ...c, getLogs: ((p: { address: string; fromBlock: bigint; toBlock: bigint }) => (p.address === R(801) ? empty.getLogs(p as never) : c.getLogs(p as never))) as SourceClient["getLogs"] } });
    expect(d.warnings).toEqual([expect.stringMatching(/captured by order specs #0 and #1/), expect.stringMatching(/payout spec #0 .* returned no logs/)]);
    // two logs of one tx in the same spec is normal: no warning
    expect((await loadFromRpc({ orders: [spec], payouts: [] }, { 56: c })).warnings).toEqual([]);
  });
});
