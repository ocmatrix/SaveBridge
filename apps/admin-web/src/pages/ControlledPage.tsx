import { useState } from "react";
import { isAddress } from "viem";
import type { ControlledItem } from "../lib/api";
import { describeError } from "../lib/chain";
import { gate, gateWith } from "../lib/perm";
import { APPENDIX_A } from "../lib/risk";
import { ActionButton, Addr, me, Section, useApp } from "../ui";

/** Controlled source set (DESIGN §7): the relayer stores it, writes audit_log and pushes every change to the owner. */
export function ControlledPage() {
  const { signer, both, api } = useApp();
  const [items, setItems] = useState<ControlledItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [addr, setAddr] = useState("");
  const [label, setLabel] = useState("");
  if (!both) return <p>读取链上状态中…</p>;
  const g = gateWith(gate("admin", me(signer), both.wantos), [!!api, "未配置管理接口（VITE_ADMIN_API）"]);
  const load = async () => {
    try {
      setErr(null);
      setItems(await api!.controlled());
    } catch (e) {
      setErr(describeError(e));
    }
  };
  const change = async (action: "add" | "remove", a: string, l?: string) => {
    await api!.changeControlled({ action, addr: a.toLowerCase(), label: l });
    await load();
  };
  return (
    <div>
      <Section title="受控来源集合">
        <p className="hint">每次增删由付款程序写审计日志并推送给负责人（并入每日变更报告）。</p>
        <button type="button" disabled={!api} onClick={() => void load()}>
          读取
        </button>
        {err && <p className="err">{err}</p>}
        {items && (
          <ul>
            {items.map((i) => (
              <li key={i.addr}>
                <Addr a={i.addr} /> {i.label}（{i.addedAt}） <ActionButton label="删除" danger gate={g} confirmText={`从受控集合删除 ${i.addr}？`} run={() => change("remove", i.addr)} />
              </li>
            ))}
          </ul>
        )}
        <p>
          <input aria-label="受控地址" placeholder="0x…" value={addr} onChange={(e) => setAddr(e.target.value)} />
          <input aria-label="说明" placeholder="说明" value={label} onChange={(e) => setLabel(e.target.value)} />
          <ActionButton label="添加" gate={gateWith(g, [isAddress(addr.trim()), "地址无效"])} run={() => change("add", addr.trim(), label.trim())} />
        </p>
        <details>
          <summary>内置附录 A（{APPENDIX_A.length} 个，接口不可用时作为白名单页的 🔴 提示）</summary>
          <ul>
            {APPENDIX_A.map((a) => (
              <li key={a}>
                <Addr a={a} />
              </li>
            ))}
          </ul>
        </details>
      </Section>
    </div>
  );
}
