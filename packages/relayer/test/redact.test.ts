import { describe, expect, it } from "vitest";
import { redact, errText } from "../src/redact";
import { FakeChain, bridgeOutLog } from "./helpers/fakeChain";
import { newMigratedDb } from "./helpers/db";
import { MemoryAlertSink } from "../src/alerts";
import { SafetyState } from "../src/safety";
import { WantosScanner } from "../src/chain/wantosScanner";
import { BscScanner } from "../src/chain/bscScanner";

const KEY = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const TX = "0x" + "ab".repeat(32);

describe("B3: secret redaction in exception text", () => {
  it.each([
    ["https://user:pass@rpc.example.com/v2/SECRETKEY?apikey=abc", "https://rpc.example.com/<redacted>"],
    ["wss://node.example.org/ws/123secret", "wss://node.example.org/<redacted>"],
    ["http://10.0.0.5:8545", "http://10.0.0.5:8545"],
    ["http://10.0.0.5:8545/", "http://10.0.0.5:8545/<redacted>"],
  ])("URL %s", (input, out) => {
    expect(redact(`HTTP request failed. URL: ${input} status 500`)).toBe(`HTTP request failed. URL: ${out} status 500`);
  });
  it("Authorization / Bearer values", () => {
    expect(redact('headers {"Authorization":"Basic dXNlcjpwYXNz"}')).not.toMatch(/dXNlcjpwYXNz/);
    expect(redact("Authorization: Bearer eyJhbGciOi.payload.sig")).not.toMatch(/eyJhbGciOi/);
    expect(redact("token bearer abc.def-ghi")).toBe("token bearer <redacted>");
  });
  it("64-hex key shapes, with or without 0x", () => {
    expect(redact(`bad key ${KEY} here`)).toBe("bad key <redacted-hex64> here");
    expect(redact(`bad key 0x${KEY}`)).toBe("bad key <redacted-hex64>");
  });
  it("counter-examples: ordinary text, numbers, addresses, short hex untouched", () => {
    const s = "order 12345 for 0x00000000000000000000000000000000000000aa failed: execution reverted 0xdeadbeef (nonce 7)";
    expect(redact(s)).toBe(s);
    expect(errText(new Error("plain"))).toBe("plain");
    expect(errText("str")).toBe("str");
  });

  it("scanner alerts carry redacted error text; structured data is not touched", async () => {
    const chain = new FakeChain(20);
    const primary = chain.reader("p");
    const cross = chain.reader("c");
    primary.getBlockNumber = async () => {
      throw new Error(`HTTP request failed. URL: https://rpc.example.com/v2/${KEY}?key=zzz`);
    };
    const alerts = new MemoryAlertSink();
    const db = await newMigratedDb();
    const s = new WantosScanner({ chainId: 1, bridge: "0x1111111111111111111111111111111111111111", primary, crossChecks: [cross], confirmations: 6, db, alerts, safety: new SafetyState(alerts), rescanBlocks: 100, maxBlockRange: 100, startBlock: 0n });
    await s.scanOnce();
    const msg = alerts.byKind("RPC_UNAVAILABLE")[0]!.message;
    expect(msg).toContain("https://rpc.example.com/<redacted>");
    expect(msg).not.toMatch(/zzz|v2/);
    expect(msg).not.toContain(KEY);
    const bs = new BscScanner({ chainId: 56, vault: "0x1111111111111111111111111111111111111111", readers: [primary, cross], db, alerts, safety: new SafetyState(alerts), rescanBlocks: 100, maxBlockRange: 100, startBlock: 0n });
    const { topics } = bridgeOutLog(1n, "0x00000000000000000000000000000000000000aa", 1n);
    cross.getLogs = async () => {
      throw new Error(`boom ${TX} Bearer sekrit`);
    };
    primary.getBlockNumber = async () => 20n;
    await bs.scanOnce();
    void topics;
    await alerts.emit({ kind: "ORDER_ONCHAIN_MISMATCH", message: "m", data: { eventKey: TX } });
    expect(alerts.byKind("ORDER_ONCHAIN_MISMATCH")[0]!.data!.eventKey).toBe(TX);
  });
});
