/**
 * deploy-prep: the production watcher wiring (resolveDeployConfig → guarded RPCs → keystore PAUSER) on
 * two local anvils. Endpoint URLs carry the production host names but a recording inner transport routes
 * them to 127.0.0.1 anvils and logs (host, method): nothing leaves this machine.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { custom, http, type HDAccount, type Transport } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { encryptKeystore, writeKeystoreFile } from "@bridge/ops";
import { buildGuardedRpc, buildPauseSenders, resolveDeployConfig } from "../../src/deploy.js";
import { PauseExecutor, PauseOnlySigner } from "../../src/pauser.js";
import { multiRpcPauseReader } from "../../src/wiring.js";
import { Watcher } from "../../src/watcher.js";
import { MemoryAlertSink } from "../../src/alerts.js";
import { MemoryHeartbeat } from "../../src/heartbeat.js";
import { FileStateStore } from "../../src/state.js";
import { ACCOUNTS, BSC_LOCAL_ID, startHarness, WANTOS_LOCAL_ID, type Harness } from "../helpers/harness.js";

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASS = "watcher-e2e-passphrase-0123456789";
const WRITE = /^(eth_sendRawTransaction|eth_sendTransaction|eth_sign.*|personal_.*)$/;

describe("watcher deploy wiring with a keystore PAUSER", () => {
  let H: Harness;
  const dir = mkdtempSync(join(tmpdir(), "sb-wdeploy-"));
  beforeAll(async () => {
    H = await startHarness();
  });
  afterAll(() => {
    H?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads go to all three WANTOS sources; pause() is signed by the keystore key and sent ONLY to rpc3", async () => {
    const ksDir = join(dir, "keystore");
    const cd = join(dir, "creds");
    mkdirSync(ksDir, { mode: 0o700 });
    mkdirSync(cd, { mode: 0o700 });
    const mk = async (name: string, key: Uint8Array) => {
      const ks = await encryptKeystore(key, Buffer.from(PASS), { label: name, scrypt: FAST });
      writeKeystoreFile(join(ksDir, `${name}.json`), ks);
      writeFileSync(join(cd, `${name}-pass`), PASS, { mode: 0o400 });
      return { keystorePath: join(ksDir, `${name}.json`), passphraseCredential: `${name}-pass`, address: ks.address };
    };
    const pauserKey = (ACCOUNTS.pauser as HDAccount).getHdKey().privateKey!;
    const raw = JSON.parse(readFileSync(resolve(__dirname, "../../../../deploy/watcher.config.example.json"), "utf8"));
    const latest = { bsc: (await H.bsc.latest()).number, wantos: (await H.wantos.latest()).number };
    for (const [c, h, id] of [["bsc", H.bsc, BSC_LOCAL_ID], ["wantos", H.wantos, WANTOS_LOCAL_ID]] as const)
      Object.assign(raw.chains[c], { chainId: id, bridge: h.bridge, timelock: h.timelock, token: h.token, startBlock: String(latest[c] + 1n) });
    raw.dataDir = join(dir, "state");
    raw.gasWatch = [];
    raw.legacyAddresses = [];
    raw.runtime.pauser = { kind: "local-keystore", wantos: await mk("pauser-wantos", pauserKey), bsc: await mk("pauser-bsc", Buffer.from(generatePrivateKey().slice(2), "hex")) };
    raw.runtime.externalRpc = { maxRequestsPerMinute: 600, burst: 200, maxLogsBlockRange: 200 };
    const env = {
      WANTOS_RPC3_LOCAL: "http://127.0.0.1:8545",
      WANTOS_RPC1_READONLY: "https://rpc.wantos.io",
      WANTOS_RPC2_READONLY: "https://rpc2.wantos.io",
      BSC_RPC_1: "https://bsc-a.example.com",
      BSC_RPC_2: "https://bsc-b.example.org",
      BSC_RPC_3: "https://bsc-c.example.net",
      CREDENTIALS_DIRECTORY: cd,
      PEER_BSC_RPC_HOSTS: "bsc.payout-provider.io",
    };
    const calls: Array<{ host: string; method: string }> = [];
    const transportFor = (url: string): Transport => {
      const host = new URL(url).hostname;
      const inner = http(host.startsWith("bsc") ? H.bsc.url : H.wantos.url, { retryCount: 0 })({});
      return custom({ request: async (a: { method: string; params?: unknown }) => (calls.push({ host, method: a.method }), inner.request(a as never)) }, { retryCount: 0 });
    };

    const d = resolveDeployConfig(raw, env);
    const rpc = buildGuardedRpc(d, { transportFor });
    const senders = await buildPauseSenders(d, { transportFor, env, minN: 2 ** 10 });
    expect(senders.wantos.address).toBe(ACCOUNTS.pauser.address);
    // a pause() write endpoint serving another chain refuses to start
    const wrongRaw = structuredClone(raw);
    wrongRaw.runtime.pauseWriteRpcEnv.wantos = "BSC_RPC_2";
    await expect(buildPauseSenders(resolveDeployConfig(wrongRaw, env), { transportFor, env, minN: 2 ** 10 })).rejects.toThrow(/serves chainId/);
    // the same key for both chains is refused
    const sameRaw = structuredClone(raw);
    sameRaw.runtime.pauser = { kind: "local-keystore", wantos: await mk("same-a", pauserKey), bsc: await mk("same-b", pauserKey) };
    await expect(buildPauseSenders(resolveDeployConfig(sameRaw, env), { transportFor, env, minN: 2 ** 10 })).rejects.toThrow(/must differ/);

    const sink = new MemoryAlertSink();
    const w = new Watcher({
      config: d.core,
      rpc,
      store: new FileStateStore(join(dir, "state.json")),
      sink,
      pauser: new PauseExecutor(
        { bsc: new PauseOnlySigner(senders.bsc, [d.core.chains.bsc.bridge]), wantos: new PauseOnlySigner(senders.wantos, [d.core.chains.wantos.bridge]) },
        { bsc: multiRpcPauseReader(rpc.bsc, d.core.chains.bsc.bridge), wantos: multiRpcPauseReader(rpc.wantos, d.core.chains.wantos.bridge) },
        { bsc: d.core.chains.bsc.bridge, wantos: d.core.chains.wantos.bridge },
        { attempts: 1, backoffMs: 0 },
      ),
      heartbeat: new MemoryHeartbeat(),
      clock: () => Math.floor(Date.now() / 1000),
    });
    await w.init();
    await H.settle();
    await w.tick();
    expect(sink.alerts.filter((a) => a.level === 1)).toEqual([]);

    const exec = (w as unknown as { d: { pauser: PauseExecutor } }).d.pauser;
    const okW = await exec.pause("wantos");
    expect(okW).toMatchObject({ ok: true, status: "paused" });
    expect(await H.isPaused("wantos")).toBe(true);
    // a keystore key that is not the BSC PAUSER cannot pause (revert) → reported failure, chain untouched
    const badB = await exec.pause("bsc");
    expect(badB.ok).toBe(false);
    expect(await H.isPaused("bsc")).toBe(false);

    const writes = calls.filter((c) => WRITE.test(c.method));
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes.filter((c) => c.host === "rpc.wantos.io" || c.host === "rpc2.wantos.io")).toEqual([]);
    expect(writes.every((c) => c.host === "127.0.0.1" || c.host === "bsc-a.example.com")).toBe(true);
    const ext = calls.filter((c) => c.host === "rpc.wantos.io" || c.host === "rpc2.wantos.io");
    expect(new Set(ext.map((c) => c.host))).toEqual(new Set(["rpc.wantos.io", "rpc2.wantos.io"]));
    expect(ext.map((c) => c.method).includes("eth_getLogs")).toBe(true);
  });

  it("the kms placeholder cannot sign (refuses to build a PAUSER)", async () => {
    const raw = JSON.parse(readFileSync(resolve(__dirname, "../../../../deploy/watcher.config.example.json"), "utf8"));
    raw.runtime.pauser = { kind: "kms" };
    const env = { WANTOS_RPC3_LOCAL: "http://127.0.0.1:1", WANTOS_RPC1_READONLY: "https://rpc.wantos.io", WANTOS_RPC2_READONLY: "https://rpc2.wantos.io", BSC_RPC_1: "https://a.example", BSC_RPC_2: "https://b.example", BSC_RPC_3: "https://c.example", PEER_BSC_RPC_HOSTS: "payout.example.net" };
    await expect(buildPauseSenders(resolveDeployConfig(raw, env))).rejects.toThrow(/cannot sign/);
  });
});
