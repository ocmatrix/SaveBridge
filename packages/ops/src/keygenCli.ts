#!/usr/bin/env -S node --import tsx
/**
 * savebridge-keygen create --out /var/lib/savebridge/keystore/relayer-bsc.json --label relayer-bsc [--passphrase-credential NAME]
 * savebridge-keygen verify --keystore PATH [--expect-address 0x…] [--passphrase-credential NAME]
 *
 * The passphrase is NEVER an argument or an environment value. It is read from:
 *   - `--passphrase-credential NAME` → $CREDENTIALS_DIRECTORY/NAME (systemd-run -p LoadCredential…), or
 *   - stdin when it is a pipe (e.g. `systemd-creds decrypt … - | savebridge-keygen create …`).
 * An interactive TTY on stdin is refused (no echo handling, no shell-history risk): pipe it.
 * Output: one JSON line with address / public key / path. Nothing secret is printed.
 */
import { readCredential } from "./credentials.js";
import { keygen, verifyKeystore } from "./keygen.js";
import { errText } from "./redact.js";

const FORBIDDEN = /^--(pass(word|phrase)?|key|private-?key|secret|mnemonic)(=|$)/i;

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readStdin(): Promise<Buffer> {
  if (process.stdin.isTTY) throw new Error("refusing to read a passphrase from an interactive terminal: pipe it (systemd-ask-password … | savebridge-keygen …) or use --passphrase-credential");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const all = Buffer.concat(chunks);
  chunks.forEach((c) => c.fill(0));
  let end = all.length;
  if (end > 0 && all[end - 1] === 0x0a) end--;
  if (end > 0 && all[end - 1] === 0x0d) end--;
  const out = Buffer.from(all.subarray(0, end));
  all.fill(0);
  return out;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const bad = args.find((a) => FORBIDDEN.test(a));
  if (bad) throw new Error(`argument ${bad.split("=")[0]} is not accepted: secrets never go on the command line`);
  const cred = arg(args, "--passphrase-credential");
  const pass = cred ? readCredential(cred) : await readStdin();
  if (cmd === "create") {
    const out = arg(args, "--out"), label = arg(args, "--label");
    if (!out || !label) throw new Error("usage: savebridge-keygen create --out PATH --label LABEL");
    process.stdout.write(`${JSON.stringify(await keygen({ out, label, passphrase: pass }))}\n`);
  } else if (cmd === "verify") {
    const path = arg(args, "--keystore");
    if (!path) throw new Error("usage: savebridge-keygen verify --keystore PATH [--expect-address 0x…]");
    process.stdout.write(`${JSON.stringify(await verifyKeystore({ path, passphrase: pass, expectAddress: arg(args, "--expect-address") }))}\n`);
  } else {
    pass.fill(0);
    throw new Error("usage: savebridge-keygen create|verify …");
  }
}

main().catch((e) => {
  process.stderr.write(`savebridge-keygen: ${errText(e)}\n`);
  process.exit(2);
});
