/**
 * Scrubs secrets from free-form text before it reaches a log, an alert or a Telegram message:
 * Telegram bot tokens (also inside api.telegram.org/bot<token>/ URLs), URL userinfo/path/query (RPC API
 * keys), Authorization / Bearer values, key=value secrets, 64-hex strings (private keys), plus any exact
 * secret values the caller registers (token, chat id, heartbeat URL, passphrase).
 */
export function redact(text: string, known: readonly string[] = []): string {
  let t = text;
  for (const s of known) if (s && s.length >= 4) t = t.split(s).join("<redacted>");
  return t
    .replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, "bot<redacted>")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g, "<redacted-token>")
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/(?:[^@\s/"'<>]*@)?([^/\s"'?#<>:]+)(:\d+)?[^\s"'<>]*/gi, (_m, s: string, h: string, p?: string) => `${s}://${h}${p ?? ""}/<redacted>`)
    .replace(/(authorization["']?\s*[:=]\s*["']?)(bearer|basic)?\s*[^\s"',}]+/gi, (_m, k: string) => `${k}<redacted>`)
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/((?:x-)?api[-_]?key|token|secret|password|passphrase)(["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, (_m, k: string, sep: string) => `${k}${sep}<redacted>`)
    .replace(/(0x)?[0-9a-fA-F]{64,}/g, "<redacted-64hex>");
}

export const errText = (e: unknown, known: readonly string[] = []): string => redact(e instanceof Error ? e.message.split("\n")[0]! : String(e), known);
