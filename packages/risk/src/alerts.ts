/**
 * Alerts raised by the risk package (DESIGN §9.3 level 2: 索引落后; §7 同源资助 "并告警").
 * Kept separate from the relayer's AlertSink union so PR-4 does not edit relayer files; the wiring
 * maps these onto the relayer sink (PR4-NOTES §4).
 */
export type RiskAlertKind = "INDEX_ERROR" | "INDEX_REORG" | "INDEX_BROKEN" | "COMMON_FUNDER";
export interface RiskAlert {
  kind: RiskAlertKind;
  key: string;
  message: string;
  data?: Record<string, unknown>;
}
export interface RiskAlertSink {
  emit(a: RiskAlert): Promise<void>;
}
export class MemoryRiskAlerts implements RiskAlertSink {
  readonly alerts: RiskAlert[] = [];
  async emit(a: RiskAlert): Promise<void> {
    this.alerts.push(a);
  }
}
