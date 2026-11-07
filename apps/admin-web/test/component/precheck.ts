import { fireEvent, screen } from "@testing-library/react";
import { chainNow } from "../../src/lib/chain";
import type { Side } from "../../src/lib/config";
import { parseAddressList } from "../../src/lib/normalize";
import { DEADLINE_AHEAD_S, prepareJob, runJob } from "../../src/lib/whitelist";
import { localSigner, type World } from "../support/world";

/** Clicks 「先核对」(or 「重新核对」) and waits until the result is on screen. */
export const precheck = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /^(先核对|重新核对)/ }));
  await screen.findByTestId("precheck-done", {}, { timeout: 20_000 });
};

/** Puts addresses on the whitelist of the given chains only (the other chain is left untouched). */
export async function whitelistOn(w: World, addrs: string[], sides: Side[]) {
  const list = parseAddressList(addrs.join("\n")).addresses;
  const job = await prepareJob(w.chains, list, true, (await chainNow(w.chains.bsc)) + DEADLINE_AHEAD_S);
  const runs = { ...job.runs };
  for (const s of ["bsc", "wantos"] as Side[]) if (!sides.includes(s)) runs[s] = { ...runs[s], status: "skipped" };
  await runJob({ ...job, runs }, { chains: w.chains, signer: localSigner(w, w.act.wl) });
}

/** A world whose chain reads on one side fail while `state.fail` is true (models a 429 from the node). */
export function flakyWorld(w: World, side: Side, state: { fail: boolean }): World {
  const c = w.chains[side];
  const client = {
    ...c.client,
    readContract: async (...a: unknown[]) => {
      if (state.fail && (a[0] as { functionName?: string })?.functionName === "whitelisted") throw new Error("429 too many requests");
      return (c.client.readContract as (...x: unknown[]) => Promise<unknown>)(...a);
    },
  };
  return { ...w, chains: { ...w.chains, [side]: { ...c, client } } } as World;
}
