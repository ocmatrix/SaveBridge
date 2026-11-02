import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { useDeps } from "./context";
import { readBridgeState } from "./lib/reader";
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
