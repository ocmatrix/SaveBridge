import type { Hex } from "viem";
import { useDeps, useI18n } from "../context";
import type { OrderView } from "../lib/statusProvider";
import { formatAmount } from "../lib/amount";

/** The most recent orders, at the bottom of the card. */
export const RECENT_ORDERS = 3;

export function Orders({ orders, decimals }: { orders: OrderView[] | undefined; decimals: { wantos: number; bsc: number } }) {
  const { cfg } = useDeps();
  const { t } = useI18n();
  const txLink = (explorer: string, h: Hex | null) =>
    h ? (
      <a href={`${explorer}/tx/${h}`} target="_blank" rel="noopener noreferrer">
        {t("order.viewTx")}
      </a>
    ) : null;
  const shown = orders?.slice(0, RECENT_ORDERS);
  if (!shown?.length) return <section className="orders" aria-label={t("order.title")} hidden />;
  return (
    <section className="orders" aria-label={t("order.title")}>
      <ul>
        {shown.map((o) => {
          const w2b = o.direction === "W2B";
          const dec = w2b ? decimals.wantos : decimals.bsc;
          return (
            <li key={`${o.direction}-${o.id}`} className={`order st-${o.status}`}>
              <div className="order-title">{t(w2b ? "order.w2b" : "order.b2w", { id: o.id.toString() })}</div>
              <div className="order-amount">{formatAmount(o.amount, dec)} USDT</div>
              <div className="order-status">{t(`order.${o.status}`)}</div>
              <div className="order-links">
                {txLink(w2b ? cfg.wantos.explorerUrl : cfg.bsc.explorerUrl, o.srcTxHash)}
                {txLink(w2b ? cfg.bsc.explorerUrl : cfg.wantos.explorerUrl, o.dstTxHash)}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
