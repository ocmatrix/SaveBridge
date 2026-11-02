import { useState } from "react";
import { formatUnits } from "viem";
import type { ReviewOrder } from "../lib/api";
import { chainNow, describeError } from "../lib/chain";
import { gate, gateWith } from "../lib/perm";
import { parseIds, payoutSide, requestRefundBatch, signDecision, voidSourceBatch } from "../lib/review";
import { ActionButton, Addr, me, Section, useApp } from "../ui";

/** Relayer reason codes (PR-3) → text. Only order facts and the relayer's own checks; no source-of-funds rules (v0.9.5). */
const REASON: Record<string, string> = {
  onchain_mismatch: "来源检查冻结：源链订单与本单不一致（onchain_mismatch）",
  amount_limit: "金额超过单笔上限（amount_limit）",
  whitelist_removed: "地址已被移出白名单（whitelist_removed）",
};
export const reasonText = (r: string | null) => (r === null ? "—" : (REASON[r] ?? r));

export function ReviewPage() {
  const { chains, signer, both, api } = useApp();
  const [orders, setOrders] = useState<ReviewOrder[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [voidText, setVoidText] = useState("");
  const [refundText, setRefundText] = useState("");
  if (!both) return <p>读取链上状态中…</p>;
  const m = me(signer);
  const ids = (t: string) => {
    try {
      return { ok: true as const, ids: parseIds(t) };
    } catch (e) {
      return { ok: false as const, msg: (e as Error).message };
    }
  };
  const v = ids(voidText);
  const r = ids(refundText);
  const load = async () => {
    try {
      setErr(null);
      if (!api) throw new Error("未配置管理接口（VITE_ADMIN_API）");
      setOrders(await api.reviewOrders());
    } catch (e) {
      setErr(describeError(e));
    }
  };
  const decide = async (o: ReviewOrder, decision: "approve" | "reject") => {
    const side = payoutSide(o.direction);
    const d = await signDecision(chains, signer!, { direction: o.direction, eventKey: o.eventKey, decision, nowSec: await chainNow(chains[side]) });
    await api!.decide({ eventKey: d.eventKey, decision: d.decision, expires: d.expires, signature: d.signature });
    await load();
  };
  return (
    <div>
      <Section title="待审核订单（REVIEW）">
        <p className="hint">通过 / 拒绝由管理钱包对固定格式的文字签名，付款程序自己验签（Worker 只转发）。每单一次签名，1 小时内有效、只能用一次。</p>
        <button type="button" onClick={() => void load()}>
          读取（需要管理钱包签名登录）
        </button>
        {err && <p className="err">{err}</p>}
        {orders && orders.length === 0 && <p>没有待审核订单</p>}
        {orders?.map((o) => {
          const st = both[payoutSide(o.direction)];
          const g = gate("admin", m, st);
          return (
            <div key={o.eventKey} className="proposal">
              <p>
                {o.direction} #{o.srcEventNonce}　{o.level === "freeze" ? "冻结级" : "审核级"}　原因 <span data-testid="reason">{reasonText(o.reason)}</span>　金额 {formatUnits(BigInt(o.amount), 18)}
              </p>
              <p>
                用户 <Addr a={o.user} /> → <Addr a={o.to} />　eventKey <code>{o.eventKey}</code>
              </p>
              <ActionButton label="通过" gate={g} run={() => decide(o, "approve")} />
              <ActionButton label="拒绝（走退款）" danger gate={g} confirmText="拒绝后订单进入退款流程。确定？" run={() => decide(o, "reject")} />
            </div>
          );
        })}
      </Section>
      <Section title="批量作废（BSC，voidSourceBatch）">
        <p className="hint">输入 WANTOS 订单号（orderId），如 “12, 15-18”。作废后该订单在 BSC 上永久不能放款。</p>
        <input aria-label="作废订单号" value={voidText} onChange={(e) => setVoidText(e.target.value)} />
        {!v.ok && voidText && <span className="err">{v.msg}</span>}
        <ActionButton
          label={`作废 ${v.ok ? v.ids.length : 0} 个`}
          danger
          gate={gateWith(gate("adminOrWl", m, both.bsc), [v.ok && v.ids.length > 0, "先填写订单号"])}
          confirmText="作废不可撤销。确定？"
          run={() => voidSourceBatch(chains.bsc, signer!, v.ok ? v.ids : [])}
        />
      </Section>
      <Section title="批量退款申请（WANTOS，requestRefundBatch）">
        <p className="hint">先在 BSC 作废并等最终确认。申请后 24 小时任何人可执行，期间两个钱包都能取消。</p>
        <input aria-label="退款订单号" value={refundText} onChange={(e) => setRefundText(e.target.value)} />
        {!r.ok && refundText && <span className="err">{r.msg}</span>}
        <ActionButton
          label={`申请退款 ${r.ok ? r.ids.length : 0} 个`}
          danger
          gate={gateWith(gate("admin", m, both.wantos), [r.ok && r.ids.length > 0, "先填写订单号"])}
          confirmText="申请退款？"
          run={() => requestRefundBatch(chains.wantos, signer!, r.ok ? r.ids : [])}
        />
      </Section>
    </div>
  );
}
