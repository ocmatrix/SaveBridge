/**
 * Server-B entry point (not exercised by tests; not run in PR-7).
 *   tsx src/main.ts --config ./config/watcher.json --dry-run [--once]
 * The PAUSER signer, the alert channel and the heartbeat channel are deliberately NOT wired here:
 * PR-10 plugs in a KMS-backed `RawTxSender`, a real `AlertSink` and a real `Heartbeat`.
 * Until then it refuses to start unless `--dry-run` is given (startupGuard); in dry-run, pause attempts
 * fail loudly (PAUSE_FAILED, level 1) and alerts go to stdout + alerts.jsonl.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LogAlertSink } from "./alerts.js";
import { parseConfig, parseControlledSet } from "./config.js";
import type { Heartbeat } from "./heartbeat.js";
import { PauseExecutor, PauseOnlySigner, type RawTxSender } from "./pauser.js";
import { redact } from "./redact.js";
import { FileStateStore } from "./state.js";
import { Watcher } from "./watcher.js";
import { buildRpc, multiRpcPauseReader, startupGuard } from "./wiring.js";

const args = process.argv.slice(2);
const cfgPath = resolve(args[args.indexOf("--config") + 1] ?? "config/watcher.json");
const once = args.includes("--once");
startupGuard({ args, signerWired: false }); // PR-10: pass true once a KMS-backed RawTxSender is wired
const cfg = parseConfig(JSON.parse(readFileSync(cfgPath, "utf8")));
const dataDir = resolve(cfgPath, "..", cfg.dataDir);
mkdirSync(dataDir, { recursive: true });

const unwired: RawTxSender = {
  address: "0x0000000000000000000000000000000000000000",
  send: async () => {
    throw new Error("PAUSER signer adapter not wired (PR-10: KMS-backed RawTxSender)");
  },
};
const logHeartbeat: Heartbeat = {
  beat: async (s) => {
    process.stdout.write(`${JSON.stringify({ heartbeat: s })}\n`);
  },
};

const rpc = buildRpc(cfg);
const watcher = new Watcher({
  config: cfg,
  rpc,
  store: new FileStateStore(join(dataDir, "state.json")),
  sink: [new LogAlertSink((l) => process.stdout.write(`${l}\n`)), new LogAlertSink((l) => appendFileSync(join(dataDir, "alerts.jsonl"), `${l}\n`))],
  pauser: new PauseExecutor(
    { bsc: new PauseOnlySigner(unwired, [cfg.chains.bsc.bridge]), wantos: new PauseOnlySigner(unwired, [cfg.chains.wantos.bridge]) },
    { bsc: multiRpcPauseReader(rpc.bsc, cfg.chains.bsc.bridge), wantos: multiRpcPauseReader(rpc.wantos, cfg.chains.wantos.bridge) },
    { bsc: cfg.chains.bsc.bridge, wantos: cfg.chains.wantos.bridge },
    cfg.pauseRetry,
  ),
  heartbeat: logHeartbeat,
  clock: () => Math.floor(Date.now() / 1000),
  ...(cfg.controlledSetFile
    ? { controlledSet: { load: async () => parseControlledSet(JSON.parse(readFileSync(resolve(cfgPath, "..", cfg.controlledSetFile!), "utf8"))) } }
    : {}),
});

await watcher.init();
do {
  try {
    await watcher.tick();
  } catch (e) {
    process.stderr.write(`tick failed: ${redact(e instanceof Error ? (e.stack ?? e.message) : String(e))}\n`);
  }
  if (!once) await new Promise((r) => setTimeout(r, 5_000));
} while (!once);
