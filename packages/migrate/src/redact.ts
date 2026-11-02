import { BaseError } from "viem";

/**
 * Error text for stderr: never the RPC URL (its path / query may carry an API key).
 * Layer 1: viem errors print only their shortMessage (the URL sits in the details).
 * Layer 2: "URL:" lines are dropped and any http(s) / ws(s) URL left in the text becomes <rpc-url>.
 */
export function safeMessage(e: unknown): string {
  const msg = e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e);
  return msg
    .split("\n")
    .filter((l) => !/^\s*URL:/i.test(l))
    .join("\n")
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, "<rpc-url>");
}
