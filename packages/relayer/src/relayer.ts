import type { PublicClient } from "viem";
import { errText } from "./redact";
import type { AlertSink } from "./alerts";
import type { Db } from "./db/types";
import type { SafetyState } from "./safety";
import type { TxSigner } from "./signer";
import type { Address } from "./types";
import type { ChainReader } from "./chain/reader";
import { BridgeView } from "./chain/bridges";
import { WantosScanner } from "./chain/wantosScanner";
import { BscScanner } from "./chain/bscScanner";
import { TxSender, type SenderConfig, type TxSenderOpts } from "./chain/sender";
import { DefaultRiskEngine, type RiskEngine } from "./risk";
import { Processor } from "./processor";
import { ReviewService } from "./review";
import { OrderRepo } from "./orders";
import { Heartbeat, type HeartbeatSink } from "./heartbeat";
import type { Timeouts } from "./stateMachine";

export interface RelayerDeps {
  db: Db;
  alerts: AlertSink;
  safety: SafetyState;
  now?: () => Date;
  wantos: {
    chainId: number;
    bridge: Address;
    /** Client used for contract reads and for sending (the self-hosted primary node). */
    client: PublicClient;
    primary: ChainReader;
    crossChecks: ChainReader[];
    signer: TxSigner;
    confirmations: number;
    startBlock: bigint;
    minBalanceWei?: bigint;
  };
  bsc: {
    chainId: number;
    vault: Address;
    client: PublicClient;
    readers: ChainReader[];
    signer: TxSigner;
    startBlock: bigint;
    minBalanceWei?: bigint;
  };
  sender: SenderConfig;
  poll: { rescanBlocks: number; maxBlockRange: number };
  risk?: RiskEngine;
  timeouts?: Timeouts;
  heartbeat?: { sink?: HeartbeatSink; staleAfterMs: number };
  /** Test-only fault injection. */
  senderHooks?: { wantos?: TxSenderOpts["hooks"]; bsc?: TxSenderOpts["hooks"] };
}

/** Wires data sources, senders, risk hook and the processor (DESIGN §6). */
export class Relayer {
  readonly orders: OrderRepo;
  readonly review: ReviewService;
  readonly processor: Processor;
  readonly wantosScanner: WantosScanner;
  readonly bscScanner: BscScanner;
  readonly wantosSender: TxSender;
  readonly bscSender: TxSender;
  readonly wantosView: BridgeView;
  readonly bscView: BridgeView;
  readonly heartbeat: Heartbeat;
  private readonly now: () => Date;

  constructor(readonly deps: RelayerDeps) {
    const d = deps;
    this.now = d.now ?? (() => new Date());
    this.orders = new OrderRepo(d.db, this.now);
    this.wantosView = new BridgeView("wantos", d.wantos.client, d.wantos.bridge);
    this.bscView = new BridgeView("bsc", d.bsc.client, d.bsc.vault);
    this.wantosScanner = new WantosScanner({
      chainId: d.wantos.chainId,
      bridge: d.wantos.bridge,
      primary: d.wantos.primary,
      crossChecks: d.wantos.crossChecks,
      confirmations: d.wantos.confirmations,
      db: d.db,
      alerts: d.alerts,
      safety: d.safety,
      rescanBlocks: d.poll.rescanBlocks,
      maxBlockRange: d.poll.maxBlockRange,
      startBlock: d.wantos.startBlock,
      now: this.now,
    });
    this.bscScanner = new BscScanner({
      chainId: d.bsc.chainId,
      vault: d.bsc.vault,
      readers: d.bsc.readers,
      db: d.db,
      alerts: d.alerts,
      safety: d.safety,
      rescanBlocks: d.poll.rescanBlocks,
      maxBlockRange: d.poll.maxBlockRange,
      startBlock: d.bsc.startBlock,
      now: this.now,
    });
    const common = { db: d.db, alerts: d.alerts, safety: d.safety, cfg: d.sender, now: this.now };
    this.wantosSender = new TxSender({ ...common, chainId: d.wantos.chainId, client: d.wantos.client, signer: d.wantos.signer, minBalanceWei: d.wantos.minBalanceWei, hooks: d.senderHooks?.wantos });
    this.bscSender = new TxSender({ ...common, chainId: d.bsc.chainId, client: d.bsc.client, signer: d.bsc.signer, minBalanceWei: d.bsc.minBalanceWei, hooks: d.senderHooks?.bsc });
    const risk = d.risk ?? new DefaultRiskEngine(this.wantosView, this.bscView, d.alerts);
    this.processor = new Processor({
      db: d.db,
      alerts: d.alerts,
      safety: d.safety,
      risk,
      now: this.now,
      timeouts: d.timeouts,
      bsc: {
        name: "bsc",
        chainId: d.bsc.chainId,
        view: this.bscView,
        sender: this.bscSender,
        finalBlock: async () => (await this.bscScanner.agreedFinalized())?.number ?? null,
      },
      wantos: {
        name: "wantos",
        chainId: d.wantos.chainId,
        view: this.wantosView,
        sender: this.wantosSender,
        finalBlock: async () => {
          try {
            const h = await d.wantos.client.getBlockNumber({ cacheTime: 0 });
            return h - BigInt(d.wantos.confirmations);
          } catch {
            return null;
          }
        },
      },
    });
    this.review = new ReviewService({
      db: d.db,
      alerts: d.alerts,
      now: this.now,
      payoutView: (dir) =>
        dir === "W2B"
          ? { view: this.bscView, chainId: d.bsc.chainId, client: d.bsc.client }
          : { view: this.wantosView, chainId: d.wantos.chainId, client: d.wantos.client },
    });
    this.heartbeat = new Heartbeat({ alerts: d.alerts, sink: d.heartbeat?.sink, staleAfterMs: d.heartbeat?.staleAfterMs ?? 300_000, now: this.now });
  }

  /**
   * Startup checks + recovery (§6.4): chain ids match config; both tokens use the same decimals
   * (payout amount == source amount in raw units); align nonces and re-broadcast signed txs.
   */
  async start(): Promise<void> {
    const d = this.deps;
    const [wid, bid] = await Promise.all([d.wantos.client.getChainId(), d.bsc.client.getChainId()]);
    if (wid !== d.wantos.chainId || bid !== d.bsc.chainId) throw new Error(`chain id mismatch: wantos ${wid}/${d.wantos.chainId}, bsc ${bid}/${d.bsc.chainId}`);
    const [wd, bd] = await Promise.all([this.wantosView.tokenDecimals(), this.bscView.tokenDecimals()]);
    if (wd !== bd) throw new Error(`token decimals differ (wantos ${wd}, bsc ${bd}); refusing to start`);
    await this.wantosSender.recover();
    await this.bscSender.recover();
  }

  /** One serial iteration: ingest both chains, process orders, gas checks, heartbeat. */
  async tick(): Promise<void> {
    await this.wantosScanner.scanOnce();
    await this.bscScanner.scanOnce();
    await this.processor.step();
    await this.wantosSender.checkGas();
    await this.bscSender.checkGas();
    await this.heartbeat.beat();
  }

  /** Main loop; errors are alerted and the loop continues (single process, serial). */
  async run(o: { intervalMs: number; signal?: AbortSignal }): Promise<void> {
    const watchdog = setInterval(() => void this.heartbeat.watch(), Math.max(1000, Math.floor(o.intervalMs)));
    try {
      while (!o.signal?.aborted) {
        try {
          await this.tick();
        } catch (e) {
          await this.deps.alerts.emit({ kind: "LOOP_ERROR", key: "loop", message: `relayer tick failed: ${errText(e)}` });
        }
        await new Promise((r) => setTimeout(r, o.intervalMs));
      }
    } finally {
      clearInterval(watchdog);
    }
  }
}
