/** Error text for alerts/logs (redaction added in Gate2 B3). */
export function errText(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}
