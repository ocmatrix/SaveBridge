import { describe, expect, it } from "vitest";
import { bridgeOutLog, depositedLog } from "./helpers/fakeChain";
import { b2wFromLog, w2bFromLog, BRIDGE_OUT_TOPIC, DEPOSITED_TOPIC } from "../src/chain/ingest";
import type { RawLog } from "../src/chain/reader";

const A = "0x1111111111111111111111111111111111111111" as const;
const U = "0x00000000000000000000000000000000000000aa" as const;
const raw = (x: { topics: `0x${string}`[]; data: `0x${string}` }): RawLog => ({
  address: A,
  ...x,
  blockNumber: 5n,
  blockHash: ("0x" + "11".repeat(32)) as `0x${string}`,
  transactionHash: ("0x" + "22".repeat(32)) as `0x${string}`,
  logIndex: 0,
});

describe("event decoding", () => {
  it("topic constants match the ABI", () => {
    expect(bridgeOutLog(1n, U, 1n).topics[0]).toBe(BRIDGE_OUT_TOPIC);
    expect(depositedLog(1n, U, U, 1n).topics[0]).toBe(DEPOSITED_TOPIC);
  });
  it("refuses to decode the wrong event as an order", () => {
    expect(() => w2bFromLog(raw(depositedLog(1n, U, U, 1n)), 13555, A)).toThrow();
    expect(() => b2wFromLog(raw(bridgeOutLog(1n, U, 1n)), 56, A)).toThrow();
  });
  it("decodes both directions", () => {
    expect(w2bFromLog(raw(bridgeOutLog(3n, U, 7n)), 13555, A)).toMatchObject({ direction: "W2B", srcEventNonce: 3n, amountWei: 7n, srcChain: 13555 });
    expect(b2wFromLog(raw(depositedLog(4n, U, A, 9n)), 56, A)).toMatchObject({ direction: "B2W", srcEventNonce: 4n, amountWei: 9n, srcChain: 56 });
  });
});
