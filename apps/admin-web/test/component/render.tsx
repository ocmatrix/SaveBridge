import { render } from "@testing-library/react";
import { App } from "../../src/App";
import type { Signer } from "../../src/lib/chain";
import type { World } from "../support/world";

export function renderApp(w: World, signer: Signer | null, path = "/", o: { adminApi?: string; fetchFn?: typeof fetch } = {}) {
  const cfg = o.adminApi ? { ...w.cfg, adminApi: o.adminApi } : w.cfg;
  return render(<App cfg={cfg} chains={w.chains} signer={signer} initialPath={path} fetchFn={o.fetchFn} />);
}
