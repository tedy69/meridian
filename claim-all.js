function toPositiveFee(value) {
  const fee = Number(value);
  return Number.isFinite(fee) && fee > 0 ? fee : null;
}

function formatAmount(amount, solMode) {
  const prefix = solMode ? "◎" : "$";
  const normalized = Number(amount);
  if (!Number.isFinite(normalized)) return `${prefix}?`;
  return `${prefix}${normalized.toFixed(4).replace(/\.?(0+)$/, "")}`;
}

function resultError(result) {
  return result?.error || result?.reason || result?.message || "claim did not return a successful result";
}

export function prepareClaimAll(positions) {
  const allPositions = Array.isArray(positions) ? positions : [];
  const claimable = [];

  for (const position of allPositions) {
    const address = typeof position?.position === "string" ? position.position.trim() : "";
    const fee = toPositiveFee(position?.unclaimed_fees_usd);
    if (!address || fee == null) continue;
    claimable.push({ ...position, position: address, reportedFee: fee });
  }

  return {
    totalPositions: allPositions.length,
    claimable,
    totalReportedFees: claimable.reduce((total, position) => total + position.reportedFee, 0),
  };
}

export function formatClaimAllPreflight(plan, {
  solMode = false,
  autoSwapAfterClaim = false,
} = {}) {
  if (plan.totalPositions === 0) return "No open positions. No transaction sent.";
  if (plan.claimable.length === 0) {
    return "No positions have a positive reported unclaimed fee. No transaction sent.";
  }

  const lines = plan.claimable.map((position, index) => {
    const pair = position.pair || position.position;
    return `${index + 1}. ${pair} | reported fees: ${formatAmount(position.reportedFee, solMode)}`;
  });
  const autoSwapNote = autoSwapAfterClaim
    ? "After each successful claim, automatic base-token → SOL settlement will be attempted."
    : "Automatic base-token → SOL settlement after claim is disabled.";

  return [
    "💰 Claim-all preflight",
    "",
    ...lines,
    "",
    `Eligible: ${plan.claimable.length}/${plan.totalPositions} | total reported fees: ${formatAmount(plan.totalReportedFees, solMode)}`,
    "",
    "No transaction sent.",
    "Use /claimall confirm to claim every eligible position sequentially.",
    "Execution stops after the first unsuccessful claim.",
    autoSwapNote,
  ].join("\n");
}

export async function executeClaimAll(positions, executeClaim) {
  if (typeof executeClaim !== "function") throw new TypeError("executeClaim must be a function");

  const claimable = prepareClaimAll(positions).claimable;
  const results = [];
  let stoppedAfterFailure = false;

  for (const position of claimable) {
    let result;
    try {
      result = await executeClaim({ position_address: position.position });
    } catch (error) {
      result = { error: error.message };
    }

    const dryRun = result?.dry_run === true;
    const success = dryRun || result?.success === true;
    const entry = {
      position: position.position,
      pair: position.pair || position.position,
      reportedFee: position.reportedFee,
      success,
      dryRun,
      result,
    };
    if (!success) entry.error = resultError(result);
    results.push(entry);

    if (!success) {
      stoppedAfterFailure = true;
      break;
    }
  }

  return {
    total: claimable.length,
    attempted: results.length,
    succeeded: results.filter((entry) => entry.success).length,
    failed: results.filter((entry) => !entry.success).length,
    stoppedAfterFailure,
    results,
  };
}

export function formatClaimAllOutcome(outcome, {
  solMode = false,
  autoSwapAfterClaim = false,
} = {}) {
  if (outcome.total === 0) return "No positions with a positive reported unclaimed fee. No transaction sent.";

  const lines = outcome.results.map((entry) => {
    if (entry.dryRun) return `${entry.pair}: would claim ${formatAmount(entry.reportedFee, solMode)} (dry run)`;
    if (entry.success) return `${entry.pair}: claimed ${formatAmount(entry.reportedFee, solMode)}`;
    return `${entry.pair}: failed (${entry.error})`;
  });
  const remaining = outcome.total - outcome.attempted;
  if (outcome.stoppedAfterFailure && remaining > 0) {
    lines.push(`Stopped after failure; ${remaining} position(s) not attempted.`);
  }
  if (autoSwapAfterClaim && outcome.succeeded > 0) {
    lines.push("Successful claims trigger the configured automatic base-token → SOL settlement attempt.");
  }

  return [
    `💰 Claim-all ${outcome.failed ? "stopped" : "finished"}: ${outcome.succeeded}/${outcome.total} successful`,
    "",
    ...lines,
  ].join("\n");
}
