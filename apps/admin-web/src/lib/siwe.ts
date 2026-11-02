import { getAddress, type Address, type Hex } from "viem";
import type { Signer } from "./chain";

/** Session lifetime (short; DESIGN §8.2 "短期会话"). */
export const SESSION_TTL_MS = 15 * 60 * 1000;

/** EIP-4361 message. The relayer (not the Worker) must verify it: domain, expiry, nonce, signer == on-chain admin/WL. */
export function siweMessage(a: { domain: string; address: Address; chainId: number; nonce: string; issuedAt: Date; expiresAt: Date }): string {
  return [
    `${a.domain} wants you to sign in with your Ethereum account:`,
    getAddress(a.address),
    "",
    "WANTOS bridge admin: read relayer data (short session).",
    "",
    `URI: https://${a.domain}`,
    "Version: 1",
    `Chain ID: ${a.chainId}`,
    `Nonce: ${a.nonce}`,
    `Issued At: ${a.issuedAt.toISOString()}`,
    `Expiration Time: ${a.expiresAt.toISOString()}`,
  ].join("\n");
}

export function randomNonce(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export interface Session {
  address: Address;
  header: string;
  expiresAt: number;
}

/** `Authorization: SIWE <base64(message)>.<signature>` (placeholder contract with the relayer's AdminSessionVerifier, PR3-NOTES Q5). */
export async function createSession(signer: Signer, o: { domain: string; chainId: number; now?: Date }): Promise<Session> {
  const issuedAt = o.now ?? new Date();
  const expiresAt = new Date(issuedAt.getTime() + SESSION_TTL_MS);
  const message = siweMessage({ domain: o.domain, address: signer.address, chainId: o.chainId, nonce: randomNonce(), issuedAt, expiresAt });
  const signature: Hex = await signer.signMessage(message);
  return { address: signer.address, header: `SIWE ${b64(message)}.${signature}`, expiresAt: expiresAt.getTime() };
}

export const sessionValid = (s: Session | null, address: Address | undefined, nowMs = Date.now()) =>
  !!s && !!address && s.address.toLowerCase() === address.toLowerCase() && s.expiresAt - 30_000 > nowMs;
