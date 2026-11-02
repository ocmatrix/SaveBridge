import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BaseError, ContractFunctionRevertedError } from "viem";
import { classify, FIELDS, readParams, tuple, type Params } from "../../src/lib/params";
import { send } from "../../src/lib/chain";
import { localSigner, startWorld, type World } from "../support/world";

let w: World;
beforeAll(async () => {
  w = await startWorld();
});
afterAll(async () => w?.stop());

async function revertOf(p: Promise<unknown>): Promise<{ name?: string; args?: readonly unknown[] } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const r = (e as BaseError).walk?.((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    return { name: r?.data?.errorName, args: r?.data?.args };
  }
}

describe("page's tighten/loosen direction == contract's NotTightening(i), field by field (both chains)", () => {
  for (const side of ["bsc", "wantos"] as const) {
    it(side, async () => {
      const ctx = w.chains[side];
      const admin = localSigner(w, w.act.admin);
      const setDirect = (p: Params) => send(ctx, admin, { address: ctx.cfg.bridge, abi: ctx.bridgeAbi, functionName: "setParams", args: [tuple(side, p)] });
      for (const [i, f] of FIELDS[side].entries()) {
        const { params: cur, decimals } = await readParams(ctx);
        const d = f.kind === "amount" ? 10n ** BigInt(decimals) : 1n;
        // the move the PAGE calls "tighten" must be accepted directly by the admin wallet
        const up = { ...cur, [f.key]: cur[f.key]! + d };
        const down = { ...cur, [f.key]: cur[f.key]! - d };
        const tight = classify(side, cur, up)[f.key] === "tighten" ? up : down;
        expect(classify(side, cur, tight)[f.key], f.key).toBe("tighten");
        expect(await revertOf(setDirect(tight)), `${f.key} tighten`).toBeNull();
        // going back is what the PAGE calls "loosen": the contract must refuse it with NotTightening(i)
        expect(classify(side, tight, cur)[f.key], f.key).toBe("loosen");
        const r = await revertOf(setDirect(cur));
        expect(r?.name, `${f.key} loosen`).toBe("NotTightening");
        expect(r?.args?.[0], f.key).toBe(BigInt(i));
      }
    });
  }
});
