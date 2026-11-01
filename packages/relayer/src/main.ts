/**
 * Production entry point (skeleton). Not exercised by tests; never pointed at a real network from
 * this repository. Usage: RELAYER_CONFIG=/path/config.json RELAYER_DATABASE_URL=postgres://... tsx src/main.ts
 *
 * NOTE: KmsSigner is an interface placeholder in PR-3 and refuses to sign, so this process cannot
 * send transactions until the KMS implementation lands (see PR3-NOTES 待决).
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { createPublicClient, http, type PublicClient } from "viem";
import { parseConfig, type RelayerConfig } from "./config";
import { PgDb } from "./db/pg";
import { migrate } from "./db/migrations";
import { DedupAlertSink, LogAlertSink } from "./alerts";
import { SafetyState } from "./safety";
import { KmsSigner } from "./signer";
import { ViemChainReader } from "./chain/reader";
import { Relayer } from "./relayer";
import { createApi, ChainQuotaReader, DenyAllAdminSessions } from "./api";
import { TxSender } from "./chain/sender";
import { TimelockExecutor } from "./timelockExecutor";

const client = (url: string): PublicClient => createPublicClient({ transport: http(url, { retryCount: 2 }) }) as PublicClient;

async function main(): Promise<void> {
  const path = process.env.RELAYER_CONFIG;
  if (!path) throw new Error("RELAYER_CONFIG is required");
  const cfg: RelayerConfig = parseConfig(JSON.parse(readFileSync(path, "utf8")));
  const dbUrl = process.env[cfg.db.urlEnv];
  if (!dbUrl) throw new Error(`${cfg.db.urlEnv} is required`);
  const db = new PgDb(new pg.Pool({ connectionString: dbUrl }));
  await migrate(db);

  const alerts = new DedupAlertSink(new LogAlertSink(), 15 * 60_000);
  const safety = new SafetyState(alerts);
  safety.onReorg((side, info) => console.error(JSON.stringify({ event: "reorg", side, block: info.block.toString() })));

  const wPrimary = client(cfg.wantos.primaryRpcUrl);
  const bPrimary = client(cfg.bsc.rpcUrls[0]!);
  const relayer = new Relayer({
    db,
    alerts,
    safety,
    wantos: {
      chainId: cfg.wantos.chainId,
      bridge: cfg.wantos.bridgeAddress,
      client: wPrimary,
      primary: new ViemChainReader("wantos-primary", wPrimary),
      crossChecks: cfg.wantos.crossCheckRpcUrls.map((u, i) => new ViemChainReader(`wantos-cross-${i}`, client(u))),
      signer: new KmsSigner({ keyId: cfg.signer.wantosKeyId, address: cfg.signer.wantosAddress }),
      confirmations: cfg.wantos.confirmations,
      startBlock: BigInt(cfg.wantos.startBlock),
      minBalanceWei: BigInt(cfg.gas.wantosMinBalanceWei),
    },
    bsc: {
      chainId: cfg.bsc.chainId,
      vault: cfg.bsc.bridgeAddress,
      client: bPrimary,
      readers: cfg.bsc.rpcUrls.map((u, i) => new ViemChainReader(`bsc-${i}`, client(u))),
      signer: new KmsSigner({ keyId: cfg.signer.bscKeyId, address: cfg.signer.bscAddress }),
      startBlock: BigInt(cfg.bsc.startBlock),
      minBalanceWei: BigInt(cfg.gas.bscMinBalanceWei),
    },
    sender: cfg.tx,
    poll: { rescanBlocks: cfg.poll.rescanBlocks, maxBlockRange: cfg.poll.maxBlockRange },
    heartbeat: { staleAfterMs: cfg.heartbeat.staleAfterMs },
  });
  await relayer.start();

  const submitter = new KmsSigner({ keyId: cfg.submitter.keyId, address: cfg.submitter.address });
  const executors = [
    { chainId: cfg.wantos.chainId, c: wPrimary },
    { chainId: cfg.bsc.chainId, c: bPrimary },
  ].map(async ({ chainId, c }) => {
    const timelock = (await c.readContract({
      address: chainId === cfg.wantos.chainId ? cfg.wantos.bridgeAddress : cfg.bsc.bridgeAddress,
      abi: [{ type: "function", name: "timelock", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }],
      functionName: "timelock",
    })) as `0x${string}`;
    const sender = new TxSender({ chainId, client: c, signer: submitter, db, alerts, safety, cfg: cfg.tx });
    return new TimelockExecutor({ chainId, timelock, client: c, sender, db, alerts, fromBlock: BigInt(chainId === cfg.wantos.chainId ? cfg.wantos.startBlock : cfg.bsc.startBlock) });
  });
  const tl = await Promise.all(executors);
  setInterval(() => void Promise.all(tl.map((t) => t.tick().catch(() => undefined))), 60_000);

  const api = createApi({ orders: relayer.orders, quota: new ChainQuotaReader(relayer.wantosView, relayer.bscView), admin: DenyAllAdminSessions });
  await api.listen(cfg.api.port, cfg.api.host);
  await relayer.run({ intervalMs: cfg.poll.intervalMs });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
