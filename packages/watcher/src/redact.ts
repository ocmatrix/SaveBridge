/**
 * B3: scrub credentials from error text before it reaches alert details, alerts.jsonl, IM or logs.
 * viem errors embed the RPC URL (which often carries an API key in the path / query / userinfo) and
 * request bodies; never let a 64-hex string (could be a private key) through either.
 */
export function redact(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/(?:[^@\s/"'<>]*@)?([^/\s"'?#<>:]+)(:\d+)?[^\s"'<>]*/gi, (_m, scheme: string, host: string, port?: string) => `${scheme}://${host}${port ?? ""}/<redacted>`)
    .replace(/(authorization["']?\s*[:=]\s*["']?)(bearer|basic)?\s*[^\s"',}]+/gi, (_m, k: string) => `${k}<redacted>`)
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/((?:x-)?api[-_]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, (_m, k: string, sep: string) => `${k}${sep}<redacted>`)
    .replace(/(0x)?[0-9a-fA-F]{64,}/g, "<redacted-64hex>");
}

/**
 * Keeps the whole error, not just its first line: viem puts the provider's own reason in "Details:"
 * (e.g. "block range extends beyond current head"), and a first-line cut hides it. Redact first, then cap length.
 */
export const errText = (e: unknown): string => {
  const full = e instanceof Error ? e.message : String(e);
  const oneLine = full.split("\n").map((s) => s.trim()).filter(Boolean).join(" | ");
  return redact(oneLine).slice(0, 400);
};
