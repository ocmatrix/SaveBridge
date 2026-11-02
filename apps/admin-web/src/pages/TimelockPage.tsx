import { useCallback, useEffect, useState } from "react";
import { describeError } from "../lib/chain";
import { SIDE_NAME, SIDES, type Side } from "../lib/config";
import { countdown } from "../lib/handover";
import { gate, gateWith, short } from "../lib/perm";
import { cancelProposal, executeProposal, listProposals, STATE_TEXT, type Proposal } from "../lib/timelock";
import { ActionButton, me, Section, ts, useApp } from "../ui";

export function TimelockPage() {
  const { chains, signer, both } = useApp();
  const [list, setList] = useState<Partial<Record<Side, Proposal[]>>>({});
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!both) return;
    try {
      const [b, w] = await Promise.all([listProposals(chains.bsc, both.bsc.timelock), listProposals(chains.wantos, both.wantos.timelock)]);
      setList({ bsc: b, wantos: w });
      setErr(null);
    } catch (e) {
      setErr(describeError(e));
    }
  }, [chains, both]);
  useEffect(() => void load(), [load]);
  if (!both) return <p>读取链上状态中…</p>;
  const m = me(signer);
  return (
    <div>
      <p className="hint">逐条确认「这是不是我提的」，不是就取消（管理钱包或白名单钱包都能取消）。到期后任何人可执行；提交服务也会自动执行。</p>
      {err && <p className="err">{err}</p>}
      {SIDES.map((s) => {
        const st = both[s];
        const ps = list[s] ?? [];
        return (
          <Section key={s} title={`${SIDE_NAME[s]} 时间锁 ${st.timelock}`}>
            {ps.length === 0 && <p>没有提议</p>}
            {ps.map((p) => {
              const open = p.state === "waiting" || p.state === "ready";
              return (
                <div key={p.id} className="proposal" data-testid={`proposal-${p.id}`}>
                  <p>
                    <strong>{p.calls.map((c) => c.kind).join(" + ")}</strong>　<span>{STATE_TEXT[p.state]}</span>　id <code title={p.id}>{short(p.id)}</code>
                  </p>
                  {p.calls.map((c, i) => (
                    <p key={i} className="decoded">
                      → <code>{short(c.target)}</code> {c.text}
                    </p>
                  ))}
                  {open && (
                    <p>
                      可执行时间 {ts(p.readyAt)}（{p.state === "waiting" ? `还有 ${countdown(p.readyAt, st.now)}` : "已到"}）；过期 {ts(p.expiresAt)}（{countdown(p.expiresAt, st.now)}）
                    </p>
                  )}
                  {open && (
                    <p>
                      <ActionButton label="取消" danger gate={gate("adminOrWl", m, st)} confirmText="取消这条提议？" run={async () => (await cancelProposal(chains[s], signer!, st.timelock, p.id), await load())} />
                      <ActionButton
                        label="执行"
                        gate={gateWith(m ? { ok: true } : { ok: false, reason: "未连接钱包" }, [p.state === "ready", "等待期未满"], [!st.anyRecovery, "恢复进行中，时间锁不执行任何提议"])}
                        run={async () => (await executeProposal(chains[s], signer!, st.timelock, p), await load())}
                      />
                    </p>
                  )}
                </div>
              );
            })}
          </Section>
        );
      })}
    </div>
  );
}
