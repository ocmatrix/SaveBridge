/**
 * Secrets (keystore passphrase, Telegram token / chat id, heartbeat URL) are read from systemd
 * credentials: `LoadCredential=` / `LoadCredentialEncrypted=` expose them as files under
 * `$CREDENTIALS_DIRECTORY` (a private ramfs: systemd < 254 gives the service user a 0400 file, systemd >= 254
 * a root:root 0440 file with an ACL for the service user inside a 0550 root directory). They are never
 * taken from command-line arguments, never from environment variable VALUES, never from the config file.
 */
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { KeystoreError } from "./keystore.js";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function credentialPath(name: string, env: Record<string, string | undefined> = process.env): string {
  if (!NAME.test(name)) throw new KeystoreError("BAD_FORMAT", `credential name "${name}" is invalid`);
  const dir = env["CREDENTIALS_DIRECTORY"];
  if (!dir) throw new KeystoreError("IO", `CREDENTIALS_DIRECTORY is not set: run under systemd with LoadCredential=${name}:…`);
  return join(dir, name);
}

type CredStat = { mode: number; uid: number; gid: number; isFile(): boolean };

/**
 * Why a systemd credential file must be refused, or undefined when it is fine. Owner: the service user or
 * root (systemd >= 254); no "other" bits; group bits only for root's or our own group; the directory
 * must be owned by us or root and closed to "other" and to group writes.
 */
export function credentialStatProblem(st: CredStat, ds: { mode: number; uid: number }, me: number | undefined, myGid: number | undefined): string | undefined {
  if (!st.isFile()) return "must be a regular file (no symlinks)";
  if ((st.mode & 0o007) !== 0) return `mode ${(st.mode & 0o777).toString(8)} allows other access (need 0400 or 0440)`;
  if (me !== undefined && st.uid !== me && st.uid !== 0) return "owner is neither the running user nor root";
  if ((st.mode & 0o070) !== 0 && st.gid !== 0 && st.gid !== myGid) return "group is neither root nor the running user's group";
  if (me !== undefined && ds.uid !== me && ds.uid !== 0) return "directory is owned by another user";
  if ((ds.mode & 0o027) !== 0) return `directory mode ${(ds.mode & 0o777).toString(8)} is too open`;
  return undefined;
}

/** Reads one credential into a Buffer (one trailing newline stripped). The CALLER wipes it with `wipe()`. */
export function readCredential(name: string, env: Record<string, string | undefined> = process.env): Buffer {
  const p = credentialPath(name, env);
  let st, ds;
  try {
    st = lstatSync(p);
    ds = lstatSync(dirname(p));
  } catch {
    throw new KeystoreError("IO", `cannot stat ${p}`);
  }
  const problem = credentialStatProblem(st, ds, typeof process.getuid === "function" ? process.getuid() : undefined, typeof process.getgid === "function" ? process.getgid() : undefined);
  if (problem) throw new KeystoreError("INSECURE_PERMISSIONS", `${p} ${problem}`);
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
