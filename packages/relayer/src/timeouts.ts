import type { AlertKind, AlertSink } from "./alerts";
import type { OrderRepo } from "./orders";
import { DEFAULT_TIMEOUTS, timeoutFor, type Timeouts } from "./stateMachine";

function kindFor(status: string, reason: string | null): AlertKind {
  if (status === "FAILED") return "ORDER_FAILED";
  if (status === "WAITING") {
    if (reason === "reserve") return "RESERVE_LOW";
    if (reason === "whitelist") return "WHITELIST_INCONSISTENT";
    return "WAIT_TIMEOUT";
  }
  return "STATE_TIMEOUT";
}

/**
 * §6.3 "每个状态有出口和超时告警": one alert per (order, status, reason) once the state has lasted
 * longer than its threshold. Re-armed automatically when the order changes state or reason.
 */
export async function checkTimeouts(o: { repo: OrderRepo; alerts: AlertSink; now: () => Date; timeouts?: Timeouts }): Promise<number> {
  const t = o.timeouts ?? DEFAULT_TIMEOUTS;
  const now = o.now().getTime();
  let fired = 0;
  for (const ord of await o.repo.listActive()) {
    const limit = timeoutFor(
      { status: ord.status, reason: ord.reason, reviewLevel: ord.reviewLevel, executableAt: ord.executableAt, stateSince: ord.stateSince },
      t,
    );
    if (limit === undefined) continue;
    const tag = `${ord.status}:${ord.reason ?? ""}`;
    if (ord.timeoutAlertedFor === tag) continue;
    const age = now - ord.stateSince.getTime();
    if (age < limit) continue;
    await o.alerts.emit({
      kind: kindFor(ord.status, ord.reason),
      key: `${ord.eventKey}:${tag}`,
      message: `${ord.direction} order ${ord.srcEventNonce} in ${ord.status}${ord.reason ? `(${ord.reason})` : ""} for ${Math.round(age / 60_000)} min`,
      data: { eventKey: ord.eventKey, status: ord.status, reason: ord.reason, amountWei: ord.amountWei.toString() },
    });
    await o.repo.markTimeoutAlerted(ord.eventKey, tag);
    fired++;
  }
  return fired;
}
