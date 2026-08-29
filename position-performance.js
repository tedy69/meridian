const EPSILON = 1e-9;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function status(value, positive, negative, neutral) {
  if (value > EPSILON) return positive;
  if (value < -EPSILON) return negative;
  return neutral;
}

/**
 * Calculate the economics of one still-open LP position in a single currency.
 *
 * Fees are deliberately separate from the mark-to-market capital component:
 * a positive fee balance must never be mistaken for a profitable position when
 * the total claimable value remains below the capital deposited.
 */
export function calculateOpenPositionPerformance({
  depositsUsd,
  balancesUsd,
  withdrawalsUsd = 0,
  claimedFeesUsd = 0,
  unclaimedFeesUsd = 0,
} = {}) {
  const deposits = finiteNumber(depositsUsd);
  const balances = finiteNumber(balancesUsd);
  const withdrawals = finiteNumber(withdrawalsUsd);
  const claimedFees = finiteNumber(claimedFeesUsd);
  const unclaimedFees = finiteNumber(unclaimedFeesUsd);

  if (
    deposits == null || deposits <= 0 || balances == null || withdrawals == null
    || claimedFees == null || unclaimedFees == null
  ) {
    return {
      available: false,
      capitalPnlUsd: null,
      feeContributionUsd: null,
      netPnlUsd: null,
      netPnlPct: null,
      netPnlStatus: "UNKNOWN",
      capitalStatus: "UNKNOWN",
    };
  }

  const capitalPnlUsd = balances + withdrawals - deposits;
  const feeContributionUsd = claimedFees + unclaimedFees;
  const netPnlUsd = capitalPnlUsd + feeContributionUsd;

  return {
    available: true,
    capitalPnlUsd,
    feeContributionUsd,
    netPnlUsd,
    netPnlPct: (netPnlUsd / deposits) * 100,
    netPnlStatus: status(netPnlUsd, "FLOATING_NET_PROFIT", "FLOATING_NET_LOSS", "BREAK_EVEN"),
    capitalStatus: status(capitalPnlUsd, "CAPITAL_GAIN", "CAPITAL_LOSS", "CAPITAL_BREAK_EVEN"),
  };
}
