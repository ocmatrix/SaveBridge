import { useEffect, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { describeError } from "../lib/chain";
import { SIDE_NAME, SIDES, type Side } from "../lib/config";
import { applyParams, classify, crossWarnings, FIELDS, planKind, readParams, setSupplyCeiling, validate, type Params } from "../lib/params";
import { gate, gateWith } from "../lib/perm";
import { readReserve } from "../lib/reserves";
import { ActionButton, me, Section, useApp } from "../ui";

const CHANGE_TEXT = { same: "", tighten: "收紧", loosen: "放宽（需时间锁）" } as const;

export function ParamsPage() {
  const { chains, signer, both } = useApp();
  const [cur, setCur] = useState<Partial<Record<Side, { params: Params; decimals: number }>>>({});
  const [input, setInput] = useState<Partial<Record<Side, Record<string, string>>>>({});
  const [ceiling, setCeiling] = useState<{ cur: bigint; supply: bigint } | null>(null);
  const [ceilingInput, setCeilingInput] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const [b, w, r] = await Promise.all([readParams(chains.bsc), readParams(chains.wantos), readReserve(chains.wantos)]);
      setCur({ bsc: b, wantos: w });
      const show = (s: Side, x: { params: Params; decimals: number }) =>
        Object.fromEntries(FIELDS[s].map((f) => [f.key, f.kind === "amount" ? formatUnits(x.params[f.key]!, x.decimals) : String(x.params[f.key])]));
      setInput({ bsc: show("bsc", b), wantos: show("wantos", w) });
      setCeiling({ cur: r.supplyCeiling!, supply: r.totalSupply! });
      setCeilingInput(formatUnits(r.supplyCeiling!, r.decimals));
    } catch (e) {
      setErr(describeError(e));
    }
  };
  useEffect(() => void load(), [chains]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!both || !cur.bsc || !cur.wantos) return <p>{err ?? "读取中…"}</p>;
  const m = me(signer);

  const parsed = (s: Side): Params | null => {
    try {
      return Object.fromEntries(FIELDS[s].map((f) => [f.key, f.kind === "amount" ? parseUnits(input[s]![f.key]!.trim(), cur[s]!.decimals) : BigInt(input[s]![f.key]!.trim())]));
    } catch {
      return null;
    }
  };
  const next = { bsc: parsed("bsc"), wantos: parsed("wantos") };
  const cross = next.bsc && next.wantos ? crossWarnings(next.bsc, next.wantos) : [];

  return (
    <div>
      <p className="hint">收紧：管理钱包一笔交易立即生效（任何一项是放宽整笔回滚）。放宽：生成时间锁提议，48 小时后执行。收紧顺序先 WANTOS 再 BSC；放宽反过来。</p>
      {cross.length > 0 && <p className="warn">跨链一致性：{cross.join("；")}</p>}
      {SIDES.map((s) => {
        const n = next[s];
        const changes = n ? classify(s, cur[s]!.params, n) : null;
        const errs = n ? validate(s, n, cur[s]!.decimals) : ["有无法识别的数字"];
        const kind = changes ? planKind(changes) : "none";
        return (
          <Section key={s} title={`${SIDE_NAME[s]} 参数`}>
            <table>
              <tbody>
                {FIELDS[s].map((f) => (
                  <tr key={f.key}>
                    <td>{f.label}</td>
                    <td>
                      <input
                        aria-label={`${SIDE_NAME[s]} ${f.label}`}
                        value={input[s]![f.key]}
                        onChange={(e) => setInput((x) => ({ ...x, [s]: { ...x[s]!, [f.key]: e.target.value } }))}
                      />
                      {f.kind === "seconds" ? " 秒" : ""}
                    </td>
                    <td className={changes?.[f.key] === "loosen" ? "warn" : undefined}>{changes ? CHANGE_TEXT[changes[f.key]!] : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {errs.length > 0 && <p className="err">{errs.join("；")}</p>}
            <ActionButton
              label={kind === "timelock" ? "生成时间锁提议（48h）" : "收紧（立即，一笔）"}
              gate={gateWith(gate("admin", m, both[s]), [kind !== "none", "参数没有变化"], [errs.length === 0, "参数不合法"], [kind === "direct" || !both[s].paused, "暂停期间不能提议放宽"])}
              confirmText={kind === "timelock" ? "生成放宽提议？48 小时后才能执行，期间白名单钱包可以取消。" : "立即收紧？"}
              run={async () => (await applyParams(chains[s], signer!, both[s].timelock, cur[s]!.params, n!), await load())}
            />
          </Section>
        );
      })}
      {ceiling && (
        <Section title="WANTOS-USDT 发行上限 supplyCeiling">
          <p>当前上限 {formatUnits(ceiling.cur, cur.wantos.decimals)}；当前总量 {formatUnits(ceiling.supply, cur.wantos.decimals)}（降低立即生效，不得低于总量；提高走时间锁）</p>
          <input aria-label="新的发行上限" value={ceilingInput} onChange={(e) => setCeilingInput(e.target.value)} />
          <ActionButton
            label="提交新上限"
            gate={(() => {
              let v: bigint | null = null;
              try {
                v = parseUnits(ceilingInput.trim(), cur.wantos.decimals);
              } catch {
                /* invalid */
              }
              return gateWith(gate("admin", m, both.wantos), [v !== null && v !== ceiling.cur, "没有变化或数字无效"], [v === null || v >= ceiling.supply, "不得低于当前总量"]);
            })()}
            run={async () => (await setSupplyCeiling(chains.wantos, signer!, both.wantos.timelock, ceiling.cur, parseUnits(ceilingInput.trim(), cur.wantos!.decimals)), await load())}
          />
        </Section>
      )}
    </div>
  );
}
