import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import * as tool from "@bridge/offline-check";
import vectors from "@bridge/offline-check/vectors.json" with { type: "json" };
import { batchHashes, chunk, listHash, parseAddressList, MAX_BATCH } from "../../src/lib/normalize";

const P = vectors.params;

describe("page normalisation + hashing == offline tool (shared vectors)", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const p = parseAddressList(c.text);
      expect(p).toEqual(c.expect);
      expect(p).toEqual(tool.parseAddressList(c.text));
      if (c.batches.length === 0) return;
      const batches = chunk(p.addresses, c.batchSize);
      expect(batches.length).toBe(c.batches.length);
      batches.forEach((addrs, i) => {
        const v = c.batches[i]!;
        expect(listHash(addrs)).toBe(v.listHash);
        for (const side of ["bsc", "wantos"] as const) {
          const h = batchHashes({
            side,
            chainId: side === "bsc" ? P.bscChainId : P.wantosChainId,
            bridge: P.contract as `0x${string}`,
            addresses: addrs,
            allowed: c.allowed,
            nonce: BigInt(v[side].nonce),
            deadline: BigInt(P.deadline),
          });
          expect(h).toEqual({ listHash: v.listHash, count: v.count, domainHash: v[side].domainHash, messageHash: v[side].messageHash, digest: v[side].digest });
        }
      });
    });
  }

  it("random lists: page and tool agree (property check, 30 rounds)", () => {
    for (let r = 0; r < 30; r++) {
      const n = 1 + (r * 37) % 600;
      const addrs = Array.from({ length: n }, (_, i) => keccak256(toBytes(`r${r}-${i}`)).slice(0, 42));
      const text = addrs.map((a, i) => (i % 3 === 0 ? a.toUpperCase().replace("0X", "0x") : a)).join(i2s(r));
      const p = parseAddressList(text);
      expect(p).toEqual(tool.parseAddressList(text));
      for (const b of chunk(p.addresses)) expect(listHash(b)).toBe(tool.listHash(b));
    }
  });

  it("batch size bounds", () => {
    expect(MAX_BATCH).toBe(500);
    expect(() => chunk([], 0)).toThrow();
    expect(() => chunk([], 501)).toThrow();
  });
});

function i2s(r: number) {
  return ["\n", "\r\n", "\r"][r % 3]!;
}
