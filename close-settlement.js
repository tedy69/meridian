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

// A single atomic unit is not automatically worthless. Require a fresh value
// bound as well as finalized close/balance evidence, and keep the residual.
export async function reconcileCloseResidual(entry, balance, { readCloseProof, readPrice, readBalance, now = Date.now }) {
  const atomicResidual = (value) => value?.source === "rpc-finalized" && value.mint === entry.base_mint
    && value.raw_amount === "1" && Number.isInteger(value.decimals) && value.decimals >= 6 && value.decimals <= 18
    && value.amount === Number(`1e-${value.decimals}`);
  if (!atomicResidual(balance) || !entry.close_txs?.length) return null;
  const [proof, price] = await Promise.all([readCloseProof(entry), readPrice(entry.base_mint)]);
  if (!evaluateCloseProof(proof || {}).confirmed) return null;
  const updatedAt = Date.parse(price?.updatedAt);
  const valueUsd = balance.amount * price?.usdPrice;
  if (price?.mint !== entry.base_mint || !Number.isFinite(price?.usdPrice) || price.usdPrice <= 0
    || !Number.isFinite(updatedAt) || now() - updatedAt > 60_000 || updatedAt > now() + 5_000
    || !Number.isFinite(valueUsd) || valueUsd <= 0 || valueUsd > 0.000001) return null;
  const remaining = await readBalance(entry.base_mint);
  if (!atomicResidual(remaining) || remaining.decimals !== balance.decimals) return null;
  // Recheck age after the second RPC read; slow providers must fail closed too.
  if (now() - updatedAt > 60_000) return null;
  return { settled: true, swapped: false, settlement_status: "settled_dust_remaining", balance: remaining,
    residual: { ...remaining, value_usd: valueUsd, price_usd: price.usdPrice, price_updated_at: price.updatedAt,
      observed_at: new Date(now()).toISOString(), close_proof: proof } };
}

export function settlementRetryDelayMs(retryCount) {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.min(5, Math.max(0, Number(retryCount) - 1 || 0)));
}

export function isSettlementRetryDue(entry, now = Date.now()) {
  const next = Date.parse(entry?.next_attempt_at);
  return !Number.isFinite(next) || next <= now;
}
