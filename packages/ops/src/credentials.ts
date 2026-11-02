/**
 * Secrets (keystore passphrase, Telegram token / chat id, heartbeat URL) are read from systemd
 * credentials: `LoadCredential=` / `LoadCredentialEncrypted=` expose them as files under
 * `$CREDENTIALS_DIRECTORY` (a private tmpfs, mode 0400, owned by the service user). They are never
 * taken from command-line arguments, never from environment variable VALUES, never from the config file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPrivateFile, KeystoreError } from "./keystore.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function credentialPath(name: string, env: Record<string, string | undefined> = process.env): string {
  if (!NAME.test(name)) throw new KeystoreError("BAD_FORMAT", `credential name "${name}" is invalid`);
  const dir = env["CREDENTIALS_DIRECTORY"];
  if (!dir) throw new KeystoreError("IO", `CREDENTIALS_DIRECTORY is not set: run under systemd with LoadCredential=${name}:…`);
  return join(dir, name);
}

/** Reads one credential into a Buffer (one trailing newline stripped). The CALLER wipes it with `wipe()`. */
export function readCredential(name: string, env: Record<string, string | undefined> = process.env): Buffer {
  const p = credentialPath(name, env);
  assertPrivateFile(p);
  let b: Buffer;
  try {
    b = readFileSync(p);
  } catch {
    throw new KeystoreError("IO", `cannot read credential ${name}`);
  }
  let end = b.length;
  if (end > 0 && b[end - 1] === 0x0a) end--;
  if (end > 0 && b[end - 1] === 0x0d) end--;
  const out = Buffer.from(b.subarray(0, end));
  b.fill(0);
  if (out.length === 0) throw new KeystoreError("BAD_FORMAT", `credential ${name} is empty`);
  return out;
}

/** Text credential (token, chat id, URL). Strings cannot be wiped; use only for non-key secrets. */
export function readCredentialText(name: string, env: Record<string, string | undefined> = process.env): string {
  const b = readCredential(name, env);
  try {
    return b.toString("utf8");
  } finally {
    b.fill(0);
  }
}

export function wipe(b: Buffer | undefined | null): void {
  b?.fill(0);
}
