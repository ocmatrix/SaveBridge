import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { useDeps } from "./context";
import { readBridgeState } from "./lib/reader";
import { quoteBridgeOutFee, quoteDepositFee } from "./lib/fee";
import type { KnownIds } from "./lib/statusProvider";

export function useBridgeState(user: Address | undefined) {
  const { cfg, clients } = useDeps();
  return useQuery({
    queryKey: ["bridge-state", user ?? null],
    queryFn: () => readBridgeState(cfg, clients, user),
    refetchInterval: 15_000,
  });
}

export function useOrders(user: Address | undefined, known: KnownIds) {
  const { statusProvider } = useDeps();
  return useQuery({
    queryKey: ["orders", user ?? null, (known.w2b ?? []).map(String), (known.b2w ?? []).map(String)],
    queryFn: () => statusProvider.list(user!, known),
    enabled: !!user,
    refetchInterval: 20_000,
  });
}

/** WANT fee of a bridgeOut of `amount` (0 = off). Re-read every 15 s: the contract is the only source of the number. */
export function useBridgeOutFee(amount: bigint | undefined) {
  const { cfg, clients } = useDeps();
  return useQuery({
    queryKey: ["fee-w2b", amount?.toString() ?? null],
    queryFn: () => quoteBridgeOutFee(clients.wantos, cfg, amount!),
    enabled: amount !== undefined && amount > 0n,
    refetchInterval: 15_000,
  });
}

/** BNB fee of a deposit at the current gas price (0 = off). */
export function useDepositFee(owner: Address | undefined) {
  const { cfg, clients } = useDeps();
  return useQuery({
    queryKey: ["fee-b2w", owner ?? null],
    queryFn: () => quoteDepositFee(clients.bsc, cfg, owner!),
    enabled: !!owner,
    refetchInterval: 15_000,
  });
}
