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
    .replace(/(0x)?[0-9a-fA-F]{64}\b/g, "<redacted-64hex>");
}

export const errText = (e: unknown): string => redact(e instanceof Error ? e.message.split("\n")[0]! : String(e));
