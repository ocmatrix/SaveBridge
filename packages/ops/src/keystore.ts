/**
 * Local encrypted keystore (deploy-prep, DESIGN §4.1 / §6.1 interim until KMS).
 *
 * Construction (no home-made crypto, only Node's OpenSSL primitives):
 *   key  = scrypt(passphrase, salt[32], N, r, p, dkLen = 32)
 *   blob = AES-256-GCM(key, iv[12], plaintext = secp256k1 private key[32], AAD = every header field)
 * Any change to the header (address, label, KDF parameters, iv …), the ciphertext or the tag makes the
 * GCM tag check fail. The address stored in the header is re-derived from the decrypted key and must
 * match, and callers additionally pin the expected address from configuration.
 *
 * Secrets never appear in error messages: errors carry a fixed code and a path, nothing else.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { bytesToHex, getAddress, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const KEYSTORE_FORMAT = "savebridge-keystore";
export const KEYSTORE_VERSION = 1;
/** Production scrypt cost (~128 MiB, well under a second on one core). */
export const DEFAULT_SCRYPT = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });
/** Loading refuses anything weaker than this unless a caller (tests only) lowers it explicitly. */
export const MIN_SCRYPT_N = 2 ** 17;
/** Upper bound so a hostile file cannot make us allocate gigabytes. */
export const MAX_SCRYPT_N = 2 ** 20;
export const MIN_PASSPHRASE_BYTES = 16;
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export type KeystoreErrorCode =
  | "BAD_FORMAT"
  | "DECRYPT_FAILED"
  | "WEAK_KDF"
  | "INSECURE_PERMISSIONS"
  | "ADDRESS_MISMATCH"
  | "EXISTS"
  | "WEAK_PASSPHRASE"
  | "IO";

export class KeystoreError extends Error {
  constructor(
    readonly code: KeystoreErrorCode,
    message: string,
  ) {
    super(`keystore ${code}: ${message}`);
    this.name = "KeystoreError";
  }
}

export interface KeystoreFile {
  format: typeof KEYSTORE_FORMAT;
  version: typeof KEYSTORE_VERSION;
  label: string;
  address: Address;
  publicKey: Hex;
  createdAt: string;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  ciphertext: string;
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
const unb64 = (s: unknown, len: number, what: string): Buffer => {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new KeystoreError("BAD_FORMAT", `${what} is not base64`);
  const b = Buffer.from(s, "base64");
  if (b.length !== len) throw new KeystoreError("BAD_FORMAT", `${what} must be ${len} bytes`);
  return b;
};

/** Every header field is bound into the GCM tag (order fixed). */
function aad(k: Omit<KeystoreFile, "ciphertext" | "cipher"> & { cipher: { name: string; iv: string } }): Buffer {
  return Buffer.from(
    JSON.stringify([k.format, k.version, k.label, k.address, k.publicKey, k.createdAt, k.kdf.name, k.kdf.N, k.kdf.r, k.kdf.p, k.kdf.salt, k.cipher.name, k.cipher.iv]),
    "utf8",
  );
}

function deriveKey(passphrase: Uint8Array, salt: Buffer, p: { N: number; r: number; p: number }): Promise<Buffer> {
  const opts: ScryptOptions = { N: p.N, r: p.r, p: p.p, maxmem: 256 * p.N * p.r + 16 * 1024 * 1024 };
  return new Promise((res, rej) => scryptCb(passphrase, salt, 32, opts, (e, k) => (e ? rej(new KeystoreError("IO", "scrypt failed")) : res(k))));
}

export function isValidPrivateKey(k: Uint8Array): boolean {
  if (k.length !== 32) return false;
  const v = BigInt(bytesToHex(k));
  return v > 0n && v < SECP256K1_ORDER;
}

/** 32 random bytes from the OS CSPRNG, retried until it is a valid secp256k1 scalar. */
export function generatePrivateKeyBytes(random: (n: number) => Buffer = randomBytes): Buffer {
  for (let i = 0; i < 16; i++) {
    const k = random(32);
    if (isValidPrivateKey(k)) return k;
    k.fill(0);
  }
  throw new KeystoreError("IO", "random source keeps producing invalid keys");
}

export function assertPassphrase(p: Uint8Array): void {
  if (p.length < MIN_PASSPHRASE_BYTES) throw new KeystoreError("WEAK_PASSPHRASE", `passphrase must be at least ${MIN_PASSPHRASE_BYTES} bytes`);
}

export async function encryptKeystore(
  privateKey: Uint8Array,
  passphrase: Uint8Array,
  o: { label: string; scrypt?: { N: number; r: number; p: number }; now?: () => Date; random?: (n: number) => Buffer },
): Promise<KeystoreFile> {
  assertPassphrase(passphrase);
  if (!isValidPrivateKey(privateKey)) throw new KeystoreError("BAD_FORMAT", "not a valid secp256k1 private key");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(o.label)) throw new KeystoreError("BAD_FORMAT", "label must match [a-z0-9][a-z0-9._-]{0,63}");
  const rnd = o.random ?? randomBytes;
  const params = o.scrypt ?? DEFAULT_SCRYPT;
  const acct = privateKeyToAccount(bytesToHex(privateKey));
  const salt = rnd(32);
  const iv = rnd(12);
  const header = {
    format: KEYSTORE_FORMAT as typeof KEYSTORE_FORMAT,
    version: KEYSTORE_VERSION as typeof KEYSTORE_VERSION,
    label: o.label,
    address: acct.address,
    publicKey: acct.publicKey,
    createdAt: (o.now ?? (() => new Date()))().toISOString(),
    kdf: { name: "scrypt" as const, N: params.N, r: params.r, p: params.p, salt: b64(salt) },
    cipher: { name: "aes-256-gcm" as const, iv: b64(iv) },
  };
  const key = await deriveKey(passphrase, salt, params);
  try {
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(aad(header));
    const ct = Buffer.concat([c.update(privateKey), c.final()]);
    return { ...header, cipher: { ...header.cipher, tag: b64(c.getAuthTag()) }, ciphertext: b64(ct) } as KeystoreFile;
  } finally {
    key.fill(0);
  }
}

/** Structural validation of an untrusted keystore object (no secret involved). */
export function parseKeystore(raw: unknown, o: { minN?: number } = {}): KeystoreFile {
  const minN = o.minN ?? MIN_SCRYPT_N;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new KeystoreError("BAD_FORMAT", "not an object");
  const k = raw as Record<string, unknown>;
  if (k["format"] !== KEYSTORE_FORMAT || k["version"] !== KEYSTORE_VERSION) throw new KeystoreError("BAD_FORMAT", "unknown format/version");
  if (typeof k["label"] !== "string" || typeof k["createdAt"] !== "string") throw new KeystoreError("BAD_FORMAT", "label/createdAt missing");
  if (typeof k["address"] !== "string" || !isAddress(k["address"], { strict: false })) throw new KeystoreError("BAD_FORMAT", "address invalid");
  if (typeof k["publicKey"] !== "string" || !/^0x04[0-9a-fA-F]{128}$/.test(k["publicKey"])) throw new KeystoreError("BAD_FORMAT", "publicKey invalid");
  const kdf = k["kdf"] as Record<string, unknown> | undefined;
  const cipher = k["cipher"] as Record<string, unknown> | undefined;
  if (!kdf || kdf["name"] !== "scrypt") throw new KeystoreError("BAD_FORMAT", "kdf must be scrypt");
  if (!cipher || cipher["name"] !== "aes-256-gcm") throw new KeystoreError("BAD_FORMAT", "cipher must be aes-256-gcm");
  const N = kdf["N"], r = kdf["r"], p = kdf["p"];
  if (typeof N !== "number" || !Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0 || N > MAX_SCRYPT_N) throw new KeystoreError("BAD_FORMAT", "scrypt N invalid");
  if (typeof r !== "number" || !Number.isInteger(r) || r < 8 || r > 32) throw new KeystoreError("BAD_FORMAT", "scrypt r invalid");
  if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 4) throw new KeystoreError("BAD_FORMAT", "scrypt p invalid");
  if (N < minN) throw new KeystoreError("WEAK_KDF", `scrypt N=${N} is below the minimum ${minN}`);
  unb64(kdf["salt"], 32, "kdf.salt");
  unb64(cipher["iv"], 12, "cipher.iv");
  unb64(cipher["tag"], 16, "cipher.tag");
  unb64(k["ciphertext"], 32, "ciphertext");
  return raw as KeystoreFile;
}

/**
 * Decrypts and returns the raw private key. The CALLER must `fill(0)` the returned buffer.
 * Wrong passphrase and tampering both surface as DECRYPT_FAILED (indistinguishable on purpose).
 */
export async function decryptKeystore(raw: unknown, passphrase: Uint8Array, o: { minN?: number } = {}): Promise<{ privateKey: Buffer; address: Address }> {
  const k = parseKeystore(raw, o);
  const key = await deriveKey(passphrase, unb64(k.kdf.salt, 32, "kdf.salt"), k.kdf);
  let pk: Buffer;
  try {
    const d = createDecipheriv("aes-256-gcm", key, unb64(k.cipher.iv, 12, "cipher.iv"));
    d.setAAD(aad(k));
    d.setAuthTag(unb64(k.cipher.tag, 16, "cipher.tag"));
    pk = Buffer.concat([d.update(unb64(k.ciphertext, 32, "ciphertext")), d.final()]);
  } catch {
    throw new KeystoreError("DECRYPT_FAILED", "wrong passphrase or corrupted/tampered keystore");
  } finally {
    key.fill(0);
  }
  if (!isValidPrivateKey(pk)) {
    pk.fill(0);
    throw new KeystoreError("DECRYPT_FAILED", "decrypted key is not a valid secp256k1 scalar");
  }
  const derived = privateKeyToAccount(bytesToHex(pk)).address;
  if (getAddress(derived) !== getAddress(k.address)) {
    pk.fill(0);
    throw new KeystoreError("ADDRESS_MISMATCH", "keystore header address does not match its key");
  }
  return { privateKey: pk, address: derived };
}

const uid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/**
 * A secret file must be a regular file (not a symlink), owned by the current user, with no group/other
 * bits; its directory must be owned by us (or root) and not group/other writable. `dirPrivate` also
 * forbids group/other read on the directory (keystore dir = 0700).
 */
export function assertPrivateFile(path: string, o: { dirPrivate?: boolean } = {}): void {
  let st, ds;
  try {
    st = lstatSync(path);
    ds = lstatSync(dirname(path));
  } catch {
    throw new KeystoreError("IO", `cannot stat ${path}`);
  }
  if (!st.isFile()) throw new KeystoreError("INSECURE_PERMISSIONS", `${path} must be a regular file (no symlinks)`);
  if ((st.mode & 0o077) !== 0) throw new KeystoreError("INSECURE_PERMISSIONS", `${path} mode ${(st.mode & 0o777).toString(8)} allows group/other access (need 0600 or 0400)`);
  const me = uid();
  if (me !== undefined && st.uid !== me) throw new KeystoreError("INSECURE_PERMISSIONS", `${path} is not owned by the running user`);
  if (me !== undefined && ds.uid !== me && ds.uid !== 0) throw new KeystoreError("INSECURE_PERMISSIONS", `${dirname(path)} is owned by another user`);
  if ((ds.mode & (o.dirPrivate ? 0o077 : 0o022)) !== 0)
    throw new KeystoreError("INSECURE_PERMISSIONS", `${dirname(path)} mode ${(ds.mode & 0o777).toString(8)} is too open${o.dirPrivate ? " (need 0700)" : ""}`);
}

export function readKeystoreFile(path: string, o: { minN?: number } = {}): KeystoreFile {
  assertPrivateFile(path, { dirPrivate: true });
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new KeystoreError("IO", `cannot read ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new KeystoreError("BAD_FORMAT", `${path} is not JSON`);
  }
  return parseKeystore(raw, o);
}

/** Creates the file with O_EXCL and mode 0600; never overwrites. Directory must already be 0700. */
export function writeKeystoreFile(path: string, k: KeystoreFile): void {
  const dir = dirname(path);
  let ds;
  try {
    ds = lstatSync(dir);
  } catch {
    throw new KeystoreError("IO", `directory ${dir} does not exist`);
  }
  if (!ds.isDirectory() || (ds.mode & 0o077) !== 0) throw new KeystoreError("INSECURE_PERMISSIONS", `${dir} must be a directory with mode 0700`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new KeystoreError("EXISTS", `${path} already exists; refusing to overwrite`);
    throw new KeystoreError("IO", `cannot create ${path}`);
  }
  try {
    writeSync(fd, `${JSON.stringify(k, null, 2)}\n`);
    fsyncSync(fd);
  } catch {
    closeSync(fd);
    unlinkSync(path);
    throw new KeystoreError("IO", `cannot write ${path}`);
  }
  closeSync(fd);
}

/**
 * Startup path: read + permission checks + decrypt + pin the configured address, then wipe every
 * buffer we own. `passphrase` is wiped here as well (even on failure).
 * Note: viem keeps the key inside the returned account as a JS string, which cannot be zeroed; it
 * lives only in this process's memory (no swap of secrets is prevented here — see deploy notes).
 */
export async function loadKeystoreAccount(o: { path: string; passphrase: Buffer; expectedAddress: Address; minN?: number }): Promise<PrivateKeyAccount> {
  try {
    if (!isAddress(o.expectedAddress, { strict: false })) throw new KeystoreError("BAD_FORMAT", "expected address is not an address");
    const file = readKeystoreFile(o.path, { minN: o.minN });
    if (getAddress(file.address) !== getAddress(o.expectedAddress))
      throw new KeystoreError("ADDRESS_MISMATCH", `${o.path} holds ${getAddress(file.address)}, configuration expects ${getAddress(o.expectedAddress)}`);
    const { privateKey } = await decryptKeystore(file, o.passphrase, { minN: o.minN });
    try {
      const acct = privateKeyToAccount(bytesToHex(privateKey));
      if (getAddress(acct.address) !== getAddress(o.expectedAddress)) throw new KeystoreError("ADDRESS_MISMATCH", "decrypted key does not match configuration");
      return acct;
    } finally {
      privateKey.fill(0);
    }
  } finally {
    o.passphrase.fill(0);
  }
}
