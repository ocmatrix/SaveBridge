/**
 * Server-B (rpc3) entry point. Not exercised by tests; the wiring lives in `deploy.ts` (tested).
 *   node --import tsx src/main.ts --config /etc/savebridge-watcher/watcher.json [--dry-run] [--once]
 * RPC URLs come from EnvironmentFile; the PAUSER keystore passphrases, Telegram token / chat id and the
 * heartbeat URL are systemd credentials. Without a PAUSER signer it refuses to start unless --dry-run
 * (startupGuard). Config / keystore / RPC-policy errors exit 78 (EX_CONFIG; not restarted by systemd).
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { HttpHeartbeat, readCredentialText, redact, TelegramNotifier } from "@bridge/ops";
import { LogAlertSink, type AlertSink } from "./alerts.js";
import type { Heartbeat } from "./heartbeat.js";
import { PauseExecutor, PauseOnlySigner, type RawTxSender } from "./pauser.js";
import { FileStateStore } from "./state.js";
import { Watcher } from "./watcher.js";
import { multiRpcPauseReader, startupGuard } from "./wiring.js";
import { buildGuardedRpc, buildPauseSenders, gatedHeartbeat, processAckInbox, resolveDeployConfig, TelegramChannel } from "./deploy.js";

const EX_CONFIG = 78;
const args = process.argv.slice(2);
const cfgPath = resolve(args[args.indexOf("--config") + 1] ?? "config/watcher.json");
const once = args.includes("--once");
let secrets: readonly string[] = [];
const log = (o: Record<string, unknown>) => process.stderr.write(`${redact(JSON.stringify(o), secrets)}\n`);

let notifier: TelegramNotifier | undefined;
let watcher: Watcher;
let tickMs = 5_000;
let ackDir: string | undefined;
try {
  const d = resolveDeployConfig(JSON.parse(readFileSync(cfgPath, "utf8")));
  for (const w of d.warnings) log({ event: "rpc_warning", warning: w });
  startupGuard({ args, signerWired: d.runtime.pauser.kind === "local-keystore" });
  const dryRun = args.includes("--dry-run");
  tickMs = d.runtime.tickIntervalSeconds * 1000;
  ackDir = d.runtime.ackDir;
  const dataDir = resolve(dirname(cfgPath), d.core.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const sinks: AlertSink[] = [new LogAlertSink((l) => process.stdout.write(`${l}\n`)), new LogAlertSink((l) => appendFileSync(join(dataDir, "alerts.jsonl"), `${l}\n`))];
  let telegramChannel: number | undefined;
  if (d.runtime.telegram) {
    notifier = new TelegramNotifier({ botToken: readCredentialText(d.runtime.telegram.botTokenCredential), chatId: readCredentialText(d.runtime.telegram.chatIdCredential), log: (l) => process.stderr.write(`${l}\n`) });
    secrets = notifier.secrets;
    telegramChannel = sinks.push(new TelegramChannel(notifier)) - 1;
  }

  const rpc = buildGuardedRpc(d, { onEvent: (e) => e.event !== "budget" && log({ ...e, event: "rpc_guard", guard: e.event }) });
  const unwired: RawTxSender = {
    address: "0x0000000000000000000000000000000000000000",
    send: async () => {
      throw new Error("PAUSER signer not wired (dry-run)");
    },
  };
  const senders = dryRun && d.runtime.pauser.kind !== "local-keystore" ? { bsc: unwired, wantos: unwired } : await buildPauseSenders(d);
  log({ event: "pauser_loaded", bsc: senders.bsc.address, wantos: senders.wantos.address, dryRun });

  const hbUrl = d.runtime.heartbeat ? readCredentialText(d.runtime.heartbeat.urlCredential) : undefined;
  if (hbUrl) secrets = [...secrets, hbUrl];
  const hb = hbUrl ? new HttpHeartbeat({ url: hbUrl, minIntervalMs: 60_000 }) : undefined;
  const heartbeat: Heartbeat = hb
    ? gatedHeartbeat(() => hb.ping(), () => watcher?.state?.meta, telegramChannel)
    : { beat: async (s) => void process.stdout.write(`${JSON.stringify({ heartbeat: s })}\n`) };

  watcher = new Watcher({
    config: d.core,
    rpc,
    store: new FileStateStore(join(dataDir, "state.json")),
    sink: sinks,
    pauser: new PauseExecutor(
      { bsc: new PauseOnlySigner(senders.bsc, [d.core.chains.bsc.bridge]), wantos: new PauseOnlySigner(senders.wantos, [d.core.chains.wantos.bridge]) },
      { bsc: multiRpcPauseReader(rpc.bsc, d.core.chains.bsc.bridge), wantos: multiRpcPauseReader(rpc.wantos, d.core.chains.wantos.bridge) },
      { bsc: d.core.chains.bsc.bridge, wantos: d.core.chains.wantos.bridge },
      d.core.pauseRetry,
    ),
    heartbeat,
    clock: () => Math.floor(Date.now() / 1000),
  });
  await watcher.init();
} catch (e) {
  const msg = redact(e instanceof Error ? e.message : String(e), secrets);
  log({ event: "fatal", error: msg });
  await notifier?.send({ level: 1, service: "监控", code: "STARTUP_FAILED", title: `监控启动失败：${msg}`, at: new Date() }).catch(() => undefined);
  process.exit(EX_CONFIG);
}

do {
  try {
    if (ackDir) processAckInbox(ackDir, watcher.alerts, () => Object.keys(watcher.state.meta.openLevel1), log);
    await watcher.tick();
  } catch (e) {
    process.stderr.write(`tick failed: ${redact(e instanceof Error ? (e.stack ?? e.message) : String(e), secrets)}\n`);
  }
  if (!once) await new Promise((r) => setTimeout(r, tickMs));
} while (!once);
