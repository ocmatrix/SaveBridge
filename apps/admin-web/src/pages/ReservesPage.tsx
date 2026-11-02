import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import type { Report } from "../lib/api";
import { describeError } from "../lib/chain";
import { SIDE_NAME, SIDES, type Side } from "../lib/config";
import { readReserve, type Reserve } from "../lib/reserves";
import { Section, useApp } from "../ui";

export function ReservesPage() {
  const { chains, api } = useApp();
  const [res, setRes] = useState<Partial<Record<Side, Reserve>>>({});
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [repErr, setRepErr] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([readReserve(chains.bsc), readReserve(chains.wantos)]).then(
      ([b, w]) => setRes({ bsc: b, wantos: w }),
      (e) => setErr(describeError(e)),
    );
  }, [chains]);
  return (
    <div>
      {err && <p className="err">{err}</p>}
      {SIDES.map((s) => {
        const r = res[s];
        if (!r) return <p key={s}>{SIDE_NAME[s]} 读取中…</p>;
        const f = (v: bigint) => formatUnits(v, r.decimals);
        const days = r.cap > 0n ? Number((r.balance * 100n) / r.cap) / 100 : 0;
        return (
          <Section key={s} title={`${SIDE_NAME[s]} 储备`}>
            <p data-testid={`reserve-${s}`}>
              桥合约余额 {f(r.balance)}（约 {days} 天用量）；今日已用 {f(r.usedToday)} / {f(r.cap)}
            </p>
            {r.supplyCeiling !== undefined && (
              <p>
                WANTOS-USDT 总量 {f(r.totalSupply!)} / 上限 {f(r.supplyCeiling)}
              </p>
            )}
          </Section>
        );
      })}
      <Section title="对账、告警、每日白名单变更报告">
        <button type="button" disabled={!api} onClick={() => void api!.report().then(setReport, (e) => setRepErr(describeError(e)))}>
          读取（需要签名登录）
        </button>
        {!api && <p className="hint">未配置管理接口（VITE_ADMIN_API）</p>}
        {repErr && <p className="err">{repErr}</p>}
        {report &&
          (["reconciliation", "alerts", "whitelistDaily"] as const).map((k) => (
            <details key={k} open>
              <summary>{{ reconciliation: "对账结果", alerts: "告警记录", whitelistDaily: "每日白名单变更" }[k]}</summary>
              <ul>
                {report[k].map((l, i) => (
                  <li key={i}>
                    {l.at} {l.text}
                  </li>
                ))}
              </ul>
            </details>
          ))}
      </Section>
    </div>
  );
}
