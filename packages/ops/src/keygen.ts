/**
 * `savebridge-keygen` logic: generate a secp256k1 key ON the target server, encrypt it into a 0600
 * keystore (never overwriting), re-read and decrypt it once to prove the file is usable, and report
 * ONLY the address and public key. The passphrase arrives as a Buffer (stdin pipe or credential) and
 * is wiped here; the plaintext key is wiped after encryption.
 */
import { unlinkSync } from "node:fs";
import type { Address, Hex } from "viem";
import { assertPassphrase, decryptKeystore, encryptKeystore, generatePrivateKeyBytes, readKeystoreFile, writeKeystoreFile, KeystoreError } from "./keystore.js";

export interface KeygenResult {
  address: Address;
  publicKey: Hex;
  keystore: string;
  label: string;
}

export async function keygen(o: { out: string; label: string; passphrase: Buffer; scrypt?: { N: number; r: number; p: number }; random?: (n: number) => Buffer; minN?: number }): Promise<KeygenResult> {
  let pk: Buffer | undefined;
  try {
    assertPassphrase(o.passphrase);
    pk = generatePrivateKeyBytes(o.random);
    const ks = await encryptKeystore(pk, o.passphrase, { label: o.label, scrypt: o.scrypt, random: o.random });
    writeKeystoreFile(o.out, ks);
    try {
      const back = await decryptKeystore(readKeystoreFile(o.out, { minN: o.minN }), o.passphrase, { minN: o.minN });
      const same = back.privateKey.equals(pk);
      back.privateKey.fill(0);
      if (!same) throw new KeystoreError("IO", "round-trip produced a different key");
    } catch (e) {
      unlinkSync(o.out); // our own, just-created file: never leave an unusable keystore behind
      throw e;
    }
    return { address: ks.address, publicKey: ks.publicKey, keystore: o.out, label: o.label };
  } finally {
    pk?.fill(0);
    o.passphrase.fill(0);
  }
}

/** Verify a keystore + passphrase without starting a service; prints the address only. */
export async function verifyKeystore(o: { path: string; passphrase: Buffer; expectAddress?: string; minN?: number }): Promise<{ address: Address }> {
  try {
    const { privateKey, address } = await decryptKeystore(readKeystoreFile(o.path, { minN: o.minN }), o.passphrase, { minN: o.minN });
    privateKey.fill(0);
    if (o.expectAddress && o.expectAddress.toLowerCase() !== address.toLowerCase()) throw new KeystoreError("ADDRESS_MISMATCH", `keystore holds ${address}, expected ${o.expectAddress}`);
    return { address };
  } finally {
    o.passphrase.fill(0);
  }
}
