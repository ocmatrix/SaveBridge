/**
 * Redaction for exception text that ends up in alerts / logs (Gate2 B3). RPC URLs may carry API keys in
 * userinfo, path or query; transports may echo Authorization headers. Applied ONLY to free-form error
 * text — structured alert fields (orderId, eventKey, txHash in `data`) are never passed through it.
 */
const URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/([^\s"'<>]+)/gi;
const BEARER_RE = /\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const AUTH_RE = /(authorization["']?\s*[:=]\s*["']?)(?:basic|bearer)?\s*[^\s"',}]+/gi;
const HEX64_RE = /\b(?:0x)?[0-9a-fA-F]{64}\b/g;

export function redact(text: string): string {
  return text
    .replace(URL_RE, (_m, scheme: string, rest: string) => {
      const cut = rest.search(/[/?#]/);
      const authority = cut === -1 ? rest : rest.slice(0, cut);
      const host = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
      return `${scheme}://${host}${cut === -1 ? "" : "/<redacted>"}`;
    })
    .replace(AUTH_RE, "$1<redacted>")
    .replace(BEARER_RE, "$1 <redacted>")
    .replace(HEX64_RE, "<redacted-hex64>");
}

/** Redacted error message for alerts/logs. */
export function errText(e: unknown): string {
  return redact((e as Error)?.message ?? String(e));
}
