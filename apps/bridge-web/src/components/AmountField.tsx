import { useId } from "react";
import { useI18n } from "../context";
import { formatAmount } from "../lib/amount";
import { formatUnits } from "viem";

export function AmountField(props: {
  value: string;
  onChange(v: string): void;
  balance: bigint | null;
  max: bigint | null;
  decimals: number;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{t("amount.label")}</label>
      <div className="row">
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={props.value}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)}
        />
        {props.max !== null && props.max > 0n && (
          <button type="button" className="secondary" disabled={props.disabled} onClick={() => props.onChange(formatUnits(props.max!, props.decimals))}>
            {t("amount.max")}
          </button>
        )}
      </div>
      {props.balance !== null && <small>{t("amount.balance", { amount: formatAmount(props.balance, props.decimals) })}</small>}
    </div>
  );
}
