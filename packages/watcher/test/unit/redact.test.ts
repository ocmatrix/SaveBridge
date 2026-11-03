import { describe, expect, it } from "vitest";
import { errText, redact } from "../../src/redact.js";
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

  it("R16: a bare Bearer token (no Authorization header) is removed", () => {
    expect(redact("upstream said: Bearer abc123xyzTOKEN")).not.toContain("abc123xyzTOKEN");
  });

  it("B4: 64+ hex runs are removed whatever follows/precedes them (underscore, concatenation, longer hex)", () => {
    for (const t of [`k=${KEY64}_suffix`, `${KEY64}${KEY64}`, `0xdeadbeef01${KEY64}`, `x${KEY64}y`]) {
      const m = redact(t);
      expect(m).not.toMatch(/[0-9a-fA-F]{64}/);
      expect(m).not.toContain(KEY64.slice(0, 20));
    }
  });

  it("B4: x-api-key / api_key / apikey / token values outside URLs are removed", () => {
    const m = redact(`headers {"x-api-key": "SECRETA1"} api_key=SECRETB2 apikey: SECRETC3 token=SECRETD4 "token":"SECRETE5"`);
    for (const v of ["SECRETA1", "SECRETB2", "SECRETC3", "SECRETD4", "SECRETE5"]) expect(m).not.toContain(v);
  });

  it("B4: structured alert details (orderId / eventKey / txHash) are NOT redacted — only error text is", async () => {
    const { AlertManager, MemoryAlertSink } = await import("../../src/alerts.js");
    const { initialState } = await import("../../src/state.js");
    const st = initialState();
    const sink = new MemoryAlertSink();
    const am = new AlertManager(sink, () => st.meta, () => 1);
    const eventKey = `0x${KEY64}`;
    await am.raise("AUTO_PAUSE", { title: "t", detail: { orderId: "7", eventKey, txHash: eventKey } });
    expect(sink.alerts[0]!.detail).toEqual({ orderId: "7", eventKey, txHash: eventKey });
  });

  it("leaves ordinary text and addresses intact", () => {
    expect(redact("nonce too low for 0x1111111111111111111111111111111111111111")).toBe("nonce too low for 0x1111111111111111111111111111111111111111");
  });

  it("errText keeps the provider reason from a multi-line viem error, still redacts URLs and keys, and caps length", () => {
    const viemLike = new Error(
      `Invalid parameters were provided to the RPC method.\nDouble check you have provided the correct parameters.\n\nURL: https://bsc.example.com/v1/SECRETKEY999\nRequest body: {"method":"eth_getLogs"}\n\nDetails: block range extends beyond current head ${KEY64}\nVersion: viem@2`,
    );
    const t = errText(viemLike);
    expect(t).toContain("block range extends beyond current head");
    expect(t).not.toContain("SECRETKEY999");
    expect(t).not.toContain(KEY64);
    expect(errText(new Error("x".repeat(1000))).length).toBeLessThanOrEqual(400);
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
