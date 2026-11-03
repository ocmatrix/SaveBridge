import { expect } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WaitForTransactionReceiptTimeoutError, type Hex, type PublicClient } from "viem";
import { makeClients, type Clients } from "../../src/lib/clients";
import type { AppConfig } from "../../src/config";

export const T = { timeout: 15_000 };

/** Receipt waits on `side` succeed `okWaits` times, then time out although the tx is mined. `gate`, if given, is awaited first. */
export function flaky(cfg: AppConfig, side: "wantos" | "bsc", okWaits: number, gate?: () => Promise<void>, base: Clients = makeClients(cfg)): Clients {
  let n = 0;
  const pc = base[side];
  const waitForTransactionReceipt = (async (args: { hash: Hex }) => {
    if (n++ < okWaits) return pc.waitForTransactionReceipt(args);
    if (gate) await gate();
    throw new WaitForTransactionReceiptTimeoutError({ hash: args.hash });
  }) as PublicClient["waitForTransactionReceipt"];
  return { ...base, [side]: { ...pc, waitForTransactionReceipt } as PublicClient };
}

/** The page connects to the app's wallet on its own (no connect button): wait until the amount box is usable. */
export async function waitConnected() {
  await waitFor(() => expect(screen.getByLabelText("金额（USDT）")).toBeEnabled(), T);
}

export async function connect() {
  const user = userEvent.setup();
  await waitConnected();
  return user;
}

/** The single big button of a card. */
export const submit = (region: HTMLElement) => within(region).getByTestId("submit");

export const panel = (name: string) => screen.getByRole("region", { name });

export async function typeAmount(user: ReturnType<typeof userEvent.setup>, region: HTMLElement, v: string) {
  const input = within(region).getByLabelText("金额（USDT）");
  await user.clear(input);
  await user.type(input, v);
}

/** Flip the card to BSC → WANTOS; the wallet is switched to BSC on its own. */
export async function toBsc(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "切换方向" }));
  const b2w = panel("BSC → WANTOS");
  await waitFor(() => expect(within(b2w).queryByRole("button", { name: "请切换到 BSC" })).toBeNull(), T);
  return b2w;
}
