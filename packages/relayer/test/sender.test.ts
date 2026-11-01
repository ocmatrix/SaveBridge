import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, parseEther, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startAnvil, type Anvil } from "./helpers/anvil";
import { actors, deployToken, newKey, tokenAbi } from "./helpers/deploy";
import { newMigratedDb } from "./helpers/db";
import { MemoryAlertSink } from "../src/alerts";
import { SafetyState } from "../src/safety";
import { LocalTestSigner, KmsSigner, type TxSigner } from "../src/signer";
import { TxSender, type SenderConfig } from "../src/chain/sender";
import type { Db } from "../src/db/types";
import type { Address, Hex } from "../src/types";

const CFG: SenderConfig = { replaceByFee: true, stuckAfterMs: 60_000, feeBumpPercent: 15, maxFeeBumps: 2 };

describe("TxSender (DESIGN §6.4) against local anvil", () => {
  let a: Anvil, token: Address, db: Db, alerts: MemoryAlertSink, safety: SafetyState, signer: TxSigner, key: Hex;
  let now = 0;
  const mk = (over: Partial<ConstructorParameters<typeof TxSender>[0]> = {}) =>
    new TxSender({ chainId: a.chain.id, client: a.publicClient as any, signer, db, alerts, safety, cfg: CFG, now: () => new Date(now), ...over });
  const mintCall = (n = 1n) => ({ eventKey: null, action: "test", to: token, data: encodeFunctionData({ abi: tokenAbi as Abi, functionName: "mint", args: [token, n] }) as Hex });
  const attempts = async () =>
    (await db.query<{ nonce: string; state: string; gas_price: string; tx_hash: Uint8Array }>("select nonce, state, gas_price, tx_hash from tx_attempts order by id")).rows;

  beforeAll(async () => {
    a = await startAnvil(31338);
    token = await deployToken(a, actors().funder);
  });
  afterAll(async () => a.stop());
  beforeEach(async () => {
    await a.testClient.setAutomine(true);
    key = newKey();
    signer = new LocalTestSigner(key);
    await a.testClient.setBalance({ address: signer.address, value: parseEther("10") });
    db = await newMigratedDb();
    alerts = new MemoryAlertSink();
    safety = new SafetyState(alerts);
    now = Date.now();
  });

  it("persists the signed raw tx BEFORE broadcasting, then tracks it to mined", async () => {
    const s = mk();
    await s.recover();
    const r = await s.send(mintCall());
    expect(r.kind).toBe("sent");
    const t = await s.tick();
    expect(t.resolved?.success).toBe(true);
    const rows = await attempts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("mined");
    const raw = (await db.query<{ raw_tx: Uint8Array }>("select raw_tx from tx_attempts")).rows[0]!.raw_tx;
    expect(keccak256(new Uint8Array(raw))).toBe((r as { txHash: Hex }).txHash);
  });

  it("crash after sign, before broadcast: restart rebroadcasts the identical raw tx and aligns nonce", async () => {
    const crashing = mk({ hooks: { afterSign: () => { throw new Error("simulated crash"); } } });
    await crashing.recover();
    await expect(crashing.send(mintCall())).rejects.toThrow(/simulated crash/);
    expect(await a.publicClient.getTransactionCount({ address: signer.address })).toBe(0);
    const [row] = await attempts();
    expect(row!.state).toBe("signed");

    const restarted = mk();
    await restarted.recover();
    await restarted.tick();
    const rows = await attempts();
    expect(rows[0]!.state).toBe("mined");
    expect(await a.publicClient.getTransactionCount({ address: signer.address })).toBe(1);
    const next = await restarted.send(mintCall());
    expect(next).toMatchObject({ kind: "sent", nonce: 1 });
  });

  it("onSigned runs in the same DB transaction: if it fails, nothing is stored or broadcast", async () => {
    const s = mk();
    await s.recover();
    await expect(s.send(mintCall(), async () => { throw new Error("link failed"); })).rejects.toThrow(/link failed/);
    expect(await attempts()).toHaveLength(0);
    expect(await a.publicClient.getTransactionCount({ address: signer.address, blockTag: "pending" })).toBe(0);
    expect(await s.send(mintCall())).toMatchObject({ kind: "sent", nonce: 0 });
  });

  it("stuck tx is replaced at the same nonce with a higher gas price; all hashes are recorded", async () => {
    await a.testClient.setAutomine(false);
    const s = mk();
    await s.recover();
    const r = await s.send(mintCall());
    expect(r.kind).toBe("sent");
    expect(await s.send(mintCall())).toEqual({ kind: "busy" }); // single in-flight (serial sending)
    expect((await s.tick()).bumped).toBeFalsy();
    now += CFG.stuckAfterMs + 1;
    const t = await s.tick();
    expect(t.bumped).toBe(true);
    let rows = await attempts();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.nonce).toBe(rows[1]!.nonce);
    expect(BigInt(rows[1]!.gas_price)).toBeGreaterThan(BigInt(rows[0]!.gas_price));
    await a.testClient.mine({ blocks: 1 });
    const done = await s.tick();
    expect(done.resolved?.success).toBe(true);
    rows = await attempts();
    expect(rows.map((x) => x.state).sort()).toEqual(["mined", "replaced"]);
    expect(await a.publicClient.getTransactionCount({ address: signer.address })).toBe(1);
  });

  it("replacement disabled -> TX_STUCK alert, no new attempt", async () => {
    await a.testClient.setAutomine(false);
    const s = mk({ cfg: { ...CFG, replaceByFee: false } });
    await s.recover();
    await s.send(mintCall());
    now += CFG.stuckAfterMs + 1;
    await s.tick();
    expect(alerts.byKind("TX_STUCK")).toHaveLength(1);
    expect(await attempts()).toHaveLength(1);
    await a.testClient.mine({ blocks: 1 });
  });

  it("bumps exhausted -> TX_STUCK alert", async () => {
    await a.testClient.setAutomine(false);
    const s = mk({ cfg: { ...CFG, maxFeeBumps: 1 } });
    await s.recover();
    await s.send(mintCall());
    now += CFG.stuckAfterMs + 1;
    expect((await s.tick()).bumped).toBe(true);
    now += CFG.stuckAfterMs + 1;
    expect((await s.tick()).bumped).toBeFalsy();
    expect(alerts.byKind("TX_STUCK")).toHaveLength(1);
    await a.testClient.mine({ blocks: 1 });
  });

  it("simulation revert is returned decoded and consumes no nonce", async () => {
    const s = mk();
    await s.recover();
    const bad = { eventKey: null, action: "test", to: token, data: encodeFunctionData({ abi: tokenAbi as Abi, functionName: "transfer", args: [token, 1n] }) as Hex };
    const r = await s.send(bad);
    expect(r.kind).toBe("sim-revert");
    expect((r as any).revert.errorName).toBe("ERC20InsufficientBalance");
    expect(await attempts()).toHaveLength(0);
    expect(await s.send(mintCall())).toMatchObject({ kind: "sent", nonce: 0 });
  });

  it("key used outside the relayer -> NONCE_MISMATCH on startup and nonce realigned", async () => {
    const acct = privateKeyToAccount(key);
    const h = await a.walletClient.sendTransaction({ account: acct, chain: a.chain, to: actors().user.address, value: 1n });
    await a.publicClient.waitForTransactionReceipt({ hash: h });
    const s = mk();
    await s.recover();
    expect(alerts.byKind("NONCE_MISMATCH")).toHaveLength(1);
    expect(await s.send(mintCall())).toMatchObject({ kind: "sent", nonce: 1 });
  });

  it("halted safety state blocks all sends", async () => {
    const s = mk();
    await s.recover();
    safety.halt("wantos", "reorg");
    expect(await s.send(mintCall())).toEqual({ kind: "blocked" });
  });

  it("KMS/signer failure -> KMS_FAILURE alert, nothing stored", async () => {
    const failing: TxSigner = { address: signer.address, signTransaction: async () => { throw new Error("kms timeout"); } };
    const s = mk({ signer: failing });
    await s.recover();
    expect((await s.send(mintCall())).kind).toBe("signer-error");
    expect(alerts.byKind("KMS_FAILURE")).toHaveLength(1);
    expect(await attempts()).toHaveLength(0);
  });

  it("gas below threshold -> GAS_LOW alert", async () => {
    const s = mk({ minBalanceWei: parseEther("100") });
    await s.checkGas();
    expect(alerts.byKind("GAS_LOW")).toHaveLength(1);
    const ok = mk({ minBalanceWei: 1n });
    alerts.clear();
    await ok.checkGas();
    expect(alerts.byKind("GAS_LOW")).toHaveLength(0);
  });

  it("KmsSigner placeholder refuses to sign (production impl is TODO)", async () => {
    const k = new KmsSigner({ keyId: "placeholder", address: signer.address });
    await expect(k.signTransaction({} as any)).rejects.toThrow(/not implemented/);
  });
});
