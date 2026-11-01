import { describe, expect, it } from "vitest";
import { redact } from "../../src/redact.js";
import { PauseExecutor, PauseOnlySigner, type PauseChainReader, type RawTxSender } from "../../src/pauser.js";
import type { Address, Hex } from "viem";

const KEY64 = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

describe("B3 redaction of error text", () => {
  it("strips URL userinfo, paths and queries (API keys), keeps the host", () => {
    const m = redact("HTTP request failed. URL: https://user:pass@bsc.example.com/v1/abcdef0123456789abcdef?apikey=SECRET123 Request body: {}");
    expect(m).not.toContain("pass");
    expect(m).not.toContain("abcdef0123456789abcdef");
    expect(m).not.toContain("SECRET123");
    expect(m).toContain("bsc.example.com");
    expect(redact("wss://node.example.org/ws/3f8a9b7c6d5e4f30a1b2")).not.toContain("3f8a9b7c6d5e4f30a1b2");
  });

  it("removes Authorization headers / bearer tokens and 64-hex strings (possible private keys)", () => {
    const m = redact(`headers: {"Authorization":"Bearer abc.def.ghi"} authorization: Basic Zm9vOmJhcg== key 0x${KEY64} raw ${KEY64}`);
    expect(m).not.toContain("abc.def.ghi");
    expect(m).not.toContain("Zm9vOmJhcg==");
    expect(m).not.toContain(KEY64);
  });

  it("leaves ordinary text and addresses intact", () => {
    expect(redact("nonce too low for 0x1111111111111111111111111111111111111111")).toBe("nonce too low for 0x1111111111111111111111111111111111111111");
  });

  it("PAUSE_FAILED details carry only redacted errors", async () => {
    const BR = "0x1111111111111111111111111111111111111111" as Address;
    const sender: RawTxSender = {
      address: "0x00000000000000000000000000000000000000aa" as Address,
      send: async (): Promise<Hex> => {
        throw new Error("HTTP request failed. URL: https://rpc.example.com/key/SUPERSECRETTOKEN123456 body: 0x" + KEY64);
      },
    };
    const reader: PauseChainReader = { paused: async () => false, waitReceipt: async () => "success" };
    const s = new PauseOnlySigner(sender, [BR]);
    const ex = new PauseExecutor({ bsc: s, wantos: s }, { bsc: reader, wantos: reader }, { bsc: BR, wantos: BR }, { attempts: 1, backoffMs: 0 });
    const r = await ex.pause("bsc");
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("SUPERSECRETTOKEN123456");
    expect(r.error).not.toContain(KEY64);
  });
});
