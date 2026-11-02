import type { ReactNode } from "react";
import { useI18n } from "../context";

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** One side of the swap card: chain tag + small info on top, token + big amount below. */
export function AmountBox(props: {
  side: "from" | "to";
  tone: "wantos" | "bsc";
  chainName: string;
  /** Right side of the top row (balance + max, or the recipient). */
  top?: ReactNode;
  inputLabel: string;
  value: string;
  onChange?(v: string): void;
  readOnly?: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="box">
      <div className="r1">
        <span>
          {t(props.side === "from" ? "swap.from" : "swap.to")}
          <span className="chain">
            <span className={`dot ${props.tone}`} aria-hidden="true" />
            {props.chainName}
          </span>
        </span>
        <span className="r1-end">{props.top}</span>
      </div>
      <div className="r2">
        <span className="tok">USDT</span>
        <input
          className="amt"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.0"
          aria-label={props.inputLabel}
          value={props.value}
          readOnly={props.readOnly}
          disabled={props.disabled}
          onChange={(e) => props.onChange?.(e.target.value)}
        />
      </div>
    </div>
  );
}

/** The round control between the two boxes: switches the direction. */
export function FlipButton({ onClick, disabled }: { onClick(): void; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <button type="button" className="puck" aria-label={t("swap.flip")} disabled={disabled} onClick={onClick}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 4v16M4 16l4 4 4-4M16 20V4M12 8l4-4 4 4" />
      </svg>
    </button>
  );
}
