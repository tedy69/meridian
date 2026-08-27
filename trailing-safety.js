function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Keep trailing take-profit from turning a positive exit signal into an
 * intentional loss. This is a local decision guard; it cannot guarantee the
 * eventual on-chain fill after a transaction has been submitted.
 */
export function evaluateTrailingProfitFloor({ currentPnlPct, minimumPnlPct }) {
  const current = finiteNumber(currentPnlPct);
  const configuredMinimum = finiteNumber(minimumPnlPct);
  const minimum = Math.max(0, configuredMinimum ?? 0);

  if (current == null) {
    return {
      allowed: false,
      reason: "fresh_pnl_unavailable",
      currentPnlPct: null,
      minimumPnlPct: minimum,
    };
  }

  if (current < minimum) {
    return {
      allowed: false,
      reason: "fresh_pnl_below_profit_floor",
      currentPnlPct: current,
      minimumPnlPct: minimum,
    };
  }

  return {
    allowed: true,
    reason: null,
    currentPnlPct: current,
    minimumPnlPct: minimum,
  };
}

/**
 * Fresh-read guard for an already-confirmed trailing signal. It fails closed
 * when the position or a trustworthy PnL observation is unavailable.
 */
export async function revalidateTrailingProfitFloor({
  positionAddress,
  minimumPnlPct,
  fetchPositions,
}) {
  try {
    const snapshot = await fetchPositions();
    const position = snapshot?.positions?.find((entry) => entry?.position === positionAddress);
    if (!position) {
      return {
        allowed: false,
        reason: "fresh_position_unavailable",
        currentPnlPct: null,
        minimumPnlPct: Math.max(0, finiteNumber(minimumPnlPct) ?? 0),
      };
    }
    if (position.pnl_pct_suspicious) {
      return {
        allowed: false,
        reason: "fresh_pnl_suspicious",
        currentPnlPct: finiteNumber(position.pnl_pct),
        minimumPnlPct: Math.max(0, finiteNumber(minimumPnlPct) ?? 0),
      };
    }
    return evaluateTrailingProfitFloor({
      currentPnlPct: position.pnl_pct,
      minimumPnlPct,
    });
  } catch {
    return {
      allowed: false,
      reason: "fresh_pnl_unavailable",
      currentPnlPct: null,
      minimumPnlPct: Math.max(0, finiteNumber(minimumPnlPct) ?? 0),
    };
  }
}

export function isLosingTrailingExit({ closeReason, pnlPct }) {
  const reason = String(closeReason || "").trim().toLowerCase();
  const pnl = finiteNumber(pnlPct);
  return reason.startsWith("trailing tp") && pnl != null && pnl < 0;
}

export function normalizeSlippageBps(value) {
  const bps = finiteNumber(value);
  if (bps == null || !Number.isInteger(bps) || bps < 0 || bps > 10_000) return null;
  return bps;
}
