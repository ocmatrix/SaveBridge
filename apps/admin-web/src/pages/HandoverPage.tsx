import { useEffect, useState } from "react";
import { getAddress, isAddress, isAddressEqual, type Address } from "viem";
import { SIDE_NAME, SIDES, type Side } from "../lib/config";
import { actions, adminHandoverView, countdown, crossChainGaps, makeProof, verifyProof, type HandoverRole, type Proof } from "../lib/handover";
import { gate, gateWith, type Gate } from "../lib/perm";
import { cancelProposal, executeProposal, listProposals, type Proposal } from "../lib/timelock";
import { ActionButton, Addr, me, Section, ts, useApp } from "../ui";

/**
 * /handover — open without Cloudflare Access (DESIGN §8.4); the new holder may open it in a wallet DApp browser.
 * Reads chain data only; every button is one tx on one chain (do it on both chains).
 */
export function HandoverPage() {
  const { chains, signer, both, cfg } = useApp();
  const [role, setRole] = useState<HandoverRole>("admin");
  const [props, setProps] = useState<Partial<Record<Side, Proposal[]>>>({});
  const [proof, setProof] = useState<Proof | null>(null);
  const [pasted, setPasted] = useState("");
  const [verified, setVerified] = useState<Address | null>(null);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const [candidate, setCandidate] = useState("");
  useEffect(() => {
    if (!both) return;
    let live = true;
    void Promise.all([listProposals(chains.bsc, both.bsc.timelock), listProposals(chains.wantos, both.wantos.timelock)]).then(
      ([b, w]) => live && setProps({ bsc: b, wantos: w }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [both, chains]);
  if (!both) return <p>读取链上状态中…</p>;
  const m = me(signer);
  const cand = isAddress(candidate.trim()) ? getAddress(candidate.trim()) : null;
  /** the open transferAdmin proposal (for the typed address, if any) on each chain */
  const openOf = (s: Side): Proposal | null =>
    (props[s] ?? []).find((p) => (p.state === "waiting" || p.state === "ready") && p.calls[0]?.fn === "transferAdmin" && (!cand || p.calls[0].text.toLowerCase().includes(cand.toLowerCase()))) ?? null;
  const gaps = crossChainGaps(both);
  if (!openOf("bsc") !== !openOf("wantos")) {
    const [x, y] = openOf("bsc") ? ["BSC", "WANTOS"] : ["WANTOS", "BSC"];
    gaps.push(`管理钱包交接（授权提议）：只在 ${x} 上发起，${y} 上还没有 —— 请在 ${y} 上补授权`);
  }
  const incoming = SIDES.filter((s) => both[s].pendingAdmin && m && isAddressEqual(both[s].pendingAdmin!.candidate, m));
  const needCand = (g: Gate): Gate => gateWith(g, [!!cand, "先填写新地址（建议先验证新持有人的地址证明）"]);

  return (
    <div>
      <Section title="合约地址（两条链相同，请核对）">
        <table>
          <tbody>
            {SIDES.map((s) => (
              <tr key={s}>
                <td>{SIDE_NAME[s]}（chainId {cfg[s].chainId}）</td>
                <td>
                  桥 <Addr a={both[s].bridge} />
                </td>
                <td>
                  时间锁 <Addr a={both[s].timelock} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          当前管理钱包 BSC <Addr a={both.bsc.admin} /> / WANTOS <Addr a={both.wantos.admin} />；当前白名单钱包 BSC <Addr a={both.bsc.wl} /> / WANTOS <Addr a={both.wantos.wl} />
        </p>
      </Section>

      {gaps.length > 0 && (
        <div className="warn" role="alert" data-testid="gaps">
          <strong>只完成了一条链：</strong>
          <ul>
            {gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      )}

      <fieldset aria-label="交接角色">
        {(["wl", "admin"] as const).map((r) => (
          <label key={r}>
            <input type="radio" name="handover-role" checked={role === r} onChange={() => setRole(r)} />
            {r === "wl" ? "白名单钱包" : "管理钱包"}
          </label>
        ))}
      </fieldset>
      {role === "admin" && (
        <p className="hint">
          管理钱包交接：现任管理员授权新地址 → 等 48 小时（期间可撤销）→ 新地址在 TP 签名接收 → 接收后立即生效。BSC、WANTOS 各做一遍。
        </p>
      )}
      {role === "admin" && incoming.length > 0 && (
        <div className="warn" role="alert" data-testid="new-admin-banner">
          你被指定为新的管理钱包（{incoming.map((s) => SIDE_NAME[s]).join("、")}）。每条链各签名一次，签名上链需要 gas，签名后立即生效；签名前请在钱包弹窗里核对合约地址。
        </div>
      )}

      <Section title="可选预检（新持有人）：证明自己的地址">
        <p className="hint">用新钱包连接本页，签一条说明文字（不花 gas、不授权任何东西，不上链），把生成的内容发给现任持有人核对地址没填错。不做也能发起。</p>
        <ActionButton label="签名生成地址证明" gate={m ? { ok: true } : { ok: false, reason: "未连接钱包" }} run={async () => setProof(await makeProof(signer!, role, cfg.bsc.bridge))} />
        {proof && <pre data-testid="proof">{JSON.stringify(proof)}</pre>}
      </Section>

      <Section title="现任持有人：核对并填写新地址">
        <textarea aria-label="粘贴地址证明" rows={3} value={pasted} onChange={(e) => setPasted(e.target.value)} />
        <button
          type="button"
          onClick={() =>
            void verifyProof(pasted, { role, bridge: cfg.bsc.bridge, client: chains.wantos.client }).then(
              (a) => (setVerified(a), setVerifyErr(null), setCandidate(a)),
              (e: Error) => (setVerified(null), setVerifyErr(e.message)),
            )
          }
        >
          验证证明
        </button>
        {verified && (
          <p className="ok" data-testid="verified">
            已验证：该证明由 <Addr a={verified} /> 签名
          </p>
        )}
        {verifyErr && <p className="err">{verifyErr}</p>}
        <p>
          新地址：
          <input aria-label="新地址" value={candidate} onChange={(e) => setCandidate(e.target.value)} placeholder="0x…" />
        </p>
        {verified && cand && cand !== verified && (
          <p className="warn" role="alert" data-testid="cand-mismatch">
            新地址 {cand} 与已验证的证明地址 {verified} 不同 —— 请确认没有填错
          </p>
        )}
        {candidate.trim() !== "" && !cand && <p className="err">新地址格式不对</p>}
      </Section>

      {SIDES.map((s) => {
        const st = both[s];
        const c = chains[s];
        const open = openOf(s);
        const view = adminHandoverView(st, open, cand);
        return (
          <Section key={s} title={`${SIDE_NAME[s]}：${role === "wl" ? "白名单钱包交接与恢复" : "管理钱包交接与恢复"}`}>
            {role === "wl" && (
              <div>
                <h3>白名单钱包交接（48h 等待，7 天内接收）</h3>
                {st.pendingWl ? (
                  <p>
                    待接收：<Addr a={st.pendingWl.candidate} />；可接收时间 {ts(st.pendingWl.availableAt)}（{countdown(st.pendingWl.availableAt, st.now)}）；过期 {ts(st.pendingWl.expiresAt)}
                  </p>
                ) : (
                  <p>无</p>
                )}
                <ActionButton label="发起交接" gate={needCand(gateWith(gate("wl", m, st), [!st.pendingWl, "已有待接收的交接"], [!st.anyRecovery, "恢复进行中"]))} confirmText={`把白名单钱包交接给 ${cand}？`} run={() => actions.beginWl(c, signer!, cand!)} />
                <ActionButton label="取消 / 否决交接" danger gate={gateWith(gate("adminOrWl", m, st), [!!st.pendingWl, "没有待接收的交接"])} run={() => actions.cancelWl(c, signer!)} />
                <ActionButton label="接收（新地址）" gate={gate("pendingWl", m, st)} run={() => actions.acceptWl(c, signer!)} />

                <h3>白名单钱包恢复（管理钱包发起，7 天；期间白名单禁止写入）</h3>
                {st.wlRecovery.active ? (
                  <p>
                    进行中：<Addr a={st.wlRecovery.candidate} />；可接收 {ts(st.wlRecovery.readyAt)}（{countdown(st.wlRecovery.readyAt, st.now)}）
                  </p>
                ) : (
                  <p>无{st.wlRecovery.cooldownUntil > st.now ? `（冷却到 ${ts(st.wlRecovery.cooldownUntil)}）` : ""}</p>
                )}
                <ActionButton label="启动白名单钱包恢复" danger gate={needCand(gateWith(gate("admin", m, st), [!st.anyRecovery, "已有恢复进行中"]))} confirmText={`启动恢复，新白名单钱包为 ${cand}？会触发电话告警。`} run={() => actions.startWlRecovery(c, signer!, cand!)} />
                <ActionButton label="取消恢复" danger gate={gateWith(gate("adminOrWl", m, st), [st.wlRecovery.active, "没有进行中的恢复"])} run={() => actions.cancelWlRecovery(c, signer!)} />
                <ActionButton label="接收恢复（新地址）" gate={gate("wlRecoveryCandidate", m, st)} run={() => actions.acceptWlRecovery(c, signer!)} />
              </div>
            )}
            {role === "admin" && (
              <div data-testid={`admin-handover-${s}`}>
                <table>
                  <tbody>
                    {view.rows.map((r) => (
                      <tr key={r.label}>
                        <td>{r.label}</td>
                        <td>{r.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {view.waitingAccept && <p className="hint">执行后、新地址接收前，合约没有一键撤销：要收回请重新提议，或由白名单钱包发起管理钱包恢复。</p>}
                <ActionButton
                  label="授权新地址"
                  gate={needCand(gateWith(gate("admin", m, st), [!open, "已有进行中的授权提议，请先撤销"], [!st.pendingAdmin, "已有待接收的新地址"], [!st.paused, "暂停期间不能执行更换"], [!st.anyRecovery, "恢复进行中"]))}
                  confirmText={`授权把管理钱包换成 ${cand}？48 小时后才能执行，期间可撤销。`}
                  run={() => actions.proposeTransferAdmin(c, signer!, st.timelock, cand!)}
                />
                <ActionButton
                  label="执行提议"
                  gate={gateWith(m ? { ok: true } : { ok: false, reason: "未连接钱包" }, [open?.state === "ready", open ? "等待期未满" : "没有进行中的授权提议"], [!st.anyRecovery, "恢复进行中，时间锁不执行任何提议"])}
                  run={() => executeProposal(c, signer!, st.timelock, open!)}
                />
                <ActionButton label="撤销授权" danger gate={gateWith(gate("adminOrWl", m, st), [view.revocable, "没有进行中的授权提议"])} confirmText="撤销这条授权提议？" run={() => cancelProposal(c, signer!, st.timelock, open!.id)} />
                <ActionButton label="接收管理钱包（新地址签名）" gate={gate("pendingAdmin", m, st)} run={() => actions.acceptAdmin(c, signer!, st.timelock)} />

                <h3>管理钱包恢复（白名单钱包发起，14 天）</h3>
                {st.adminRecovery.active ? (
                  <p>
                    进行中：<Addr a={st.adminRecovery.candidate} />；可接收 {ts(st.adminRecovery.readyAt)}（{countdown(st.adminRecovery.readyAt, st.now)}）
                  </p>
                ) : (
                  <p>无</p>
                )}
                <ActionButton label="启动管理钱包恢复" danger gate={needCand(gateWith(gate("wl", m, st), [!st.anyRecovery, "已有恢复进行中"]))} confirmText={`启动恢复，新管理钱包为 ${cand}？会触发电话告警。`} run={() => actions.startAdminRecovery(c, signer!, st.timelock, cand!)} />
                <ActionButton label="取消管理钱包恢复" danger gate={gateWith(gate("adminOrWl", m, st), [st.adminRecovery.active, "没有进行中的恢复"])} run={() => actions.cancelAdminRecovery(c, signer!, st.timelock)} />
                <ActionButton label="接收管理钱包恢复（新地址）" gate={gate("adminRecoveryCandidate", m, st)} run={() => actions.acceptAdmin(c, signer!, st.timelock)} />
              </div>
            )}
          </Section>
        );
      })}
    </div>
  );
}
