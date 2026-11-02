import { useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { SIDE_NAME, SIDES } from "../lib/config";
import { actions, countdown, crossChainGaps, makeProof, verifyProof, type HandoverRole, type Proof } from "../lib/handover";
import { gate, gateWith, type Gate } from "../lib/perm";
import { ActionButton, Addr, me, Section, ts, useApp } from "../ui";

/**
 * /handover — open without Cloudflare Access (DESIGN §8.4); the new holder may open it in a wallet DApp browser.
 * Reads chain data only; every button is one tx on one chain (do it on both chains).
 */
export function HandoverPage() {
  const { chains, signer, both, cfg } = useApp();
  const [role, setRole] = useState<HandoverRole>("wl");
  const [proof, setProof] = useState<Proof | null>(null);
  const [pasted, setPasted] = useState("");
  const [verified, setVerified] = useState<Address | null>(null);
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const [candidate, setCandidate] = useState("");
  if (!both) return <p>读取链上状态中…</p>;
  const m = me(signer);
  const gaps = crossChainGaps(both);
  const cand = isAddress(candidate.trim()) ? getAddress(candidate.trim()) : null;
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

      <Section title="第 1 步（新持有人）：证明自己的地址">
        <p className="hint">用新钱包连接本页，签一条说明文字（不花 gas、不授权任何东西），把生成的内容发给负责人。</p>
        <select aria-label="交接角色" value={role} onChange={(e) => setRole(e.target.value as HandoverRole)}>
          <option value="wl">白名单钱包</option>
          <option value="admin">管理钱包</option>
        </select>
        <ActionButton label="签名生成地址证明" gate={m ? { ok: true } : { ok: false, reason: "未连接钱包" }} run={async () => setProof(await makeProof(signer!, role, cfg.bsc.bridge))} />
        {proof && <pre data-testid="proof">{JSON.stringify(proof)}</pre>}
      </Section>

      <Section title="第 2 步（现任持有人）：核对新地址">
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
        return (
          <Section key={s} title={`${SIDE_NAME[s]}：交接与恢复`}>
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

            <h3>管理钱包交接（时间锁 48h → 执行 → 新地址 7 天内接收）</h3>
            {st.pendingAdmin ? (
              <p>
                待接收：<Addr a={st.pendingAdmin.candidate} />；过期 {ts(st.pendingAdmin.expiresAt)}
              </p>
            ) : (
              <p>无（提议的执行与取消在「时间锁」页）</p>
            )}
            <ActionButton label="提议更换管理钱包" gate={needCand(gateWith(gate("admin", m, st), [!st.paused, "暂停期间不能执行更换"], [!st.anyRecovery, "恢复进行中"]))} confirmText={`提议把管理钱包换成 ${cand}？`} run={() => actions.proposeTransferAdmin(c, signer!, st.timelock, cand!)} />
            <ActionButton label="接收管理钱包（新地址）" gate={gate("pendingAdmin", m, st)} run={() => actions.acceptAdmin(c, signer!, st.timelock)} />

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
          </Section>
        );
      })}
    </div>
  );
}
