/**
 * Pure settlement decisions used by the transaction layer.
 *
 * An aggregated portfolio/indexer response is deliberately not an input here.
 * A position can be declared closed only after its transaction is finalized and
 * the position account is absent at finalized commitment.
 */
export function evaluateCloseProof({ transactionFinalized, positionAccountPresent }) {
  if (transactionFinalized !== true) {
    return {
      confirmed: false,
      close_status: "pending_verification",
      reason: "close_transaction_not_finalized",
    };
  }
  if (positionAccountPresent !== false) {
    return {
      confirmed: false,
      close_status: "pending_verification",
      reason: positionAccountPresent === true
        ? "position_account_still_exists"
        : "position_account_unverified",
    };
  }
  return {
    confirmed: true,
    close_status: "confirmed_on_chain",
    reason: "position_account_absent_at_finalized",
  };
}

/**
 * Decide whether a residual base-token balance must be sold. Only a successful
 * direct RPC query at finalized commitment can resolve an autoswap as settled.
 */
export function evaluateAutoSwapBalance({ balanceReadSucceeded, amount }) {
  if (balanceReadSucceeded !== true || !Number.isFinite(amount) || amount < 0) {
    return {
      action: "retry",
      settlement_status: "pending_auto_swap",
      reason: "balance_unavailable",
    };
  }
  if (amount === 0) {
    return {
      action: "settled",
      settlement_status: "settled_no_base_token",
      reason: "zero_balance_at_finalized",
    };
  }
  return {
    action: "swap",
    settlement_status: "pending_auto_swap",
    reason: "base_token_balance_present",
  };
}
