/**
 * PR-9 network guard. The rehearsal may only ever talk to:
 *   - local anvil chains it spawned itself (chain ids 31337 / 31338, 127.0.0.1), or
 *   - WANTON testnet 1345 and BSC testnet 97 (profile "testnet", only with explicit authorization).
 * Everything else — WANTOS mainnet 13555, BSC mainnet 56, any other chain — is refused before a
 * single request is sent, and again after `eth_chainId` answers.
 */
export const LOCAL_CHAIN_IDS = { wantos: 31337, bsc: 31338 } as const;
export const TESTNET_CHAIN_IDS = { wantos: 1345, bsc: 97 } as const;
export const FORBIDDEN_CHAIN_IDS = [13555, 56, 1] as const;

export type Side = "wantos" | "bsc";
export type Profile = "local" | "testnet";

/** Hosts / IPs that must never be contacted from this tool (production nodes, S1, rpc1/rpc2). */
const FORBIDDEN_HOST_PATTERNS = [/^101\.32\./, /bsc-dataseed/i, /wantos\.io$/i, /mainnet/i];

export function assertChainAllowed(profile: Profile, side: Side, chainId: number): void {
  if ((FORBIDDEN_CHAIN_IDS as readonly number[]).includes(chainId)) throw new Error(`PR-9 guard: chain ${chainId} is a mainnet; refused`);
  const want = profile === "local" ? LOCAL_CHAIN_IDS[side] : TESTNET_CHAIN_IDS[side];
  if (chainId !== want) throw new Error(`PR-9 guard: ${side} chain id must be ${want} for profile ${profile}, got ${chainId}`);
}

export function assertUrlAllowed(profile: Profile, url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("PR-9 guard: invalid RPC URL");
  }
  if (profile === "local" && u.hostname !== "127.0.0.1") throw new Error("PR-9 guard: local profile only talks to 127.0.0.1");
  if (FORBIDDEN_HOST_PATTERNS.some((p) => p.test(u.hostname))) throw new Error(`PR-9 guard: host ${u.hostname} is forbidden`);
}

/**
 * The testnet profile sends real (testnet) transactions. It only runs when the operator states the
 * authorization explicitly: flag --authorized AND env PR9_TESTNET_AUTHORIZED=1.
 */
export function assertTestnetAuthorized(args: readonly string[], env: Record<string, string | undefined>): void {
  if (!args.includes("--authorized") || env["PR9_TESTNET_AUTHORIZED"] !== "1")
    throw new Error("PR-9 guard: the testnet profile needs the owner's authorization (--authorized and PR9_TESTNET_AUTHORIZED=1)");
}
