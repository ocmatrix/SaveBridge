import { useState } from "react";
import type { Address } from "viem";
import { SIDE_NAME, SIDES, type Side } from "../lib/config";
import { emergencyRemove, freeze, keyHolders, pause, PAUSER_ROLE, RELAYER_ROLE, revokeKey, unpause, vetoWlTransfer } from "../lib/emergency";
import { parseAddressList } from "../lib/normalize";
import { gate, gateWith } from "../lib/perm";
import { ActionButton, Addr, me, Section, useApp } from "../ui";

export function EmergencyPage() {
  const { chains, signer, both } = useApp();
  const [removeText, setRemoveText] = useState("");
  const [holders, setHolders] = useState<Partial<Record<Side, { role: "RELAYER" | "PAUSER"; account: Address }[]>>>({});
  const removeList = parseAddressList(removeText);
  if (!both) return <p>读取链上状态中…</p>;
  const m = me(signer);
  return (
    <div>
      <p className="hint">收紧类操作立即生效。两条链各操作一次。暂停和解除暂停两个钱包都可以；其余只限管理钱包。</p>
      {SIDES.map((s) => {
        const st = both[s];
        const c = chains[s];
        return (
          <Section key={s} title={`${SIDE_NAME[s]}（chainId ${st.chainId}）`}>
            <p>
              状态：{st.paused ? "⏸ 已暂停" : "运行中"}；白名单{st.frozen ? "已冻结" : "可写"}
              {st.anyRecovery && "；恢复进行中"}
            </p>
            <p>
              <ActionButton label="暂停" danger gate={gateWith(gate("adminOrWl", m, st), [!st.paused, "已经是暂停状态"])} run={() => pause(c, signer!)} />
              <ActionButton label="解除暂停" gate={gateWith(gate("adminOrWl", m, st), [st.paused, "没有暂停"])} run={() => unpause(c, signer!)} />
            </p>
            <p>
              <ActionButton label="冻结白名单写入" danger gate={gateWith(gate("admin", m, st), [!st.frozen, "已冻结"])} confirmText="冻结后只能移除；解冻要走 48h 时间锁。确定？" run={() => freeze(c, signer!)} />
              <ActionButton
                label="否决白名单钱包交接"
                danger
                gate={gateWith(gate("admin", m, st), [!!st.pendingWl, "没有待接收的白名单钱包交接"])}
                confirmText={st.pendingWl ? `否决交接给 ${st.pendingWl.candidate}？` : ""}
                run={() => vetoWlTransfer(c, signer!)}
              />
            </p>
            <h3>紧急移除地址（先冻结，再移除）</h3>
            <ActionButton
              label={`在 ${SIDE_NAME[s]} 上紧急移除 ${removeList.addresses.length} 个地址`}
              danger
              gate={gateWith(gate("admin", m, st), [removeList.addresses.length > 0 && removeList.errors.length === 0, "先在下面填写正确的地址"])}
              confirmText={st.frozen ? "确定移除？" : "将先冻结白名单写入（防止已签名的添加批次把地址加回来），再移除。确定？"}
              run={() => emergencyRemove(c, signer!, removeList.addresses as Address[])}
            />
            <h3>吊销钥匙（立即）</h3>
            <button type="button" onClick={() => void keyHolders(c).then((h) => setHolders((x) => ({ ...x, [s]: h })))}>
              读取现有付款 / 暂停钥匙
            </button>
            <ul>
              {(holders[s] ?? []).map((h) => (
                <li key={h.role + h.account}>
                  {h.role === "RELAYER" ? "付款钥匙" : "暂停钥匙"} <Addr a={h.account} />{" "}
                  <ActionButton
                    label="吊销"
                    danger
                    gate={gate("admin", m, st)}
                    confirmText={`吊销 ${h.account}？补发新钥匙要走 48h 时间锁。`}
                    run={() => revokeKey(c, signer!, h.role === "RELAYER" ? RELAYER_ROLE : PAUSER_ROLE, h.account)}
                  />
                </li>
              ))}
            </ul>
          </Section>
        );
      })}
      <Section title="要紧急移除的地址（两条链共用）">
        <textarea aria-label="紧急移除地址" rows={4} value={removeText} onChange={(e) => setRemoveText(e.target.value)} />
        {removeList.errors.length > 0 && <p className="err">有 {removeList.errors.length} 行地址无效</p>}
      </Section>
    </div>
  );
}
