import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

/**
 * Throw-away TEST keys, generated per run and stored ONLY in the run directory (mode 0600, outside
 * the repository). Never reused for mainnet; the run ends with a reminder to destroy the directory.
 */
export const ROLE_NAMES = [
  "deployer",
  "funder", // test-token minter / reserve funder / gas faucet on local
  "admin",
  "admin2",
  "admin3",
  "wl",
  "wl2",
  "wl3",
  "wl4",
  "pauser",
  "pauser2",
  "pauser3",
  "wantosRelayer",
  "bscRelayer",
  "wantosRelayer2",
  "bscRelayer2",
  "submitter",
  "attacker",
] as const;
export type Role = (typeof ROLE_NAMES)[number];

export const USER_COUNT = 100;

export interface KeyFile {
  createdAt: string;
  roles: Record<Role, Hex>;
  users: Hex[];
}

export interface Keys {
  file: KeyFile;
  role(r: Role): PrivateKeyAccount;
  user(i: number): PrivateKeyAccount; // 1-based U1..U100
  users(from: number, to: number): PrivateKeyAccount[];
  addresses(): Record<string, Address>;
}

export function loadOrCreateKeys(path: string): Keys {
  let file: KeyFile;
  if (existsSync(path)) file = JSON.parse(readFileSync(path, "utf8")) as KeyFile;
  else {
    file = {
      createdAt: new Date().toISOString(),
      roles: Object.fromEntries(ROLE_NAMES.map((r) => [r, generatePrivateKey()])) as Record<Role, Hex>,
      users: Array.from({ length: USER_COUNT }, () => generatePrivateKey()),
    };
    writeFileSync(path, JSON.stringify(file, null, 1), { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  const cache = new Map<string, PrivateKeyAccount>();
  const acct = (k: Hex): PrivateKeyAccount => {
    let a = cache.get(k);
    if (!a) cache.set(k, (a = privateKeyToAccount(k)));
    return a;
  };
  const keys: Keys = {
    file,
    role: (r) => acct(file.roles[r]),
    user: (i) => {
      const k = file.users[i - 1];
      if (!k) throw new Error(`no user U${i}`);
      return acct(k);
    },
    users: (from, to) => Array.from({ length: to - from + 1 }, (_, j) => keys.user(from + j)),
    addresses: () => ({
      ...Object.fromEntries(ROLE_NAMES.map((r) => [r, acct(file.roles[r]).address])),
      ...Object.fromEntries(file.users.map((k, i) => [`U${i + 1}`, acct(k).address])),
    }),
  };
  return keys;
}
