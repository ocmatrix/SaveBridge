import { BaseError, HttpRequestError } from "viem";
import { describe, expect, it } from "vitest";
import { safeMessage } from "../../src/redact.js";

describe("safeMessage (fix 6): RPC URLs never reach stderr", () => {
  it("viem errors: only the shortMessage, no details / URL line", () => {
    const e = new HttpRequestError({ url: "https://bsc.example/v3/SECRETKEY", body: { method: "eth_chainId" }, details: "fetch failed" });
    expect(e.message).toContain("SECRETKEY"); // the raw message does carry it
    expect(safeMessage(e)).toBe(e.shortMessage);
    expect(safeMessage(e)).not.toMatch(/SECRETKEY|fetch failed|URL/);
  });
  it("plain errors: URLs are replaced, URL: lines dropped", () => {
    expect(safeMessage(new Error("connect to https://rpc.example/key/ABC123?apikey=Q failed"))).toBe("connect to <rpc-url> failed");
    expect(safeMessage(new Error("boom wss://x.example/SEC and http://127.0.0.1:8545/K"))).toBe("boom <rpc-url> and <rpc-url>");
    expect(safeMessage(new Error("first line\nURL: whatever-no-scheme/SECRET\nlast"))).toBe("first line\nlast");
    expect(safeMessage("str https://a/B")).toBe("str <rpc-url>");
  });
  it("viem shortMessage that itself contains a URL is still scrubbed", () => {
    const e = new BaseError("cannot reach http://10.0.0.1/v1/TOKEN");
    expect(safeMessage(e)).toBe("cannot reach <rpc-url>");
  });
});
