/** Candidate public BSC testnet (chainId 97) RPC endpoints, one or more per provider. */
export const DEFAULT_BSC_TESTNET_RPCS: readonly string[] = [
  "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
  "https://data-seed-prebsc-2-s1.bnbchain.org:8545",
  "https://bsc-testnet-rpc.publicnode.com",
  "https://bsc-testnet.public.blastapi.io",
  "https://endpoints.omniatech.io/v1/bsc/testnet/public",
  "https://bsc-testnet.drpc.org",
  "https://api.zan.top/bsc-testnet",
  "https://bsc-testnet.blockpi.network/v1/rpc/public",
  "https://bsc-testnet-dataseed.bnbchain.org",
  "https://bnb-testnet.api.onfinality.io/public",
  "https://bsc-testnet.gateway.tatum.io",
  "https://97.rpc.thirdweb.com",
];

/** `BSC_TESTNET_RPCS` (comma-separated) overrides the default list. */
export function candidateEndpoints(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env["BSC_TESTNET_RPCS"];
  if (raw && raw.trim()) {
    return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  }
  return [...DEFAULT_BSC_TESTNET_RPCS];
}
