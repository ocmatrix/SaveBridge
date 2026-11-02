import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { custom, http, type Transport } from "viem";
import { encryptKeystore, writeKeystoreFile } from "@bridge/ops";
import { EXAMPLE_CONFIG, parseConfig, type RelayerConfig } from "../src/config";
import { assertChainIds, buildClients, buildRelayerDeps, buildSigners, resolveEndpoints } from "../src/bootstrap";
import { Relayer } from "../src/relayer";
import { OrderRepo } from "../src/orders";
import { MemoryAlertSink } from "../src/alerts";
import { SafetyState } from "../src/safety";
import { b2wEventKey, w2bEventKey } from "../src/eventKey";
import { newMigratedDb } from "./helpers/db";
import { newKey, U } from "./helpers/deploy";
import { balanceOf, bridgeOut, confirmWantos, deposit, finalizeBsc, startWorld, whitelistBoth, BSC_ID, WANTOS_ID, type World } from "./helpers/system";

/**
 * deploy-prep integration: the PRODUCTION wiring (bootstrap.ts: endpoint policy → guarded clients →
 * keystore signers → RelayerDeps) against two local anvils. The endpoint URLs are the production host
 * names, but a recording inner transport routes them to the local anvils and logs (host, method):
 * nothing leaves 127.0.0.1. Asserts that a W2B payout is signed by the keystore key and that no write
 * method ever reaches rpc.wantos.io / rpc2.wantos.io (while they are actually read from).
 */
const FAST = { N: 2 ** 10, r: 8, p: 1 };
const PASS = "e2e-keystore-passphrase-0123456789";
const WRITE = /^(eth_sendRawTransaction|eth_sendTransaction|eth_sign.*|personal_.*)$/;

describe("E2E with LocalKeystoreSigner through the production wiring", () => {
  let world: World;
  const dir = mkdtempSync(join(tmpdir(), "sb-e2e-ks-"));
  const calls: Array<{ host: string; method: string }> = [];

  beforeAll(async () => {
    world = await startWorld();
    await whitelistBoth(world, [world.act.user.address]);
  });
  afterAll(async () => {
    await world?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("W2B and B2W complete; keystore keys sign; rpc1/rpc2 get reads only", async () => {
    const ksDir = join(dir, "keystore");
    const cd = join(dir, "creds");
    mkdirSync(ksDir, { mode: 0o700 });
    mkdirSync(cd, { mode: 0o700 });
    const mk = async (name: string, key: `0x${string}`) => {
      const ks = await encryptKeystore(Buffer.from(key.slice(2), "hex"), Buffer.from(PASS), { label: name, scrypt: FAST });
      writeKeystoreFile(join(ksDir, `${name}.json`), ks);
      writeFileSync(join(cd, `${name}-pass`), PASS, { mode: 0o400 });
      return { keystorePath: join(ksDir, `${name}.json`), passphraseCredential: `${name}-pass`, address: ks.address };
    };
    const raw = JSON.parse(JSON.stringify(EXAMPLE_CONFIG)) as RelayerConfig;
    Object.assign(raw.wantos, { chainId: WANTOS_ID, bridgeAddress: world.w.bridge, startBlock: 0, primaryRpcUrlEnv: "WANTOS_RPC3", writeRpcUrlEnv: "WANTOS_RPC3", crossCheckRpcUrlEnvs: ["WANTOS_RPC1_READONLY", "WANTOS_RPC2_READONLY"] });
    Object.assign(raw.bsc, { chainId: BSC_ID, bridgeAddress: world.b.bridge, startBlock: 0, rpcUrlEnvs: ["BSC_RPC_1", "BSC_RPC_2", "BSC_RPC_3"] });
    raw.signer = { kind: "local-keystore", wantos: await mk("relayer-wantos", world.wantosRelayerKey), bsc: await mk("relayer-bsc", world.bscRelayerKey) };
    raw.submitter = { kind: "local-keystore", ...(await mk("submitter", newKey())) };
    raw.poll = { intervalMs: 5000, rescanBlocks: 100, maxBlockRange: 5000 };
    raw.gas = { wantosMinBalanceWei: "1", bscMinBalanceWei: "1" };
    raw.externalRpc = { maxRequestsPerMinute: 600, burst: 200, maxLogsBlockRange: 200 };
    raw.rpcNodes = { WANTOS_RPC3: "rpc3" };
    const cfg = parseConfig(raw);
    const env = {
      WANTOS_RPC3: "https://rpc3.wantos.io",
      WANTOS_RPC1_READONLY: "https://rpc.wantos.io",
      WANTOS_RPC2_READONLY: "https://rpc2.wantos.io",
      BSC_RPC_1: "https://bsc-a.example.com",
      BSC_RPC_2: "https://bsc-b.example.org",
      BSC_RPC_3: "https://bsc-c.example.net",
      CREDENTIALS_DIRECTORY: cd,
    };
    const route = (url: string): Transport => {
      const host = new URL(url).hostname;
      const target = host.includes("wantos") ? world.wantos.url : world.bsc.url;
      const inner = http(target, { retryCount: 0 })({});
      return custom(
        {
          request: async (args: { method: string; params?: unknown }) => {
            calls.push({ host, method: args.method });
            return inner.request(args as never);
          },
        },
        { retryCount: 0 },
      );
    };
    const ep = resolveEndpoints(cfg, env);
    const clients = buildClients(cfg, ep, { transportFor: route });
    await assertChainIds(cfg, clients, ep);
    const signers = await buildSigners(cfg, { env, minN: 2 ** 10 });
    expect(signers.bsc.address).toBe((await import("viem/accounts")).privateKeyToAccount(world.bscRelayerKey).address);

    const alerts = new MemoryAlertSink();
    const db = await newMigratedDb();
    const relayer = new Relayer(buildRelayerDeps({ cfg, clients, signers, db, alerts, safety: new SafetyState(alerts) }));
    await relayer.start();
    const repo = new OrderRepo(db);

    // W2B: BridgeOut on WANTOS → release on BSC, signed by the BSC keystore key
    const before = await balanceOf(world.bsc, world.b.token, world.act.user.address);
    await bridgeOut(world, world.act.user, 100n * U);
    await confirmWantos(world);
    await relayer.tick();
    const wKey = w2bEventKey({ wantosChainId: BigInt(WANTOS_ID), wantosBridge: world.w.bridge, orderId: 1n });
    expect((await repo.get(wKey))!.status).toBe("SUBMITTED");
    await finalizeBsc(world);
    await relayer.tick();
    expect((await repo.get(wKey))!.status).toBe("RELEASED");
    expect(await balanceOf(world.bsc, world.b.token, world.act.user.address)).toBe(before + 100n * U);
    const att = await db.query<{ from_addr: Buffer }>("select from_addr from tx_attempts where state = 'mined'");
    expect(`0x${Buffer.from(att.rows[0]!.from_addr).toString("hex")}`.toLowerCase()).toBe(signers.bsc.address.toLowerCase());

    // B2W: Deposited on BSC → queueRelease on WANTOS (a WANTOS write → must go to rpc3)
    await deposit(world, world.act.user, 50n * U, world.act.user.address);
    await finalizeBsc(world);
    await relayer.tick();
    const bKey = b2wEventKey({ bscChainId: BigInt(BSC_ID), bscVault: world.b.bridge, depositNonce: 1n });
    expect((await repo.get(bKey))!.status).toBe("SUBMITTED");
    expect(alerts.alerts.filter((a) => a.kind === "KMS_FAILURE")).toEqual([]);

    const writes = calls.filter((c) => WRITE.test(c.method));
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes.filter((c) => c.host === "rpc.wantos.io" || c.host === "rpc2.wantos.io")).toEqual([]);
    expect(new Set(writes.map((c) => c.host))).toEqual(new Set(["rpc3.wantos.io", "bsc-a.example.com"]));
    const external = calls.filter((c) => c.host === "rpc.wantos.io" || c.host === "rpc2.wantos.io");
    expect(external.length).toBeGreaterThan(0); // they really are used as cross-checks
    expect(new Set(external.map((c) => c.method)).size).toBeGreaterThan(0);
    for (const c of external) expect(c.method).toMatch(/^(eth_chainId|eth_getBlockByNumber|eth_getTransactionReceipt|eth_blockNumber|eth_getLogs|eth_call)$/);
  });
});
