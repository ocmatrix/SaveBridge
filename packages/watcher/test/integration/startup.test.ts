/** B6: refuse to start on a mis-wired RPC (wrong chain) or tokens with different decimals. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../helpers/harness.js";
import { makeWatcher, tamperedClient } from "../helpers/watcher.js";

describe("startup assertions", () => {
  let H: Harness;
  beforeAll(async () => {
    H = await startHarness();
  });
  afterAll(() => H?.stop());

  it("starts when every RPC serves the configured chain and decimals match", async () => {
    await expect(makeWatcher(H)).resolves.toBeDefined();
  });

  it("refuses when the configured chainId differs from what the RPCs serve", async () => {
    await expect(makeWatcher(H, { config: (c) => void (c.chains.bsc.chainId = 56) })).rejects.toThrow(/chainId/);
  });

  it("refuses when one RPC of a chain actually serves the other chain", async () => {
    await expect(makeWatcher(H, { endpoints: { bsc: [{ label: "bsc", client: H.bsc.pub }, { label: "oops-wantos", client: H.wantos.pub }] } })).rejects.toThrow(/chainId/);
  });

  it("refuses when the two USDT tokens have different decimals", async () => {
    const six = () =>
      tamperedClient(H.bsc, (m, p) => {
        const d = p[0] as { data?: string; input?: string } | undefined;
        const data = d?.data ?? d?.input;
        return m === "eth_call" && typeof data === "string" && data.startsWith("0x313ce567") ? { handled: true, result: `0x${"0".repeat(62)}06` } : { handled: false };
      });
    await expect(makeWatcher(H, { endpoints: { bsc: [{ label: "a", client: six() }, { label: "b", client: six() }] } })).rejects.toThrow(/decimals/);
  });
});
