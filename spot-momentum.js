import { SOL_MINT } from "./execution-guard.js";

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function reject(reason, metrics = {}) {
  return { pass: false, reason, metrics };
}

export function spotScreeningPolicy(spot = {}) {
  return {
    minLiquidityUsd: finite(spot.minLiquidityUsd) ?? 30_000,
    minVolume5mUsd: finite(spot.minVolume5mUsd) ?? 2_000,
    minVolumeLiquidityRatio: finite(spot.minVolumeLiquidityRatio) ?? 0.03,
    minOrganic: finite(spot.minOrganic) ?? 65,
    minHolders: finite(spot.minHolders) ?? 300,
    minMarketCapUsd: finite(spot.minMarketCapUsd) ?? 100_000,
    maxMarketCapUsd: finite(spot.maxMarketCapUsd) ?? 30_000_000,
    minTokenAgeMinutes: finite(spot.minTokenAgeMinutes) ?? 30,
    maxTokenAgeHours: finite(spot.maxTokenAgeHours) ?? 2_160,
    maxTop10Pct: finite(spot.maxTop10Pct) ?? 30,
    maxBotHoldersPct: finite(spot.maxBotHoldersPct) ?? 20,
    minPriceChange5mPct: finite(spot.minPriceChange5mPct) ?? 1.5,
    maxPriceChange5mPct: finite(spot.maxPriceChange5mPct) ?? 8,
    minVolumeChangePct: finite(spot.minVolumeChangePct) ?? 20,
    minBuySellVolumeRatio: finite(spot.minBuySellVolumeRatio) ?? 1.15,
    minSpikeScore: finite(spot.minSpikeScore) ?? 40,
    requirePositiveNetBuyers: spot.requirePositiveNetBuyers !== false,
    requireMintAuthorityDisabled: spot.requireMintAuthorityDisabled !== false,
    requireFreezeAuthorityDisabled: spot.requireFreezeAuthorityDisabled !== false,
    requireMomentumConfirmation: spot.requireMomentumConfirmation !== false,
  };
}

export function calculateSpotSpikeScore({
  priceChange5mPct,
  volumeChangePct,
  buySellVolumeRatio,
} = {}) {
  const price = finite(priceChange5mPct);
  const volume = finite(volumeChangePct);
  const buySell = finite(buySellVolumeRatio);
  if (price == null || volume == null || buySell == null) return null;

  const priceStrength = Math.min(1, Math.max(0, price) / 5);
  const volumeStrength = Math.min(1, Math.max(0, volume) / 100);
  const buyerStrength = Math.min(1, Math.max(0, buySell - 1) / 0.5);
  return Number(((priceStrength * 0.45 + volumeStrength * 0.35 + buyerStrength * 0.2) * 100).toFixed(2));
}

/**
 * Deterministic candidate gate. The LLM only sees candidates that pass this
 * function, and the same checks are repeated from fresh data before a buy.
 */
export function evaluateSpotMomentumCandidate({ pool, tokenInfo, policy = {} } = {}) {
  const p = spotScreeningPolicy(policy);
  const baseMint = pool?.base?.mint ?? null;
  const quoteMint = pool?.quote?.mint ?? null;
  const liquidity = finite(pool?.active_tvl ?? pool?.tvl);
  const volume = finite(pool?.volume_window);
  // Pool Discovery exposes its precomputed ratio in percentage points while
  // some fallback sources expose a decimal fraction. Recompute from the two
  // dollar values so 0.05 always means 5%, never 0.05%.
  const volumeLiquidityRatio = liquidity && volume != null ? volume / liquidity : null;
  const organic = finite(pool?.organic_score ?? pool?.base?.organic);
  const holders = finite(pool?.holders ?? tokenInfo?.holders);
  const marketCap = finite(pool?.mcap ?? tokenInfo?.mcap);
  const tokenAgeHours = finite(pool?.token_age_hours);
  const priceChange5mPct = finite(pool?.price_change_pct);
  const volumeChangePct = finite(pool?.volume_change_pct);
  const top10Pct = finite(tokenInfo?.audit?.top_holders_pct);
  const botHoldersPct = finite(tokenInfo?.audit?.bot_holders_pct);
  const buyVolume = finite(tokenInfo?.stats_1h?.buy_vol);
  const sellVolume = finite(tokenInfo?.stats_1h?.sell_vol);
  const netBuyers = finite(tokenInfo?.stats_1h?.net_buyers);
  const buySellVolumeRatio = buyVolume != null && sellVolume != null
    ? buyVolume / Math.max(sellVolume, 1)
    : null;
  const spikeScore = calculateSpotSpikeScore({ priceChange5mPct, volumeChangePct, buySellVolumeRatio });
  const momentumConfirmed = pool?.indicator_confirmation?.confirmed === true
    && pool?.indicator_confirmation?.skipped !== true;

  const metrics = {
    baseMint,
    quoteMint,
    liquidity,
    volume,
    volumeLiquidityRatio,
    organic,
    holders,
    marketCap,
    tokenAgeHours,
    priceChange5mPct,
    volumeChangePct,
    top10Pct,
    botHoldersPct,
    buyVolume,
    sellVolume,
    buySellVolumeRatio,
    netBuyers,
    momentumConfirmed,
    spikeScore,
    entryStyle: "early_spike",
  };

  if (!baseMint) return reject("Base token mint is missing.", metrics);
  if (quoteMint !== SOL_MINT) return reject("Spot momentum only accepts SOL-quoted pools.", metrics);
  if (!tokenInfo || tokenInfo.mint !== baseMint) return reject("Fresh token audit is unavailable or does not match the pool base mint.", metrics);
  if (p.requireMintAuthorityDisabled && tokenInfo?.audit?.mint_disabled !== true) {
    return reject("Token mint authority is not provably disabled.", metrics);
  }
  if (p.requireFreezeAuthorityDisabled && tokenInfo?.audit?.freeze_disabled !== true) {
    return reject("Token freeze authority is not provably disabled.", metrics);
  }
  if (liquidity == null || liquidity < p.minLiquidityUsd) return reject(`Liquidity is below $${p.minLiquidityUsd}.`, metrics);
  if (volume == null || volume < p.minVolume5mUsd) return reject(`5-minute volume is below $${p.minVolume5mUsd}.`, metrics);
  if (volumeLiquidityRatio == null || volumeLiquidityRatio < p.minVolumeLiquidityRatio) {
    return reject(`5-minute volume/liquidity is below ${p.minVolumeLiquidityRatio}.`, metrics);
  }
  if (organic == null || organic < p.minOrganic) return reject(`Organic score is below ${p.minOrganic}.`, metrics);
  if (holders == null || holders < p.minHolders) return reject(`Holder count is below ${p.minHolders}.`, metrics);
  if (marketCap == null || marketCap < p.minMarketCapUsd || marketCap > p.maxMarketCapUsd) {
    return reject(`Market cap is outside $${p.minMarketCapUsd}-$${p.maxMarketCapUsd}.`, metrics);
  }
  if (tokenAgeHours == null) return reject("Token age is unavailable.", metrics);
  if (tokenAgeHours * 60 < p.minTokenAgeMinutes || tokenAgeHours > p.maxTokenAgeHours) {
    return reject(`Token age is outside ${p.minTokenAgeMinutes}m-${p.maxTokenAgeHours}h.`, metrics);
  }
  if (top10Pct == null || top10Pct > p.maxTop10Pct) return reject(`Top-10 holder concentration exceeds ${p.maxTop10Pct}%.`, metrics);
  if (botHoldersPct == null || botHoldersPct > p.maxBotHoldersPct) return reject(`Bot-holder concentration exceeds ${p.maxBotHoldersPct}%.`, metrics);
  if (priceChange5mPct == null || priceChange5mPct < p.minPriceChange5mPct) {
    return reject(`5-minute price momentum is below ${p.minPriceChange5mPct}%.`, metrics);
  }
  if (priceChange5mPct > p.maxPriceChange5mPct) return reject(`5-minute price move exceeds chase limit ${p.maxPriceChange5mPct}%.`, metrics);
  if (volumeChangePct == null || volumeChangePct < p.minVolumeChangePct) {
    return reject(`Volume acceleration is below ${p.minVolumeChangePct}%.`, metrics);
  }
  if (buySellVolumeRatio == null || buySellVolumeRatio < p.minBuySellVolumeRatio) {
    return reject(`Buy/sell volume ratio is below ${p.minBuySellVolumeRatio}.`, metrics);
  }
  if (p.requirePositiveNetBuyers && (netBuyers == null || netBuyers <= 0)) {
    return reject("Net organic buyers are not positive.", metrics);
  }
  if (spikeScore == null || spikeScore < p.minSpikeScore) {
    return reject(`Composite spike strength is below ${p.minSpikeScore}.`, metrics);
  }
  if (p.requireMomentumConfirmation && !momentumConfirmed) {
    return reject("Fresh 5-minute and 15-minute momentum is not confirmed.", metrics);
  }

  const liquidityScore = Math.min(1, Math.log10(Math.max(liquidity, 1)) / Math.log10(Math.max(p.minLiquidityUsd * 10, 10)));
  const volumeScore = Math.min(1, volumeLiquidityRatio / Math.max(p.minVolumeLiquidityRatio * 3, 0.0001));
  const organicScore = Math.min(1, organic / 100);
  const buyerScore = Math.min(1, buySellVolumeRatio / Math.max(p.minBuySellVolumeRatio * 2, 0.0001));
  const momentumScore = Math.min(1, spikeScore / 100);
  const score = Number(((liquidityScore + volumeScore + organicScore + buyerScore + momentumScore) * 20).toFixed(2));

  return { pass: true, reason: "Candidate passed deterministic early-spike gates.", metrics, score };
}

export function calculateSpotPnlPct(entryCostSol, currentValueSol) {
  const entry = finite(entryCostSol);
  const current = finite(currentValueSol);
  if (entry == null || entry <= 0 || current == null || current < 0) return null;
  return ((current - entry) / entry) * 100;
}

/**
 * Exit priority is deliberately mechanical: loss protection, fixed profit,
 * trailing protection, then maximum holding time. No timed re-entry cooldown is
 * introduced here; a later entry still needs a completely fresh signal.
 */
export function evaluateSpotExit({ position, currentValueSol, now = new Date(), policy = {} } = {}) {
  const pnlPct = calculateSpotPnlPct(position?.entryCostSol, currentValueSol);
  if (pnlPct == null) {
    return { action: "HOLD", reason: "Spot position is not currently priceable.", pnlPct: null, peakPnlPct: finite(position?.peakPnlPct) ?? 0 };
  }

  const stopLossTriggerPct = finite(policy.stopLossTriggerPct) ?? -3;
  const takeProfitPct = finite(policy.takeProfitPct) ?? 3;
  const trailingTriggerPct = finite(policy.trailingTriggerPct) ?? 1.5;
  const trailingDropPct = finite(policy.trailingDropPct) ?? 0.5;
  const maxHoldMinutes = finite(policy.maxHoldMinutes) ?? 5;
  const previousPeak = finite(position?.peakPnlPct) ?? 0;
  const peakPnlPct = Math.max(previousPeak, pnlPct);

  if (pnlPct <= stopLossTriggerPct) {
    return { action: "STOP_LOSS", reason: `PnL ${pnlPct.toFixed(2)}% <= trigger ${stopLossTriggerPct}%`, pnlPct, peakPnlPct };
  }
  if (pnlPct >= takeProfitPct) {
    return { action: "TAKE_PROFIT", reason: `PnL ${pnlPct.toFixed(2)}% >= target ${takeProfitPct}%`, pnlPct, peakPnlPct };
  }
  if (peakPnlPct >= trailingTriggerPct && pnlPct <= peakPnlPct - trailingDropPct) {
    return { action: "TRAILING_TAKE_PROFIT", reason: `PnL retraced ${trailingDropPct}% from ${peakPnlPct.toFixed(2)}% peak`, pnlPct, peakPnlPct };
  }

  const openedAtMs = Date.parse(position?.openedAt || "");
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const ageMinutes = Number.isFinite(openedAtMs) && Number.isFinite(nowMs)
    ? (nowMs - openedAtMs) / 60_000
    : null;
  if (ageMinutes != null && ageMinutes >= maxHoldMinutes) {
    return { action: "MAX_HOLD", reason: `Position age ${ageMinutes.toFixed(1)}m >= ${maxHoldMinutes}m`, pnlPct, peakPnlPct, ageMinutes };
  }

  return { action: "HOLD", reason: "No mechanical exit condition is active.", pnlPct, peakPnlPct, ageMinutes };
}
