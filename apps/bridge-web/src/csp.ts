import type { AppConfig } from "./config";

/** WalletConnect v2 relay endpoints (QR flow without the hosted modal). */
export const WALLETCONNECT_ORIGINS = ["wss://relay.walletconnect.com", "wss://relay.walletconnect.org"];

const origin = (u: string) => new URL(u).origin;

/** Strict CSP (DESIGN §8.1/§8.4): own scripts only; network only to the two RPCs, the relayer read API and WC relay. */
export function buildCsp(cfg: AppConfig): string {
  const connect = [
    "'self'",
    origin(cfg.wantos.rpcUrl),
    origin(cfg.bsc.rpcUrl),
    ...(cfg.relayerApi ? [origin(cfg.relayerApi)] : []),
    ...WALLETCONNECT_ORIGINS,
  ];
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${[...new Set(connect)].join(" ")}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
  ].join("; ");
}

/** Cloudflare Pages `_headers` file. */
export function buildHeadersFile(cfg: AppConfig): string {
  return [
    "/*",
    `  Content-Security-Policy: ${buildCsp(cfg)}`,
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    "  Referrer-Policy: no-referrer",
    "  Strict-Transport-Security: max-age=31536000; includeSubDomains",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "  Cross-Origin-Opener-Policy: same-origin",
    "",
  ].join("\n");
}
