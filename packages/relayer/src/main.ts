/**
 * Production entry point (payout server ss02). Not exercised by tests; all wiring lives in
 * `bootstrap.ts` (tested). Run under systemd (deploy/ss02-payout):
 *   RELAYER_CONFIG=/etc/savebridge/relayer.json  node --import tsx src/main.ts
 * Secrets: keystore passphrases, Telegram token / chat id and the heartbeat URL arrive as systemd
 * credentials ($CREDENTIALS_DIRECTORY); RPC URLs from EnvironmentFile; the config file holds neither.
 * Fail-closed: any configuration / keystore / RPC-policy problem exits with 78 (EX_CONFIG, systemd
 * does not restart it: RestartPreventExitStatus=78) after a best-effort level-1 alert.
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { HttpHeartbeat, readCredentialText, redact } from "@bridge/ops";
import { parseConfig, type RelayerConfig } from "./config";
import { PgDb } from "./db/pg";
import { migrate } from "./db/migrations";
import { SafetyState } from "./safety";
import { Relayer } from "./relayer";
import { createApi, CachedQuotaReader, ChainQuotaReader, DenyAllAdminSessions } from "./api";
import { TxSender } from "./chain/sender";
import { TimelockExecutor, runTimelockTicks } from "./timelockExecutor";
import { assertChainIds, buildAlerts, buildClients, buildRelayerDeps, buildSigners, gatedHeartbeat, resolveEndpoints, type AlertWiring } from "./bootstrap";

const EX_CONFIG = 78;
const log = (o: Record<string, unknown>, secrets: readonly string[] = []) => process.stderr.write(`${redact(JSON.stringify(o), secrets)}\n`);

async function main(): Promise<void> {
  let alerts: AlertWiring | undefined;
  let stage = "config";
  try {
    const path = process.env.RELAYER_CONFIG;
    if (!path) throw new Error("RELAYER_CONFIG is required");
    const cfg: RelayerConfig = parseConfig(JSON.parse(readFileSync(path, "utf8")));
    stage = "alerts";
    alerts = buildAlerts(cfg);
    stage = "rpc";
    const ep = resolveEndpoints(cfg);
    for (const w of ep.warnings) log({ event: "rpc_warning", warning: w });
    const clients = buildClients(cfg, ep, { onEvent: (e) => e.event !== "budget" && log({ ...e, event: "rpc_guard", guard: e.event }) });
    await assertChainIds(cfg, clients, ep);
    stage = "signer";
    const signers = await buildSigners(cfg);
    log({ event: "signers_loaded", wantos: signers.wantos.address, bsc: signers.bsc.address, submitter: signers.submitter.address });
    stage = "database";
    const dbUrl = process.env[cfg.db.urlEnv];
    if (!dbUrl) throw new Error(`${cfg.db.urlEnv} is required`);
    const db = new PgDb(new pg.Pool({ connectionString: dbUrl, max: 5 }));
    await migrate(db);
    stage = "start";

    const safety = new SafetyState(alerts.sink);
    safety.onReorg((side, info) => log({ event: "reorg", side, block: info.block.toString() }));
    const hb = cfg.heartbeat.urlCredential ? new HttpHeartbeat({ url: readCredentialText(cfg.heartbeat.urlCredential), minIntervalMs: cfg.heartbeat.intervalMs }) : undefined;
    const relayer = new Relayer(
      buildRelayerDeps({ cfg, clients, signers, db, alerts: alerts.sink, safety, heartbeat: hb ? gatedHeartbeat(() => hb.ping(), alerts.telegram) : undefined }),
    );
    await relayer.start();

    const executors = [
      { chainId: cfg.wantos.chainId, c: clients.wantos.write, bridge: cfg.wantos.bridgeAddress, from: cfg.wantos.startBlock },
      { chainId: cfg.bsc.chainId, c: clients.bsc.write, bridge: cfg.bsc.bridgeAddress, from: cfg.bsc.startBlock },
    ].map(async ({ chainId, c, bridge, from }) => {
      const timelock = (await c.readContract({
        address: bridge,
        abi: [{ type: "function", name: "timelock", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }],
        functionName: "timelock",
      })) as `0x${string}`;
      const sender = new TxSender({ chainId, client: c, signer: signers.submitter, db, alerts: alerts!.sink, safety, cfg: cfg.tx });
      return new TimelockExecutor({ chainId, timelock, client: c, sender, db, alerts: alerts!.sink, maxBlockRange: cfg.poll.maxBlockRange, fromBlock: BigInt(from) });
    });
    const tl = await Promise.all(executors);
    setInterval(() => void runTimelockTicks(tl, alerts!.sink), 60_000);
    if (alerts.telegram) setInterval(() => void alerts!.telegram!.flush(), 30_000);

    const api = createApi({ orders: relayer.orders, quota: new CachedQuotaReader(new ChainQuotaReader(relayer.wantosView, relayer.bscView), { ttlMs: 15_000, maxPerSecond: 20 }), admin: DenyAllAdminSessions, corsOrigins: cfg.api.corsOrigins ?? [] });
    await api.listen(cfg.api.port, cfg.api.host); // parseConfig only allows loopback (Cloudflare Tunnel in front)
    log({ event: "started", api: `${cfg.api.host}:${cfg.api.port}` });
    await relayer.run({ intervalMs: cfg.poll.intervalMs });
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : String(e), alerts?.secrets ?? []);
    log({ event: "fatal", stage, error: msg });
    if (alerts) await alerts.sink.emit({ kind: "STARTUP_FAILED", message: `付款程序启动失败（${stage}）：${msg}` }).catch(() => undefined);
    process.exit(stage === "start" ? 1 : EX_CONFIG);
  }
}

void main();
