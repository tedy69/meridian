function numberOrNull(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function parsePerformanceLedger(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cannot read performance risk ledger: invalid JSON (${error.message})`);
  }
  if (!data || !Array.isArray(data.performance)) {
    throw new Error("Cannot read performance risk ledger: performance must be an array.");
  }
  return data.performance.map((record) => ({
    ...record,
    ...(record?.signal_snapshot && typeof record.signal_snapshot === "object"
      ? { signal_snapshot: { ...record.signal_snapshot } }
      : {}),
  }));
}

function positiveInteger(value, fallback) {
  const numeric = numberOrNull(value);
  return numeric != null && numeric >= 1 ? Math.max(1, Math.round(numeric)) : fallback;
}

function positiveNumber(value, fallback) {
  const numeric = numberOrNull(value);
  return numeric != null && numeric > 0 ? numeric : fallback;
}

function recordTimestamp(record) {
  const value = record?.recorded_at ?? record?.closed_at ?? record?.timestamp;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizedPerformance(performance) {
  if (!Array.isArray(performance)) return [];
  return performance
    .map((record) => ({
      ...record,
      pnl_pct: numberOrNull(record?.pnl_pct),
      pnl_usd: numberOrNull(record?.pnl_usd),
      _closedAtMs: recordTimestamp(record),
    }))
    .filter((record) => record.pnl_pct != null && record._closedAtMs != null)
    .sort((a, b) => a._closedAtMs - b._closedAtMs);
}

function normalizedCircuitPolicy(policy = {}) {
  return {
    enabled: policy.enabled ?? policy.lossCircuitBreakerEnabled ?? true,
    windowPositions: positiveInteger(policy.windowPositions ?? policy.lossCircuitWindowPositions, 5),
    maxConsecutiveLosses: positiveInteger(policy.maxConsecutiveLosses, 3),
    maxRollingLossPct: positiveNumber(policy.maxRollingLossPct, 12),
    maxSingleLossPct: positiveNumber(policy.maxSingleLossPct, 12),
    cooldownHours: positiveNumber(policy.cooldownHours ?? policy.lossCircuitCooldownHours, 12),
  };
}

function tailMetrics(records, windowPositions) {
  const recent = records.slice(-windowPositions);
  const rollingPnlPct = recent.reduce((sum, record) => sum + record.pnl_pct, 0);
  let consecutiveLosses = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].pnl_pct >= 0) break;
    consecutiveLosses += 1;
  }
  return {
    sampleSize: recent.length,
    rollingPnlPct: Math.round(rollingPnlPct * 100) / 100,
    consecutiveLosses,
    latestPnlPct: records.at(-1)?.pnl_pct ?? null,
  };
}

/**
 * Deterministic realized-loss circuit breaker. The LLM cannot override it.
 */
export function evaluateLossCircuitBreaker({ performance = [], policy = {}, now = new Date() } = {}) {
  const normalizedPolicy = normalizedCircuitPolicy(policy);
  const records = normalizedPerformance(performance);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const metrics = tailMetrics(records, normalizedPolicy.windowPositions);

  if (!normalizedPolicy.enabled) {
    return { pass: true, trigger: null, reason: "Loss circuit breaker is disabled.", blockedUntil: null, metrics };
  }
  if (records.length === 0) {
    return { pass: true, trigger: null, reason: "No realized performance history yet.", blockedUntil: null, metrics };
  }
  if (!Number.isFinite(nowMs)) {
    return { pass: false, trigger: "invalid_clock", reason: "Cannot verify loss cooldown because the current time is invalid.", blockedUntil: null, metrics };
  }

  let latestTrigger = null;
  for (let index = 0; index < records.length; index += 1) {
    const prefix = records.slice(0, index + 1);
    const current = records[index];
    const currentMetrics = tailMetrics(prefix, normalizedPolicy.windowPositions);
    let trigger = null;
    let reason = null;

    if (current.pnl_pct <= -normalizedPolicy.maxSingleLossPct) {
      trigger = "single_loss";
      reason = `Realized loss ${current.pnl_pct.toFixed(2)}% exceeded the ${normalizedPolicy.maxSingleLossPct.toFixed(2)}% single-position limit.`;
    } else if (
      currentMetrics.sampleSize >= 2 &&
      currentMetrics.rollingPnlPct <= -normalizedPolicy.maxRollingLossPct
    ) {
      trigger = "rolling_loss";
      reason = `Recent ${currentMetrics.sampleSize}-position PnL ${currentMetrics.rollingPnlPct.toFixed(2)}% exceeded the ${normalizedPolicy.maxRollingLossPct.toFixed(2)}% rolling-loss limit.`;
    } else if (currentMetrics.consecutiveLosses >= normalizedPolicy.maxConsecutiveLosses) {
      trigger = "loss_streak";
      reason = `${currentMetrics.consecutiveLosses} consecutive realized losses reached the configured limit.`;
    }

    if (trigger) {
      latestTrigger = {
        trigger,
        reason,
        atMs: current._closedAtMs,
        metrics: currentMetrics,
      };
    }
  }

  if (!latestTrigger) {
    return { pass: true, trigger: null, reason: "Realized loss limits are clear.", blockedUntil: null, metrics };
  }

  const blockedUntilMs = latestTrigger.atMs + normalizedPolicy.cooldownHours * 3_600_000;
  if (nowMs >= blockedUntilMs) {
    return { pass: true, trigger: null, reason: "The latest realized-loss cooldown has expired.", blockedUntil: null, metrics };
  }

  const blockedUntil = new Date(blockedUntilMs).toISOString();
  return {
    pass: false,
    trigger: latestTrigger.trigger,
    reason: `${latestTrigger.reason} New deployments are paused until ${blockedUntil}.`,
    blockedUntil,
    metrics: latestTrigger.metrics,
  };
}

function createdAtMs(detail) {
  const raw = numberOrNull(detail?.token_x?.created_at ?? detail?.base_token_created_at);
  if (raw == null) return null;
  return raw < 1_000_000_000_000 ? raw * 1_000 : raw;
}

function reject(reason, metrics = null) {
  return { pass: false, reason, ...(metrics ? { metrics } : {}) };
}

/**
 * Re-check all pool fundamentals from one fresh Pool Discovery snapshot just
 * before deploy. This closes the gap between discovery and transaction time.
 */
export function evaluateFreshPoolRisk({
  detail,
  volatility = null,
  volatilityTimeframe = "30m",
  screening = {},
  now = new Date(),
} = {}) {
  if (!detail || typeof detail !== "object") return reject("Fresh pool details are unavailable.");

  const tvl = numberOrNull(detail.tvl ?? detail.active_tvl ?? detail.liquidity);
  const volume = numberOrNull(detail.volume ?? detail.volume_window);
  const feeActiveTvlRatio = numberOrNull(detail.fee_active_tvl_ratio);
  const observedVolatility = numberOrNull(volatility ?? detail.volatility);
  const binStep = numberOrNull(detail?.dlmm_params?.bin_step ?? detail?.pool_config?.bin_step);
  const holders = numberOrNull(detail.base_token_holders ?? detail?.token_x?.holders);
  const marketCap = numberOrNull(detail?.token_x?.market_cap ?? detail.base_token_market_cap);
  const baseOrganic = numberOrNull(detail?.token_x?.organic_score ?? detail.base_token_organic_score);
  const quoteOrganic = numberOrNull(detail?.token_y?.organic_score ?? detail.quote_token_organic_score);
  const metrics = {
    tvl,
    volume,
    feeActiveTvlRatio,
    volatility: observedVolatility,
    binStep,
    holders,
    marketCap,
    baseOrganic,
    quoteOrganic,
  };

  if (detail.pool_type && detail.pool_type !== "dlmm") {
    return reject(`Pool type ${detail.pool_type} is not DLMM.`, metrics);
  }
  if (detail.base_token_has_critical_warnings === true || detail.quote_token_has_critical_warnings === true) {
    return reject("Pool token has a critical warning in the fresh snapshot.", metrics);
  }
  if (detail.base_token_has_high_single_ownership === true) {
    return reject("Base token has high single-wallet ownership in the fresh snapshot.", metrics);
  }
  if (screening.excludeHighSupplyConcentration !== false && detail.base_token_has_high_supply_concentration === true) {
    return reject("Base token has high supply concentration in the fresh snapshot.", metrics);
  }

  const minimumTvl = numberOrNull(screening.minTvl);
  const maximumTvl = numberOrNull(screening.maxTvl);
  if (minimumTvl != null && (tvl == null || tvl < minimumTvl)) {
    return reject(`Pool TVL $${tvl ?? "unknown"} is below configured minimum $${minimumTvl}.`, metrics);
  }
  if (maximumTvl != null && tvl != null && tvl > maximumTvl) {
    return reject(`Pool TVL $${tvl} is above configured maximum $${maximumTvl}.`, metrics);
  }

  const minimumVolume = numberOrNull(screening.minVolume);
  if (minimumVolume != null && (volume == null || volume < minimumVolume)) {
    return reject(`Pool volume $${volume ?? "unknown"} is below configured minimum $${minimumVolume}.`, metrics);
  }

  const minimumFeeRatio = numberOrNull(screening.minFeeActiveTvlRatio);
  if (minimumFeeRatio != null && (feeActiveTvlRatio == null || feeActiveTvlRatio < minimumFeeRatio)) {
    return reject(`Pool fee/active-TVL ${feeActiveTvlRatio ?? "unknown"}% is below configured minimum ${minimumFeeRatio}%.`, metrics);
  }

  const minimumMarketCap = numberOrNull(screening.minMcap);
  const maximumMarketCap = numberOrNull(screening.maxMcap);
  if (minimumMarketCap != null && (marketCap == null || marketCap < minimumMarketCap)) {
    return reject(`Base token market cap $${marketCap ?? "unknown"} is below configured minimum $${minimumMarketCap}.`, metrics);
  }
  if (maximumMarketCap != null && marketCap != null && marketCap > maximumMarketCap) {
    return reject(`Base token market cap $${marketCap} is above configured maximum $${maximumMarketCap}.`, metrics);
  }

  const minimumHolders = numberOrNull(screening.minHolders);
  if (minimumHolders != null && (holders == null || holders < minimumHolders)) {
    return reject(`Base token holders ${holders ?? "unknown"} is below configured minimum ${minimumHolders}.`, metrics);
  }

  const minimumOrganic = numberOrNull(screening.minOrganic);
  const minimumQuoteOrganic = numberOrNull(screening.minQuoteOrganic);
  if (minimumOrganic != null && (baseOrganic == null || baseOrganic < minimumOrganic)) {
    return reject(`Base token organic score ${baseOrganic ?? "unknown"} is below configured minimum ${minimumOrganic}.`, metrics);
  }
  if (minimumQuoteOrganic != null && (quoteOrganic == null || quoteOrganic < minimumQuoteOrganic)) {
    return reject(`Quote token organic score ${quoteOrganic ?? "unknown"} is below configured minimum ${minimumQuoteOrganic}.`, metrics);
  }

  const minimumBinStep = numberOrNull(screening.minBinStep);
  const maximumBinStep = numberOrNull(screening.maxBinStep);
  if (minimumBinStep != null && (binStep == null || binStep < minimumBinStep)) {
    return reject(`Pool bin_step ${binStep ?? "unknown"} is below configured minimum ${minimumBinStep}.`, metrics);
  }
  if (maximumBinStep != null && binStep != null && binStep > maximumBinStep) {
    return reject(`Pool bin_step ${binStep} is above configured maximum ${maximumBinStep}.`, metrics);
  }

  if (observedVolatility == null || observedVolatility <= 0) {
    return reject(`Pool ${volatilityTimeframe} volatility ${observedVolatility ?? "unknown"} is unusable.`, metrics);
  }
  const maximumVolatility = numberOrNull(screening.maxVolatility);
  if (maximumVolatility != null && observedVolatility > maximumVolatility) {
    return reject(`Pool ${volatilityTimeframe} volatility ${observedVolatility} exceeds configured maximum ${maximumVolatility}.`, metrics);
  }

  const timestamp = createdAtMs(detail);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const minimumAgeHours = numberOrNull(screening.minTokenAgeHours);
  const maximumAgeHours = numberOrNull(screening.maxTokenAgeHours);
  if ((minimumAgeHours != null || maximumAgeHours != null) && (timestamp == null || !Number.isFinite(nowMs))) {
    return reject("Could not verify token age from the fresh snapshot.", metrics);
  }
  if (timestamp != null && Number.isFinite(nowMs)) {
    const ageHours = (nowMs - timestamp) / 3_600_000;
    metrics.tokenAgeHours = Math.round(ageHours * 100) / 100;
    if (minimumAgeHours != null && ageHours < minimumAgeHours) {
      return reject(`Token age ${ageHours.toFixed(2)}h is below configured minimum ${minimumAgeHours}h.`, metrics);
    }
    if (maximumAgeHours != null && ageHours > maximumAgeHours) {
      return reject(`Token age ${ageHours.toFixed(2)}h is above configured maximum ${maximumAgeHours}h.`, metrics);
    }
  }

  return {
    pass: true,
    reason: "Fresh pool fundamentals are within policy.",
    metrics,
    baseMint: detail?.token_x?.address ?? detail.base_token_address ?? null,
    entryMarketData: {
      entry_mcap: marketCap,
      entry_tvl: tvl,
      entry_volume: volume,
      entry_holders: holders,
    },
  };
}

function includesIgnoreCase(values, value) {
  if (!Array.isArray(values) || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

/** Hard token-audit gate shared by automatic screening and direct deploys. */
export function evaluateTokenAuditRisk(tokenInfo, screening = {}, { expectedMint = null } = {}) {
  const required = screening.requireTokenAudit ?? true;
  if (!tokenInfo || typeof tokenInfo !== "object") {
    return required
      ? reject("Fresh token audit is unavailable; refusing deploy.")
      : { pass: true, reason: "Token audit is optional and unavailable.", metrics: null };
  }
  if (expectedMint && !tokenInfo.mint && required) {
    return reject("Token audit mint is unavailable; cannot bind the audit to the pool base mint.");
  }
  if (expectedMint && tokenInfo.mint && String(expectedMint).toLowerCase() !== String(tokenInfo.mint).toLowerCase()) {
    return reject(`Token audit mint ${tokenInfo.mint} does not match pool base mint ${expectedMint}.`);
  }

  const globalFeesSol = numberOrNull(tokenInfo.global_fees_sol);
  const top10Pct = numberOrNull(tokenInfo?.audit?.top_holders_pct);
  const botHoldersPct = numberOrNull(tokenInfo?.audit?.bot_holders_pct);
  const metrics = { globalFeesSol, top10Pct, botHoldersPct };

  const minimumFees = numberOrNull(screening.minTokenFeesSol);
  const maximumTop10 = numberOrNull(screening.maxTop10Pct);
  const maximumBots = numberOrNull(screening.maxBotHoldersPct);
  if (required && minimumFees != null && globalFeesSol == null) return reject("Token audit is missing global fee data.", metrics);
  if (required && maximumTop10 != null && top10Pct == null) return reject("Token audit is missing top10 holder concentration.", metrics);
  if (required && maximumBots != null && botHoldersPct == null) return reject("Token audit is missing bot-holder concentration.", metrics);
  if (minimumFees != null && globalFeesSol != null && globalFeesSol < minimumFees) {
    return reject(`Token fees ${globalFeesSol} SOL are below configured minimum ${minimumFees} SOL.`, metrics);
  }
  if (maximumTop10 != null && top10Pct != null && top10Pct > maximumTop10) {
    return reject(`Top10 concentration ${top10Pct}% exceeds configured maximum ${maximumTop10}%.`, metrics);
  }
  if (maximumBots != null && botHoldersPct != null && botHoldersPct > maximumBots) {
    return reject(`Bot holders ${botHoldersPct}% exceeds configured maximum ${maximumBots}%.`, metrics);
  }

  const launchpad = tokenInfo.launchpad ?? null;
  if (launchpad && Array.isArray(screening.allowedLaunchpads) && screening.allowedLaunchpads.length > 0 && !includesIgnoreCase(screening.allowedLaunchpads, launchpad)) {
    return reject(`Launchpad ${launchpad} is not in the configured allow-list.`, metrics);
  }
  if (launchpad && includesIgnoreCase(screening.blockedLaunchpads, launchpad)) {
    return reject(`Launchpad ${launchpad} is blocked.`, metrics);
  }

  return { pass: true, reason: "Fresh token audit is within policy.", metrics };
}

function formatSigned(value) {
  if (!Number.isFinite(value)) return "?";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function performanceStats(records) {
  const wins = records.filter((record) => record.pnl_pct > 0);
  const losses = records.filter((record) => record.pnl_pct < 0);
  const grossWins = wins.reduce((sum, record) => sum + record.pnl_pct, 0);
  const grossLosses = Math.abs(losses.reduce((sum, record) => sum + record.pnl_pct, 0));
  const net = grossWins - grossLosses;
  return {
    count: records.length,
    winRate: records.length > 0 ? (wins.length / records.length) * 100 : null,
    net,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : null),
    averageWin: wins.length > 0 ? grossWins / wins.length : null,
    averageLoss: losses.length > 0 ? -grossLosses / losses.length : null,
  };
}

/** Compact, deterministic context for the screener model. */
export function buildRiskIntelligenceBrief({ performance = [], policy = {}, maxVolatility = 12, now = new Date() } = {}) {
  const records = normalizedPerformance(performance);
  const recent = records.slice(-10);
  const stats = performanceStats(recent);
  const maxVol = positiveNumber(maxVolatility, 12);
  const highVolatility = records.filter((record) => {
    const volatility = numberOrNull(record.volatility ?? record?.signal_snapshot?.volatility);
    return volatility != null && volatility > maxVol;
  });
  const highVolatilityStats = performanceStats(highVolatility);
  const stopLosses = records.filter((record) => /stop\s*loss/i.test(String(record.close_reason || "")));
  const stopLossStats = performanceStats(stopLosses);
  const circuit = evaluateLossCircuitBreaker({ performance: records, policy, now });

  if (records.length === 0) {
    return [
      "REALIZED RISK INTELLIGENCE (deterministic backend)",
      "- No closed-position history is available yet; do not infer an edge from missing data.",
      "- CIRCUIT CLOSED: no realized loss trigger is present.",
    ].join("\n");
  }

  const profitFactor = stats.profitFactor === Infinity ? "infinite" : (stats.profitFactor?.toFixed(2) ?? "n/a");
  const lines = [
    "REALIZED RISK INTELLIGENCE (deterministic backend)",
    `- Last ${stats.count} closes: win rate ${stats.winRate.toFixed(1)}%, net ${formatSigned(stats.net)}, profit factor ${profitFactor}, avg win ${formatSigned(stats.averageWin)}, avg loss ${formatSigned(stats.averageLoss)}.`,
  ];
  if (highVolatilityStats.count > 0) {
    lines.push(`- High-volatility tail (>${maxVol}): ${highVolatilityStats.count} closes, net ${formatSigned(highVolatilityStats.net)}, avg loss ${formatSigned(highVolatilityStats.averageLoss)}.`);
  } else {
    lines.push(`- High-volatility tail (>${maxVol}): no closed samples.`);
  }
  if (stopLossStats.count > 0) {
    lines.push(`- Stop-loss outcomes: ${stopLossStats.count} closes, net ${formatSigned(stopLossStats.net)}, avg loss ${formatSigned(stopLossStats.averageLoss)}.`);
  }
  lines.push(circuit.pass
    ? `- CIRCUIT CLOSED: ${circuit.reason}`
    : `- CIRCUIT OPEN: ${circuit.reason}`);
  lines.push("- Treat this history as risk context, not proof of future returns; backend gates remain authoritative.");
  return lines.join("\n");
}
