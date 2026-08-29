function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function decision({ allowed, reason, currentPnlPct, triggerPnlPct, maximumPnlPct }) {
  return {
    allowed,
    reason,
    currentPnlPct,
    triggerPnlPct,
    maximumPnlPct,
    atOrBeyondMaximum: currentPnlPct != null && maximumPnlPct != null && currentPnlPct <= maximumPnlPct,
  };
}

/**
 * Validates a fresh PnL reading immediately before a stop-loss close. The
 * trigger is intentionally above the intended maximum loss to leave room for
 * confirmation and transaction inclusion; it cannot guarantee a final fill
 * during a fast on-chain price move.
 */
export function evaluateStopLossExecution({ currentPnlPct, triggerPnlPct, maximumPnlPct }) {
  const current = finiteNumber(currentPnlPct);
  const trigger = finiteNumber(triggerPnlPct);
  const maximum = finiteNumber(maximumPnlPct);

  if (trigger == null || maximum == null || trigger >= 0 || maximum >= trigger) {
    return decision({
      allowed: false,
      reason: "invalid_stop_loss_policy",
      currentPnlPct: current,
      triggerPnlPct: trigger,
      maximumPnlPct: maximum,
    });
  }

  if (current == null) {
    return decision({
      allowed: false,
      reason: "fresh_pnl_unavailable",
      currentPnlPct: null,
      triggerPnlPct: trigger,
      maximumPnlPct: maximum,
    });
  }

  if (current > trigger) {
    return decision({
      allowed: false,
      reason: "fresh_pnl_recovered_above_trigger",
      currentPnlPct: current,
      triggerPnlPct: trigger,
      maximumPnlPct: maximum,
    });
  }

  return decision({
    allowed: true,
    reason: current <= maximum ? "fresh_pnl_at_or_beyond_maximum" : null,
    currentPnlPct: current,
    triggerPnlPct: trigger,
    maximumPnlPct: maximum,
  });
}

/**
 * A stop-loss must be checked against a freshly fetched, trustworthy PnL
 * snapshot before it signs a close. This intentionally fails closed on an
 * unavailable/suspicious snapshot; the rapid poller retries on its next tick.
 */
export async function revalidateStopLossExecution({
  positionAddress,
  triggerPnlPct,
  maximumPnlPct,
  fetchPositions,
}) {
  const trigger = finiteNumber(triggerPnlPct);
  const maximum = finiteNumber(maximumPnlPct);
  try {
    const snapshot = await fetchPositions();
    const position = snapshot?.positions?.find((entry) => entry?.position === positionAddress);
    if (!position) {
      return decision({
        allowed: false,
        reason: "fresh_position_unavailable",
        currentPnlPct: null,
        triggerPnlPct: trigger,
        maximumPnlPct: maximum,
      });
    }
    if (position.pnl_pct_suspicious) {
      return decision({
        allowed: false,
        reason: "fresh_pnl_suspicious",
        currentPnlPct: finiteNumber(position.pnl_pct),
        triggerPnlPct: trigger,
        maximumPnlPct: maximum,
      });
    }
    return evaluateStopLossExecution({
      currentPnlPct: position.pnl_pct,
      triggerPnlPct: trigger,
      maximumPnlPct: maximum,
    });
  } catch {
    return decision({
      allowed: false,
      reason: "fresh_pnl_unavailable",
      currentPnlPct: null,
      triggerPnlPct: trigger,
      maximumPnlPct: maximum,
    });
  }
}

function positiveInteger(value, fallback) {
  const number = finiteNumber(value);
  if (number == null || number < 1) return fallback;
  return Math.max(1, Math.round(number));
}

/**
 * Stop-loss exits use an authoritative single PnL tick plus fresh RPC
 * revalidation. Other exits retain their normal anti-noise confirmation.
 */
export function selectExitConfirmationTicks({ exitAction, defaultConfirmTicks, stopLossConfirmTicks }) {
  const defaultTicks = positiveInteger(defaultConfirmTicks, 2);
  if (exitAction !== "STOP_LOSS") return defaultTicks;
  return positiveInteger(stopLossConfirmTicks, 1);
}

/**
 * The automatic stop-loss path is latency-sensitive. A manual close or a
 * trailing-take-profit close keeps the normal fee-claim behavior instead.
 */
export function isUrgentStopLossClose(closeReason) {
  return /^stop loss\b/i.test(String(closeReason || "").trim());
}

/**
 * A stop-loss that really settles below entry is a market-risk signal, not an
 * invitation to immediately re-enter the same pool or token.
 */
export function isLosingStopLossExit({ closeReason, pnlPct }) {
  const settledPnlPct = finiteNumber(pnlPct);
  return isUrgentStopLossClose(closeReason) && settledPnlPct != null && settledPnlPct < 0;
}
