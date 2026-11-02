export type WhitelistState = "open" | "closed" | "syncing";

export function remaining(cap: bigint, used: bigint): bigint {
  return used >= cap ? 0n : cap - used;
}

/** Both chains are written (decision 2); a mismatch is a sync in progress. */
export function whitelistState(onWantos: boolean, onBsc: boolean): WhitelistState {
  if (onWantos && onBsc) return "open";
  if (!onWantos && !onBsc) return "closed";
  return "syncing";
}
