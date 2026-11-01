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

  it("B5: with 3 RPCs, one serving the wrong chain is dropped with a level-1 alert and the watcher starts", async () => {
    const t = await makeWatcher(H, {
      endpoints: { bsc: [{ label: "a", client: H.bsc.pub }, { label: "b", client: tamperedClient(H.bsc, () => ({ handled: false })) }, { label: "oops-wantos", client: H.wantos.pub }] },
    });
    const a = t.sink.alerts.find((x) => x.code === "RPC_MISCONFIGURED")!;
    expect(a.level).toBe(1);
    expect(JSON.stringify(a.detail)).toContain("oops-wantos");
    expect((t.w as unknown as { d: { rpc: { bsc: { endpoints: unknown[] } } } }).d.rpc.bsc.endpoints).toHaveLength(2);
  });

  it("B5: with 3 RPCs, one disagreeing about decimals is dropped; the majority value is used", async () => {
    const six = tamperedClient(H.bsc, (m, p) => {
      const d = p[0] as { data?: string; input?: string } | undefined;
      const data = d?.data ?? d?.input;
      return m === "eth_call" && typeof data === "string" && data.startsWith("0x313ce567") ? { handled: true, result: `0x${"0".repeat(62)}06` } : { handled: false };
    });
    const t = await makeWatcher(H, { endpoints: { bsc: [{ label: "a", client: H.bsc.pub }, { label: "b", client: tamperedClient(H.bsc, () => ({ handled: false })) }, { label: "six", client: six }] } });
    expect(t.codes()).toContain("RPC_MISCONFIGURED");
  });

  it("R21: refuses when fewer than minRpcAgreement RPCs can be verified (one unreachable of two)", async () => {
    const down = tamperedClient(H.bsc, (m) => (m === "eth_chainId" ? { handled: true, result: new Error("down") } : { handled: false }));
    await expect(makeWatcher(H, { endpoints: { bsc: [{ label: "a", client: H.bsc.pub }, { label: "down", client: down }] } })).rejects.toThrow(/chainId/);
  });

  it("B6: starting from the .bak copy (main state file corrupt) raises a level-2 alert", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { FileStateStore, initialState } = await import("../../src/state.js");
    const dir = mkdtempSync(join(tmpdir(), "watcher-bak-"));
    const path = join(dir, "state.json");
    const st = new FileStateStore(path);
    await st.save(initialState());
    await st.save(initialState());
    writeFileSync(path, "{ torn");
    const t = await makeWatcher(H, { store: new FileStateStore(path) });
    expect(t.sink.alerts.find((a) => a.code === "STATE_RESTORED_FROM_BACKUP")!.level).toBe(2);
  });
});
