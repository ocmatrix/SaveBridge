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

export async function connect() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "连接钱包" }));
  await user.click(await screen.findByRole("button", { name: "Mock Connector" }));
  await screen.findByRole("button", { name: "断开" }, T);
  return user;
}

export const panel = (name: string) => screen.getByRole("region", { name });

export async function typeAmount(user: ReturnType<typeof userEvent.setup>, region: HTMLElement, v: string) {
  const input = within(region).getByLabelText("金额（USDT）");
  await user.clear(input);
  await user.type(input, v);
}

export async function toBsc(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("tab", { name: "BSC → WANTOS" }));
  const b2w = panel("BSC → WANTOS");
  const sw = within(b2w).queryByRole("button", { name: "切换到 BSC" });
  if (sw) {
    await user.click(sw);
    await waitFor(() => expect(within(b2w).queryByText("当前网络不是 BSC，请切换")).toBeNull(), T);
  }
  return b2w;
}
