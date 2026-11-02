import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseTransaction, recoverTransactionAddress, type TransactionSerializableLegacy } from "viem";
import { encryptKeystore, writeKeystoreFile } from "@bridge/ops";
import { LocalKeystoreSigner } from "../src/keystoreSigner";
import { createSigner, buildSigners } from "../src/bootstrap";
import { EXAMPLE_CONFIG, parseConfig, type RelayerConfig } from "../src/config";
import { KmsSigner } from "../src/signer";
import { LogAlertSink } from "../src/alerts";
import { newKey } from "./helpers/deploy";
import { privateKeyToAccount } from "viem/accounts";

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const minN = 2 ** 10;
const PASS = "relayer-test-passphrase-0123456789";
const dir = mkdtempSync(join(tmpdir(), "sb-rks-"));
const ksDir = join(dir, "keystore");
const credDir = join(dir, "creds");
mkdirSync(ksDir, { mode: 0o700 });
mkdirSync(credDir, { mode: 0o700 });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function makeKeystore(name: string, key = newKey()): Promise<{ path: string; address: `0x${string}`; key: `0x${string}` }> {
  const path = join(ksDir, `${name}.json`);
  const ks = await encryptKeystore(Buffer.from(key.slice(2), "hex"), Buffer.from(PASS), { label: name, scrypt: FAST });
  writeKeystoreFile(path, ks);
  writeFileSync(join(credDir, `${name}-pass`), PASS, { mode: 0o400 });
  return { path, address: ks.address, key };
}

const tx = (over: Partial<TransactionSerializableLegacy> = {}): TransactionSerializableLegacy => ({
  type: "legacy",
  chainId: 56,
  nonce: 7,
  to: "0x00000000000000000000000000000000000000b1",
  data: "0x1234",
  gas: 100_000n,
  gasPrice: 3_000_000_000n,
  value: 0n,
  ...over,
});

describe("LocalKeystoreSigner", () => {
  it("signs EIP-155 legacy transactions that viem recovers to the keystore address", async () => {
    const k = await makeKeystore("relayer-bsc");
    const s = await LocalKeystoreSigner.load({ keystorePath: k.path, passphrase: Buffer.from(PASS), expectedAddress: k.address, allowedChainIds: [56], minN });
    expect(s.address).toBe(k.address);
    const raw = await s.signTransaction(tx());
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(k.address);
    const parsed = parseTransaction(raw);
    expect(parsed.type).toBe("legacy");
    expect(parsed.chainId).toBe(56);
    expect(parsed.v).toBeGreaterThanOrEqual(56n * 2n + 35n); // EIP-155 v
    // identical to the plain in-memory signer (same sign call shape as LocalTestSigner)
    expect(raw).toBe(await privateKeyToAccount(k.key).signTransaction(tx()));
  });

  it("refuses wrong chain id, missing chain id, non-legacy fields and implicit fee/nonce/gas (fail-closed)", async () => {
    const k = await makeKeystore("relayer-guard");
    const s = await LocalKeystoreSigner.load({ keystorePath: k.path, passphrase: Buffer.from(PASS), expectedAddress: k.address, allowedChainIds: [56], minN });
    await expect(s.signTransaction(tx({ chainId: 13555 }))).rejects.toThrow(/refusing chainId 13555/);
    await expect(s.signTransaction(tx({ chainId: undefined }))).rejects.toThrow(/EIP-155/);
    await expect(s.signTransaction({ ...tx(), type: "eip1559" } as never)).rejects.toThrow(/non-legacy/);
    await expect(s.signTransaction({ ...tx(), maxFeePerGas: 1n } as never)).rejects.toThrow(/maxFeePerGas/);
    await expect(s.signTransaction({ ...tx(), accessList: [] } as never)).rejects.toThrow(/accessList/);
    await expect(s.signTransaction(tx({ gasPrice: undefined }))).rejects.toThrow(/explicit/);
    await expect(s.signTransaction(tx({ nonce: undefined }))).rejects.toThrow(/explicit/);
    await expect(s.signTransaction(tx({ gas: undefined }))).rejects.toThrow(/explicit/);
    const { type: _t, ...noType } = tx();
    expect(await s.signTransaction(noType as TransactionSerializableLegacy)).toMatch(/^0x/);
  });

  it("refuses to start on address mismatch / wrong passphrase / no allowed chain, and wipes the passphrase", async () => {
    const k = await makeKeystore("relayer-mismatch");
    const other = privateKeyToAccount(newKey()).address;
    const b = Buffer.from(PASS);
    await expect(LocalKeystoreSigner.load({ keystorePath: k.path, passphrase: b, expectedAddress: other, allowedChainIds: [56], minN })).rejects.toThrow(/ADDRESS_MISMATCH/);
    expect(b.every((x) => x === 0)).toBe(true);
    const wrong = Buffer.from("not-the-passphrase-but-long-enough");
    const e = await LocalKeystoreSigner.load({ keystorePath: k.path, passphrase: wrong, expectedAddress: k.address, allowedChainIds: [56], minN }).catch((x) => x as Error);
    expect(String(e)).toMatch(/DECRYPT_FAILED/);
    expect(String(e)).not.toContain("not-the-passphrase");
    expect(String(e)).not.toContain(k.key.slice(2));
    const b3 = Buffer.from(PASS);
    await expect(LocalKeystoreSigner.load({ keystorePath: k.path, passphrase: b3, expectedAddress: k.address, allowedChainIds: [], minN })).rejects.toThrow(/allowed chain id/);
    expect(b3.every((x) => x === 0)).toBe(true);
  });

  it("logs and errors never contain the private key or passphrase (full startup path through the factory)", async () => {
    const lines: string[] = [];
    const sink = new LogAlertSink((l) => lines.push(l));
    const k = await makeKeystore("relayer-log");
    const env = { CREDENTIALS_DIRECTORY: credDir };
    const s = await createSigner({ kind: "local-keystore", keystorePath: k.path, passphraseCredential: "relayer-log-pass", address: k.address }, [56], { env, minN });
    try {
      await s.signTransaction(tx({ chainId: 1 }));
    } catch (err) {
      await sink.emit({ kind: "KMS_FAILURE", message: String(err) });
    }
    const all = lines.join("\n");
    expect(all).toContain("KMS_FAILURE");
    expect(all).not.toContain(k.key.slice(2));
    expect(all).not.toContain(PASS);
    // kms placeholder stays selectable and still refuses (unchanged interface)
    const kms = await createSigner({ kind: "kms", keyId: "k", address: k.address }, [56]);
    expect(kms).toBeInstanceOf(KmsSigner);
    await expect(kms.signTransaction(tx())).rejects.toThrow(/not implemented/);
  });

  it("buildSigners: three distinct keys from local keystores with per-key chain scopes", async () => {
    const [w, b, sub] = [await makeKeystore("relayer-wantos"), await makeKeystore("relayer-bsc2"), await makeKeystore("submitter")];
    const cfg = parseConfig({
      ...(JSON.parse(JSON.stringify(EXAMPLE_CONFIG)) as RelayerConfig),
      signer: {
        kind: "local-keystore",
        wantos: { keystorePath: w.path, passphraseCredential: "relayer-wantos-pass", address: w.address },
        bsc: { keystorePath: b.path, passphraseCredential: "relayer-bsc2-pass", address: b.address },
      },
      submitter: { kind: "local-keystore", keystorePath: sub.path, passphraseCredential: "submitter-pass", address: sub.address },
    });
    const s = await buildSigners(cfg, { env: { CREDENTIALS_DIRECTORY: credDir }, minN });
    expect([s.wantos.address, s.bsc.address, s.submitter.address]).toEqual([w.address, b.address, sub.address]);
    await expect(s.wantos.signTransaction(tx({ chainId: 56 }))).rejects.toThrow(/refusing chainId/);
    await expect(s.bsc.signTransaction(tx({ chainId: 13555 }))).rejects.toThrow(/refusing chainId/);
    expect(await s.submitter.signTransaction(tx({ chainId: 13555 }))).toMatch(/^0x/);
    expect(await s.submitter.signTransaction(tx({ chainId: 56 }))).toMatch(/^0x/);
    // missing credential → refuses to start
    await expect(buildSigners(cfg, { env: {}, minN })).rejects.toThrow(/CREDENTIALS_DIRECTORY/);
  });
});
