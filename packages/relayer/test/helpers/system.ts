import { parseEther, type Abi, type PublicClient } from "viem";
import { bscVaultV2Abi, wantosBridgeV2Abi } from "@bridge/abi";
import { startAnvil, type Anvil } from "./anvil";
import { actors, applyWhitelist, deployBridge, deployToken, newKey, tokenAbi, U, write, type Actors, type Deployed } from "./deploy";
import { newMigratedDb } from "./db";
import { MemoryAlertSink } from "../../src/alerts";
import { SafetyState } from "../../src/safety";
import { LocalTestSigner } from "../../src/signer";
import { ViemChainReader } from "../../src/chain/reader";
import { Relayer, type RelayerDeps } from "../../src/relayer";
import type { Db } from "../../src/db/types";
import type { Address, Hex } from "../../src/types";

export const WANTOS_ID = 31337;
export const BSC_ID = 31338;

export interface World {
  wantos: Anvil;
  bsc: Anvil;
  act: Actors;
  w: Deployed;
  b: Deployed;
  wantosRelayerKey: Hex;
  bscRelayerKey: Hex;
  stop(): Promise<void>;
}

/** Two local anvils with PR-1 contracts deployed at the same proxy address, funded reserves. */
export async function startWorld(): Promise<World> {
  const [wantos, bsc] = await Promise.all([startAnvil(WANTOS_ID), startAnvil(BSC_ID)]);
  try {
    return await setupWorld(wantos, bsc);
  } catch (e) {
    await wantos.stop(); // never leak local anvil processes when setup fails
    await bsc.stop();
    throw e;
  }
}

async function setupWorld(wantos: Anvil, bsc: Anvil): Promise<World> {
  const act = actors();
  const deployerKey = newKey();
  const wantosRelayerKey = newKey();
  const bscRelayerKey = newKey();
  const wRelayer = new LocalTestSigner(wantosRelayerKey).address;
  const bRelayer = new LocalTestSigner(bscRelayerKey).address;
  await wantos.testClient.setBalance({ address: wRelayer, value: parseEther("100") });
  await bsc.testClient.setBalance({ address: bRelayer, value: parseEther("100") });

  const wToken = await deployToken(wantos, act.funder);
  const bToken = await deployToken(bsc, act.funder);
  // WANTOS supply: users + reserve, minted before deploy so supplyCeiling = totalSupply + 10k
  for (const u of [act.user, act.user2]) await write(wantos, act.funder, wToken, tokenAbi as Abi, "mint", [u.address, 100_000n * U]);
  await write(wantos, act.funder, wToken, tokenAbi as Abi, "mint", [act.funder.address, 100_000n * U]);
  const supply = (await wantos.publicClient.readContract({ address: wToken, abi: tokenAbi as Abi, functionName: "totalSupply" })) as bigint;
  const w = await deployBridge(wantos, "wantos", { deployerKey, token: wToken, relayer: wRelayer, peerChainId: BigInt(BSC_ID), act, supplyCeiling: supply + 10_000n * U });
  const b = await deployBridge(bsc, "bsc", { deployerKey, token: bToken, relayer: bRelayer, peerChainId: BigInt(WANTOS_ID), act });
  if (w.bridge !== b.bridge) throw new Error("bridge addresses differ");

  // reserves
  await write(bsc, act.funder, bToken, tokenAbi as Abi, "mint", [act.funder.address, 50_000n * U]);
  await write(bsc, act.funder, bToken, tokenAbi as Abi, "approve", [b.bridge, 2n ** 255n]);
  await write(bsc, act.funder, b.bridge, bscVaultV2Abi as Abi, "fund", [20_000n * U]);
  await write(wantos, act.funder, wToken, tokenAbi as Abi, "approve", [w.bridge, 2n ** 255n]);
  await write(wantos, act.funder, w.bridge, wantosBridgeV2Abi as Abi, "fund", [20_000n * U]);
  // users can deposit on BSC
  for (const u of [act.user, act.user2]) {
    await write(bsc, act.funder, bToken, tokenAbi as Abi, "mint", [u.address, 10_000n * U]);
    await write(bsc, u, bToken, tokenAbi as Abi, "approve", [b.bridge, 2n ** 255n]);
    await write(wantos, u, wToken, tokenAbi as Abi, "approve", [w.bridge, 2n ** 255n]);
  }
  return {
    wantos,
    bsc,
    act,
    w,
    b,
    wantosRelayerKey,
    bscRelayerKey,
    stop: async () => {
      await wantos.stop();
      await bsc.stop();
    },
  };
}

export async function whitelistBoth(world: World, addrs: Address[]): Promise<void> {
  await applyWhitelist(world.bsc, "bsc", world.b.bridge, world.act, addrs, true); // add: BSC first (§4.4)
  await applyWhitelist(world.wantos, "wantos", world.w.bridge, world.act, addrs, true);
}

export interface Sys {
  relayer: Relayer;
  db: Db;
  alerts: MemoryAlertSink;
  safety: SafetyState;
  clock: { now: number };
}

export async function buildRelayer(world: World, over: Partial<RelayerDeps> & { db?: Db; clock?: { now: number } } = {}): Promise<Sys> {
  const db = over.db ?? (await newMigratedDb());
  const alerts = (over.alerts as MemoryAlertSink) ?? new MemoryAlertSink();
  const safety = over.safety ?? new SafetyState(alerts);
  const clock = over.clock ?? { now: Date.now() };
  const wc = world.wantos.publicClient as unknown as PublicClient;
  const bc = world.bsc.publicClient as unknown as PublicClient;
  const deps: RelayerDeps = {
    db,
    alerts,
    safety,
    now: () => new Date(clock.now),
    wantos: {
      chainId: WANTOS_ID,
      bridge: world.w.bridge,
      client: wc,
      primary: new ViemChainReader("wantos-primary", wc),
      crossChecks: [new ViemChainReader("wantos-cross", world.wantos.publicClient as unknown as PublicClient)],
      signer: new LocalTestSigner(world.wantosRelayerKey),
      confirmations: 6,
      startBlock: 0n,
      minBalanceWei: 1n,
    },
    bsc: {
      chainId: BSC_ID,
      vault: world.b.bridge,
      client: bc,
      readers: [new ViemChainReader("bsc-a", bc), new ViemChainReader("bsc-b", world.bsc.publicClient as unknown as PublicClient)],
      signer: new LocalTestSigner(world.bscRelayerKey),
      startBlock: 0n,
      minBalanceWei: 1n,
    },
    sender: { replaceByFee: true, stuckAfterMs: 60_000, feeBumpPercent: 15, maxFeeBumps: 3 },
    poll: { rescanBlocks: 100, maxBlockRange: 5000 },
    ...over,
  };
  const relayer = new Relayer(deps);
  await relayer.start();
  return { relayer, db, alerts, safety, clock };
}

/** BSC finality on anvil = latest - 64. */
export async function finalizeBsc(world: World): Promise<void> {
  await world.bsc.testClient.mine({ blocks: 65 });
}
export async function confirmWantos(world: World): Promise<void> {
  await world.wantos.testClient.mine({ blocks: 7 });
}
export async function bridgeOut(world: World, who: Actors["user"], amount: bigint): Promise<void> {
  await write(world.wantos, who, world.w.bridge, wantosBridgeV2Abi as Abi, "bridgeOut", [amount]);
}
export async function deposit(world: World, who: Actors["user"], amount: bigint, recipient: Address): Promise<void> {
  await write(world.bsc, who, world.b.bridge, bscVaultV2Abi as Abi, "deposit", [amount, recipient]);
}
export async function balanceOf(a: Anvil, token: Address, who: Address): Promise<bigint> {
  return (await a.publicClient.readContract({ address: token, abi: tokenAbi as Abi, functionName: "balanceOf", args: [who] })) as bigint;
}
