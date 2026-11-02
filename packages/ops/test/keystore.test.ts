import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bytesToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  decryptKeystore,
  encryptKeystore,
  generatePrivateKeyBytes,
  isValidPrivateKey,
  KeystoreError,
  loadKeystoreAccount,
  MIN_SCRYPT_N,
  parseKeystore,
  readKeystoreFile,
  writeKeystoreFile,
  assertPrivateFile,
  type KeystoreFile,
} from "../src/keystore";
import { keygen, verifyKeystore } from "../src/keygen";
import { readCredential, readCredentialText, credentialPath, wipe } from "../src/credentials";

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const minN = 2 ** 10;
const PASS = "correct horse battery staple 42";
const pass = () => Buffer.from(PASS);
const KEY = Buffer.from("4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318", "hex");

let dir: string;
let ksDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sb-ks-"));
  ksDir = join(dir, "keystore");
  mkdirSync(ksDir, { mode: 0o700 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function sample(label = "relayer-bsc"): Promise<KeystoreFile> {
  return encryptKeystore(KEY, pass(), { label, scrypt: FAST });
}

describe("keystore crypto", () => {
  it("round-trips: decrypt returns the same key and address; ciphertext never contains the key", async () => {
    const ks = await sample();
    expect(ks.address).toBe(privateKeyToAccount(bytesToHex(KEY)).address);
    expect(ks.publicKey).toBe(privateKeyToAccount(bytesToHex(KEY)).publicKey);
    const text = JSON.stringify(ks);
    expect(text).not.toContain(KEY.toString("hex"));
    expect(text).not.toContain(KEY.toString("base64"));
    expect(text).not.toContain(PASS);
    const { privateKey, address } = await decryptKeystore(ks, pass(), { minN });
    expect(privateKey.equals(KEY)).toBe(true);
    expect(address).toBe(ks.address);
  });

  it("uses fresh salt and iv every time", async () => {
    const a = await sample(), b = await sample();
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("wrong passphrase → DECRYPT_FAILED, and the message holds no secret", async () => {
    const ks = await sample();
    const e = await decryptKeystore(ks, Buffer.from("Zq9-not-the-right-one-77"), { minN }).catch((x) => x);
    expect(e).toBeInstanceOf(KeystoreError);
    expect((e as KeystoreError).code).toBe("DECRYPT_FAILED");
    expect(String(e.message)).not.toContain("Zq9-not-the-right-one-77");
    expect(String(e.message)).not.toContain(PASS);
    expect(String(e.stack)).not.toContain(KEY.toString("hex"));
  });

  const flip = (b64: string): string => {
    const b = Buffer.from(b64, "base64");
    b[0] = b[0]! ^ 1;
    return b.toString("base64");
  };
  const tamper: Array<[string, (k: KeystoreFile) => void]> = [
    ["ciphertext", (k) => (k.ciphertext = flip(k.ciphertext))],
    ["tag", (k) => (k.cipher.tag = flip(k.cipher.tag))],
    ["iv", (k) => (k.cipher.iv = flip(k.cipher.iv))],
    ["salt", (k) => (k.kdf.salt = flip(k.kdf.salt))],
    ["label", (k) => (k.label = "relayer-wantos")],
    ["createdAt", (k) => (k.createdAt = "2020-01-01T00:00:00.000Z")],
    ["address", (k) => (k.address = privateKeyToAccount(bytesToHex(generatePrivateKeyBytes())).address)],
    ["publicKey", (k) => (k.publicKey = privateKeyToAccount(bytesToHex(generatePrivateKeyBytes())).publicKey)],
    ["kdf.N", (k) => (k.kdf.N = 2 ** 11)],
    ["kdf.r", (k) => (k.kdf.r = 9)],
  ];
  for (const [name, mut] of tamper)
    it(`tampered ${name} is rejected`, async () => {
      const ks = await sample();
      mut(ks);
      const e = await decryptKeystore(ks, pass(), { minN }).catch((x) => x);
      expect(e).toBeInstanceOf(KeystoreError);
      expect(["DECRYPT_FAILED", "BAD_FORMAT"]).toContain((e as KeystoreError).code);
    });

  it("refuses a weak KDF by default (production minimum 2^17) and absurd N", async () => {
    expect(MIN_SCRYPT_N).toBe(2 ** 17);
    const ks = await sample();
    expect(() => parseKeystore(ks)).toThrow(/WEAK_KDF/);
    expect(() => parseKeystore({ ...ks, kdf: { ...ks.kdf, N: 2 ** 21 } }, { minN })).toThrow(/scrypt N invalid/);
    expect(() => parseKeystore({ ...ks, kdf: { ...ks.kdf, N: 1000 } }, { minN: 2 })).toThrow(/scrypt N invalid/);
    expect(() => parseKeystore({ ...ks, kdf: { ...ks.kdf, p: 9 } }, { minN })).toThrow(/scrypt p invalid/);
    expect(() => parseKeystore({ ...ks, kdf: { ...ks.kdf, r: 4 } }, { minN })).toThrow(/scrypt r invalid/);
  });

  it("rejects malformed structure", async () => {
    const ks = await sample();
    for (const bad of [null, [], "x", { ...ks, format: "other" }, { ...ks, version: 2 }, { ...ks, address: "0x12" }, { ...ks, publicKey: "0x02aa" }, { ...ks, kdf: { ...ks.kdf, name: "pbkdf2" } }, { ...ks, cipher: { ...ks.cipher, name: "aes-128-ctr" } }, { ...ks, ciphertext: "!!" }, { ...ks, ciphertext: Buffer.alloc(31).toString("base64") }, { ...ks, label: 1 }])
      expect(() => parseKeystore(bad, { minN })).toThrow(KeystoreError);
  });

  it("refuses short passphrases, invalid keys and bad labels when encrypting", async () => {
    await expect(encryptKeystore(KEY, Buffer.from("short"), { label: "x", scrypt: FAST })).rejects.toThrow(/WEAK_PASSPHRASE/);
    await expect(encryptKeystore(Buffer.alloc(32), pass(), { label: "x", scrypt: FAST })).rejects.toThrow(/BAD_FORMAT/);
    await expect(encryptKeystore(KEY, pass(), { label: "Bad Label", scrypt: FAST })).rejects.toThrow(/label/);
  });

  it("key generation rejects out-of-range scalars", () => {
    expect(isValidPrivateKey(Buffer.alloc(32))).toBe(false);
    expect(isValidPrivateKey(Buffer.alloc(32, 0xff))).toBe(false);
    expect(isValidPrivateKey(Buffer.alloc(31, 1))).toBe(false);
    let calls = 0;
    const k = generatePrivateKeyBytes(() => (calls++ === 0 ? Buffer.alloc(32, 0xff) : Buffer.from(KEY)));
    expect(k.equals(KEY)).toBe(true);
    expect(calls).toBe(2);
    expect(() => generatePrivateKeyBytes(() => Buffer.alloc(32))).toThrow(/invalid keys/);
  });
});

describe("keystore files and permissions", () => {
  it("writes 0600 with O_EXCL and never overwrites", async () => {
    const p = join(ksDir, "k.json");
    writeKeystoreFile(p, await sample());
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const before = readFileSync(p, "utf8");
    expect(() => writeKeystoreFile(p, { ...(JSON.parse(before) as KeystoreFile), label: "other" })).toThrow(/EXISTS/);
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it("refuses to write into a directory that is not 0700", async () => {
    chmodSync(ksDir, 0o755);
    expect(() => writeKeystoreFile(join(ksDir, "k.json"), {} as KeystoreFile)).toThrow(/INSECURE_PERMISSIONS/);
    expect(() => writeKeystoreFile(join(dir, "missing", "k.json"), {} as KeystoreFile)).toThrow(/does not exist/);
  });

  it("refuses group/other-readable files, open directories and symlinks", async () => {
    const p = join(ksDir, "k.json");
    writeKeystoreFile(p, await sample());
    expect(readKeystoreFile(p, { minN }).address).toBeTruthy();
    chmodSync(p, 0o640);
    expect(() => readKeystoreFile(p, { minN })).toThrow(/INSECURE_PERMISSIONS/);
    chmodSync(p, 0o604);
    expect(() => readKeystoreFile(p, { minN })).toThrow(/INSECURE_PERMISSIONS/);
    chmodSync(p, 0o400);
    expect(readKeystoreFile(p, { minN }).address).toBeTruthy();
    chmodSync(ksDir, 0o750);
    expect(() => readKeystoreFile(p, { minN })).toThrow(/need 0700/);
    chmodSync(ksDir, 0o700);
    const link = join(ksDir, "link.json");
    symlinkSync(p, link);
    expect(() => readKeystoreFile(link, { minN })).toThrow(/regular file/);
    expect(() => readKeystoreFile(join(ksDir, "nope.json"), { minN })).toThrow(/cannot stat/);
  });

  it("a passphrase/credential file only needs a non-writable directory", () => {
    const p = join(dir, "cred");
    writeFileSync(p, "x", { mode: 0o600 });
    chmodSync(dir, 0o755);
    expect(() => assertPrivateFile(p)).not.toThrow();
    chmodSync(dir, 0o775);
    expect(() => assertPrivateFile(p)).toThrow(/too open/);
    chmodSync(dir, 0o700);
  });

  it("rejects non-JSON keystore files", () => {
    const p = join(ksDir, "k.json");
    writeFileSync(p, "not json", { mode: 0o600 });
    expect(() => readKeystoreFile(p, { minN })).toThrow(/not JSON/);
  });

  it("loadKeystoreAccount pins the configured address and wipes the passphrase", async () => {
    const p = join(ksDir, "k.json");
    const ks = await sample();
    writeKeystoreFile(p, ks);
    const b = pass();
    const acct = await loadKeystoreAccount({ path: p, passphrase: b, expectedAddress: ks.address, minN });
    expect(acct.address).toBe(ks.address);
    expect(b.every((x) => x === 0)).toBe(true);

    const other = privateKeyToAccount(bytesToHex(generatePrivateKeyBytes())).address;
    const b2 = pass();
    await expect(loadKeystoreAccount({ path: p, passphrase: b2, expectedAddress: other, minN })).rejects.toThrow(/ADDRESS_MISMATCH/);
    expect(b2.every((x) => x === 0)).toBe(true);
    const b3 = Buffer.from("wrong passphrase but long enough");
    await expect(loadKeystoreAccount({ path: p, passphrase: b3, expectedAddress: ks.address, minN })).rejects.toThrow(/DECRYPT_FAILED/);
    expect(b3.every((x) => x === 0)).toBe(true);
    await expect(loadKeystoreAccount({ path: p, passphrase: pass(), expectedAddress: "0x12" as never, minN })).rejects.toThrow(/BAD_FORMAT/);
    // production default refuses the fast test KDF
    await expect(loadKeystoreAccount({ path: p, passphrase: pass(), expectedAddress: ks.address })).rejects.toThrow(/WEAK_KDF/);
  });

  it("keystore whose header address was swapped to another key is rejected (address pinned twice)", async () => {
    const p = join(ksDir, "k.json");
    const ks = await sample();
    const other = privateKeyToAccount(bytesToHex(generatePrivateKeyBytes())).address;
    writeKeystoreFile(p, { ...ks, address: other });
    await expect(loadKeystoreAccount({ path: p, passphrase: pass(), expectedAddress: other, minN })).rejects.toThrow(/DECRYPT_FAILED/);
  });
});

describe("keygen", () => {
  it("creates a usable keystore, reports only address/public key, wipes the passphrase", async () => {
    const out = join(ksDir, "submitter.json");
    const b = pass();
    const r = await keygen({ out, label: "submitter", passphrase: b, scrypt: FAST, minN });
    expect(b.every((x) => x === 0)).toBe(true);
    expect(Object.keys(r).sort()).toEqual(["address", "keystore", "label", "publicKey"]);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const v = await verifyKeystore({ path: out, passphrase: pass(), expectAddress: r.address, minN });
    expect(v.address).toBe(r.address);
    await expect(verifyKeystore({ path: out, passphrase: pass(), expectAddress: "0x0000000000000000000000000000000000000001", minN })).rejects.toThrow(/ADDRESS_MISMATCH/);
    // never overwrites an existing keystore
    await expect(keygen({ out, label: "submitter", passphrase: pass(), scrypt: FAST, minN })).rejects.toThrow(/EXISTS/);
  });

  it("refuses a short passphrase and leaves nothing behind", async () => {
    const out = join(ksDir, "x.json");
    await expect(keygen({ out, label: "x", passphrase: Buffer.from("short"), scrypt: FAST, minN })).rejects.toThrow(/WEAK_PASSPHRASE/);
    expect(existsSync(out)).toBe(false);
  });

  it("removes its own file when the read-back check fails (weak KDF vs production minimum)", async () => {
    const out = join(ksDir, "y.json");
    await expect(keygen({ out, label: "y", passphrase: pass(), scrypt: FAST })).rejects.toThrow(/WEAK_KDF/);
    expect(existsSync(out)).toBe(false);
  });
});

describe("credentials", () => {
  it("reads $CREDENTIALS_DIRECTORY/<name>, strips one newline, refuses open modes and bad names", () => {
    const cd = join(dir, "creds");
    mkdirSync(cd, { mode: 0o700 });
    writeFileSync(join(cd, "pass"), `${PASS}\n`, { mode: 0o400 });
    const env = { CREDENTIALS_DIRECTORY: cd };
    const b = readCredential("pass", env);
    expect(b.toString()).toBe(PASS);
    wipe(b);
    expect(b.every((x) => x === 0)).toBe(true);
    writeFileSync(join(cd, "crlf"), "abc\r\n", { mode: 0o600 });
    expect(readCredentialText("crlf", env)).toBe("abc");
    writeFileSync(join(cd, "empty"), "\n", { mode: 0o600 });
    expect(() => readCredential("empty", env)).toThrow(/empty/);
    writeFileSync(join(cd, "open"), "x", { mode: 0o644 });
    chmodSync(join(cd, "open"), 0o644);
    expect(() => readCredential("open", env)).toThrow(/INSECURE_PERMISSIONS/);
    expect(() => credentialPath("../etc/passwd", env)).toThrow(/invalid/);
    expect(() => readCredential("pass", {})).toThrow(/CREDENTIALS_DIRECTORY is not set/);
    expect(() => readCredential("missing", env)).toThrow(/cannot stat/);
  });
});
