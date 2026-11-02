import type { AppConfig } from "./lib/config";

const origin = (u: string) => new URL(u).origin;

/** Strict CSP (DESIGN §8.4): own scripts only; network only to the two RPCs and the admin Worker. */
export function buildCsp(cfg: AppConfig): string {
  const connect = ["'self'", origin(cfg.wantos.rpcUrl), origin(cfg.bsc.rpcUrl), ...(cfg.adminApi ? [origin(cfg.adminApi)] : [])];
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${[...new Set(connect)].join(" ")}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** Cloudflare Pages `_headers`. HSTS + no framing + no referrer. */
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
    "  Cache-Control: no-store",
    "",
  ].join("\n");
}
