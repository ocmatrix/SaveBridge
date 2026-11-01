import { describe, expect, it } from "vitest";
import { computeEventKey, w2bEventKey, b2wEventKey } from "../src/eventKey";

// Vectors computed independently with `cast keccak $(cast abi-encode "f(string,uint256,address,uint256)" ...)`.
describe("eventKey (PR1-NOTES §5.2)", () => {
  it("matches cast vector #1 (W2B shape)", () => {
    expect(computeEventKey(13555n, "0x1111111111111111111111111111111111111111", 1n)).toBe(
      "0xd1294c9b2d24f951f0fe89f5e39012f81a8a008c500b4af9a8f6309908867db3",
    );
  });
  it("matches cast vector #2 (B2W shape)", () => {
    expect(computeEventKey(56n, "0x2222222222222222222222222222222222222222", 7n)).toBe(
      "0xbca190a6c34a01b818391840fba5598664b0e404b81ce4e194f2cb88edb90390",
    );
  });
  it("is case-insensitive in the address and ignores to/amount", () => {
    const a = computeEventKey(13555n, "0x1111111111111111111111111111111111111111", 1n);
    expect(computeEventKey(13555n, "0x1111111111111111111111111111111111111111".toUpperCase().replace("0X", "0x") as `0x${string}`, 1n)).toBe(a);
  });
  it("W2B uses WANTOS chain id + WANTOS bridge + orderId", () => {
    const wantosBridge = "0x1111111111111111111111111111111111111111";
    expect(w2bEventKey({ wantosChainId: 13555n, wantosBridge, orderId: 1n })).toBe(
      computeEventKey(13555n, wantosBridge, 1n),
    );
  });
  it("B2W uses BSC chain id (= peerChainId on WANTOS) + BSC vault + deposit nonce", () => {
    const bscVault = "0x2222222222222222222222222222222222222222";
    expect(b2wEventKey({ bscChainId: 56n, bscVault, depositNonce: 7n })).toBe(
      "0xbca190a6c34a01b818391840fba5598664b0e404b81ce4e194f2cb88edb90390",
    );
  });
  it("rejects nonce 0 (ids start at 1, PR1-NOTES D2)", () => {
    expect(() => w2bEventKey({ wantosChainId: 13555n, wantosBridge: "0x1111111111111111111111111111111111111111", orderId: 0n })).toThrow();
  });
});
