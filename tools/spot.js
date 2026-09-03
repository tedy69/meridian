import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { appendDecision } from "../decision-log.js";
import { assertSpotSwapAllowed, isDryRun, SOL_MINT } from "../execution-guard.js";
import { log } from "../logger.js";
import { getSpotRealtimeTelemetry } from "../spot-realtime.js";
import {
  calculateSpotPnlPct,
  evaluateSpotExit,
  evaluateSpotMomentumCandidate,
  spotScreeningPolicy,
} from "../spot-momentum.js";
import {
  beginSpotOpen,
  cancelSpotOpen,
  completeSpotClose,
  confirmSpotOpen,
  getSpotHistory,
  getSpotPosition as readSpotPosition,
  markSpotOpeningSubmitted,
  markSpotClosing,
  restoreSpotOpen,
  updateSpotObservation,
  updateSpotTokenBalance,
} from "../spot-state.js";
import {
  commitSpotBuy,
  getSpotRiskBudget,
  recordSpotRealizedPnl,
  releaseSpotBuy,
  reserveSpotBuy,
} from "../spot-risk-budget.js";
import { confirmIndicatorPreset } from "./chart-indicators.js";
import { getActiveBin, getMyPositions } from "./dlmm.js";
import { discoverPools, getPoolDetail } from "./screening.js";
import { getTokenInfo } from "./token.js";
import {
  buySpotToken,
  getFinalizedSlot,
  getJupiterPrices,
  getSpotRoundTripQuote,
  getTokenBalanceByMint,
  inspectMintSafety,
  sellSpotToken,
} from "./wallet.js";

function safeNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function atomicToUiAmount(rawAmount, decimals) {
  const raw = BigInt(String(rawAmount));
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 18) throw new Error("Token decimals are invalid");
  const text = raw.toString().padStart(places + 1, "0");
  const value = Number(places === 0 ? text : `${text.slice(0, -places)}.${text.slice(-places)}`);
  if (!Number.isFinite(value) || value < 0) throw new Error("Token amount is outside the supported numeric range");
  return value;
}

function measuredSpotEntryCost(solBefore, solAfter, spotConfig) {
  const expected = Number(spotConfig.tradeAmountSol);
  const maximumFees = Number(spotConfig.maxTotalFeeLamports) / 1_000_000_000;
  const measured = Number(solBefore) - Number(solAfter);
  if (!Number.isFinite(measured) || measured + 1e-9 < expected || measured > expected + maximumFees + 1e-9) {
    throw new Error(`Finalized SOL debit ${Number.isFinite(measured) ? measured.toFixed(9) : "unknown"} is outside the exact entry plus bounded-fee range ${expected.toFixed(9)}-${(expected + maximumFees).toFixed(9)} SOL`);
  }
  return measured;
}

function profitProtectedExit(reason) {
  const action = String(reason || "").split(":", 1)[0].trim().toUpperCase();
  return action === "TAKE_PROFIT" || action === "TRAILING_TAKE_PROFIT";
}

function spotExitExecutionPolicy(reason, position, spotConfig) {
  if (!profitProtectedExit(reason)) return {};

  const entryCostSol = Number(position?.entryCostSol);
  const minimumProfitPct = Number(spotConfig?.minProfitExitPct);
  const slippageBps = Number(spotConfig?.profitExitSlippageBps);
  if (!Number.isFinite(entryCostSol) || entryCostSol <= 0) {
    throw new Error("Spot entry cost is invalid; a profitable exit cannot be proven");
  }
  if (!Number.isFinite(minimumProfitPct) || minimumProfitPct <= 0) {
    throw new Error("Spot minimum profit exit percentage is invalid");
  }
  if (!Number.isInteger(slippageBps) || slippageBps <= 0) {
    throw new Error("Spot profit exit slippage is invalid");
  }

  const entryCostLamports = Math.round(entryCostSol * LAMPORTS_PER_SOL);
  const minimumNetOutputLamports = Math.ceil(entryCostLamports * (1 + minimumProfitPct / 100));
  if (!Number.isSafeInteger(entryCostLamports) || entryCostLamports <= 0 || !Number.isSafeInteger(minimumNetOutputLamports)) {
    throw new Error("Spot profitable exit floor is outside the safe lamport range");
  }
  return {
    slippageBps,
    minimumNetOutputLamports: String(minimumNetOutputLamports),
  };
}

function tokenCreatedAtMs(raw) {
  const value = safeNumber(raw?.token_x?.created_at ?? raw?.base_token_created_at);
  if (value == null) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function poolAddress(raw) {
  return raw?.pool_address ?? raw?.address ?? raw?.pool ?? null;
}

function freshPoolCandidate(raw, indicatorConfirmation = null) {
  const createdAt = tokenCreatedAtMs(raw);
  const tvl = safeNumber(raw?.tvl ?? raw?.active_tvl);
  const activeTvl = safeNumber(raw?.active_tvl ?? raw?.tvl);
  const volume = safeNumber(raw?.volume);
  return {
    pool: poolAddress(raw),
    name: raw?.name ?? `${raw?.token_x?.symbol || "?"}-${raw?.token_y?.symbol || "SOL"}`,
    base: {
      mint: raw?.token_x?.address ?? raw?.base_token_address ?? null,
      symbol: raw?.token_x?.symbol ?? null,
      organic: safeNumber(raw?.token_x?.organic_score ?? raw?.base_token_organic_score),
    },
    quote: {
      mint: raw?.token_y?.address ?? raw?.quote_token_address ?? null,
      symbol: raw?.token_y?.symbol ?? null,
    },
    tvl,
    active_tvl: activeTvl,
    volume_window: volume,
    volume_active_tvl_ratio: activeTvl && volume != null ? volume / activeTvl : null,
    organic_score: safeNumber(raw?.token_x?.organic_score ?? raw?.base_token_organic_score),
    holders: safeNumber(raw?.base_token_holders ?? raw?.token_x?.holders),
    mcap: safeNumber(raw?.token_x?.market_cap ?? raw?.base_token_market_cap),
    token_age_hours: createdAt == null ? null : (Date.now() - createdAt) / 3_600_000,
    price_change_pct: safeNumber(raw?.pool_price_change_pct ?? raw?.price_change_pct),
    volume_change_pct: safeNumber(raw?.volume_change_pct),
    indicator_confirmation: indicatorConfirmation,
  };
}

function cheapPoolEvaluation(pool, policy) {
  const liquidity = safeNumber(pool?.active_tvl ?? pool?.tvl, 0);
  const volume = safeNumber(pool?.volume_window, 0);
  const ratio = liquidity > 0 ? volume / liquidity : 0;
  const ageHours = safeNumber(pool?.token_age_hours);
  if (pool?.quote?.mint !== SOL_MINT) return { pass: false, reason: "Discovery pool is not SOL-quoted." };
  if (liquidity < policy.minLiquidityUsd) return { pass: false, reason: `Discovery liquidity is below $${policy.minLiquidityUsd}.` };
  if (volume < policy.minVolume5mUsd) return { pass: false, reason: `Discovery 5-minute volume is below $${policy.minVolume5mUsd}.` };
  if (ratio < policy.minVolumeLiquidityRatio) return { pass: false, reason: `Discovery volume/liquidity is below ${policy.minVolumeLiquidityRatio}.` };
  if (safeNumber(pool?.organic_score, 0) < policy.minOrganic) return { pass: false, reason: `Discovery organic score is below ${policy.minOrganic}.` };
  if (safeNumber(pool?.holders, 0) < policy.minHolders) return { pass: false, reason: `Discovery holder count is below ${policy.minHolders}.` };
  if (safeNumber(pool?.mcap, 0) < policy.minMarketCapUsd || safeNumber(pool?.mcap, Infinity) > policy.maxMarketCapUsd) {
    return { pass: false, reason: `Discovery market cap is outside $${policy.minMarketCapUsd}-$${policy.maxMarketCapUsd}.` };
  }
  if (ageHours == null || ageHours * 60 < policy.minTokenAgeMinutes || ageHours > policy.maxTokenAgeHours) {
    return { pass: false, reason: `Discovery token age is outside ${policy.minTokenAgeMinutes}m-${policy.maxTokenAgeHours}h.` };
  }
  return { pass: true, reason: "Pool passed broad discovery gates." };
}

function spotDeps(overrides = {}) {
  return {
    discoverPools,
    getPoolDetail,
    getTokenInfo,
    confirmIndicatorPreset,
    getActiveBin,
    getMyPositions,
    getTokenBalanceByMint,
    inspectMintSafety,
    getJupiterPrices,
    getFinalizedSlot,
    getSpotRoundTripQuote,
    buySpotToken,
    sellSpotToken,
    readSpotPosition,
    getSpotHistory,
    beginSpotOpen,
    markSpotOpeningSubmitted,
    confirmSpotOpen,
    cancelSpotOpen,
    updateSpotObservation,
    updateSpotTokenBalance,
    markSpotClosing,
    restoreSpotOpen,
    completeSpotClose,
    reserveSpotBuy,
    commitSpotBuy,
    releaseSpotBuy,
    recordSpotRealizedPnl,
    getSpotRiskBudget,
    appendDecision,
    tradingMode: config.trading.mode,
    spotConfig: config.spot,
    spotDiscoveryConfig: config.spotDiscovery,
    indicatorConfig: config.indicators,
    dryRun: isDryRun(),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
}

export async function getSpotMomentumCandidates({ limit = 10 } = {}, overrides = {}) {
  const deps = spotDeps(overrides);
  if (deps.tradingMode !== "spot_momentum") {
    return { candidates: [], blocked: true, reason: "tradingMode is not spot_momentum" };
  }
  const active = deps.readSpotPosition();
  if (active) return { candidates: [], blocked: true, reason: `spot position ${active.id} is ${active.status}` };

  const discoveryPolicy = spotScreeningPolicy(deps.spotDiscoveryConfig);
  const entryPolicy = spotScreeningPolicy(deps.spotConfig);
  const discovery = await deps.discoverPools({ page_size: 50, profile: "spot_momentum" });
  const broadFiltered = [];
  const pools = (discovery?.pools || [])
    .filter((pool) => {
      const evaluation = cheapPoolEvaluation(pool, discoveryPolicy);
      if (!evaluation.pass) broadFiltered.push({ name: pool?.name, reason: evaluation.reason });
      return evaluation.pass;
    })
    .sort((a, b) => safeNumber(b.volume_active_tvl_ratio, 0) - safeNumber(a.volume_active_tvl_ratio, 0))
    .slice(0, 15);
  const candidates = [];
  const filtered = [];

  for (const pool of pools) {
    try {
      const mint = pool.base?.mint;
      const [tokenResult, momentum, mintSafety] = await Promise.all([
        deps.getTokenInfo({ query: mint }),
        deps.confirmIndicatorPreset({
          mint,
          side: "entry",
          preset: deps.indicatorConfig.entryPreset,
          intervals: deps.indicatorConfig.intervals,
          refresh: true,
        }),
        deps.inspectMintSafety(mint, {
          requireLegacyTokenProgram: deps.spotConfig.requireLegacyTokenProgram,
          allowMetadataOnlyToken2022: deps.spotConfig.allowMetadataOnlyToken2022,
        }),
      ]);
      const tokenInfo = tokenResult?.results?.[0] ?? null;
      const candidate = { ...pool, indicator_confirmation: momentum };
      const evaluation = evaluateSpotMomentumCandidate({ pool: candidate, tokenInfo, policy: entryPolicy });
      if (!evaluation.pass) {
        filtered.push({ name: pool.name, reason: evaluation.reason });
      } else {
        const roundTripQuote = await deps.getSpotRoundTripQuote({
          mint,
          amountSol: deps.spotConfig.tradeAmountSol,
        });
        if (!roundTripQuote?.pass) {
          filtered.push({ name: pool.name, reason: roundTripQuote?.reason || "Round-trip execution quote failed closed." });
          continue;
        }
        candidates.push({
          ...candidate,
          spot_score: evaluation.score,
          spot_metrics: {
            ...evaluation.metrics,
            roundTripExpectedLossPct: roundTripQuote.expectedLossPct,
            buyPriceImpactPct: roundTripQuote.buy?.priceImpactPct ?? null,
            sellPriceImpactPct: roundTripQuote.sell?.priceImpactPct ?? null,
          },
          round_trip_quote: roundTripQuote,
          mint_safety: mintSafety,
          token_audit: tokenInfo?.audit ?? null,
          token_stats_1h: tokenInfo?.stats_1h ?? null,
        });
      }
    } catch (error) {
      filtered.push({ name: pool.name, reason: `fresh spot checks failed: ${error.message}` });
    }
    await deps.sleep(150);
  }

  candidates.sort((a, b) => b.spot_score - a.spot_score);
  return {
    candidates: candidates.slice(0, Math.max(1, Math.min(10, Number(limit) || 10))),
    total_screened: discovery?.pools?.length ?? 0,
    shortlist_size: pools.length,
    discovery_rejected: broadFiltered.length,
    fresh_rejected: filtered.length,
    filtered_examples: [...filtered, ...broadFiltered].slice(0, 5),
  };
}

export async function validateSpotEntry(poolAddressValue, overrides = {}) {
  const deps = spotDeps(overrides);
  let address;
  try {
    address = new PublicKey(poolAddressValue).toBase58();
  } catch {
    return { pass: false, reason: "A valid base58 pool address is required." };
  }

  let raw;
  try {
    raw = await deps.getPoolDetail({ pool_address: address, timeframe: "5m" });
  } catch (error) {
    return { pass: false, reason: `Could not refresh the 5-minute pool snapshot: ${error.message}` };
  }
  if (!raw || poolAddress(raw) !== address) return { pass: false, reason: "Fresh pool snapshot does not match the requested pool." };
  if (raw.pool_type && raw.pool_type !== "dlmm") return { pass: false, reason: `Pool type ${raw.pool_type} is not supported.` };
  if (raw.base_token_has_critical_warnings === true || raw.quote_token_has_critical_warnings === true) {
    return { pass: false, reason: "Fresh pool snapshot contains critical token warnings." };
  }
  if (raw.base_token_has_high_single_ownership === true || raw.base_token_has_high_supply_concentration === true) {
    return { pass: false, reason: "Fresh pool snapshot shows unsafe token ownership concentration." };
  }

  const baseMint = raw?.token_x?.address ?? raw?.base_token_address ?? null;
  try {
    const [tokenResult, momentum, mintSafety, roundTripQuote] = await Promise.all([
      deps.getTokenInfo({ query: baseMint }),
      deps.confirmIndicatorPreset({
        mint: baseMint,
        side: "entry",
        preset: deps.indicatorConfig.entryPreset,
        intervals: deps.indicatorConfig.intervals,
        refresh: true,
      }),
      deps.inspectMintSafety(baseMint, {
        requireLegacyTokenProgram: deps.spotConfig.requireLegacyTokenProgram,
        allowMetadataOnlyToken2022: deps.spotConfig.allowMetadataOnlyToken2022,
      }),
      deps.getSpotRoundTripQuote({
        mint: baseMint,
        amountSol: deps.spotConfig.tradeAmountSol,
      }),
    ]);
    const tokenInfo = tokenResult?.results?.[0] ?? null;
    const candidate = freshPoolCandidate(raw, momentum);
    const evaluation = evaluateSpotMomentumCandidate({ pool: candidate, tokenInfo, policy: deps.spotConfig });
    if (!evaluation.pass) return evaluation;
    if (!roundTripQuote?.pass) {
      return {
        pass: false,
        reason: roundTripQuote?.reason || "Round-trip execution quote failed closed.",
        metrics: {
          ...evaluation.metrics,
          roundTripExpectedLossPct: roundTripQuote?.expectedLossPct ?? null,
        },
      };
    }
    return {
      pass: true,
      reason: "Fresh spot entry checks passed.",
      pool: candidate,
      tokenInfo,
      mintSafety,
      roundTripQuote,
      signalSnapshot: {
        checkedAt: new Date().toISOString(),
        spotScore: evaluation.score,
        ...evaluation.metrics,
        momentum: momentum?.intervals ?? [],
        roundTripExpectedLossPct: roundTripQuote.expectedLossPct,
        roundTripQuoteCheckedAt: roundTripQuote.checkedAt ?? null,
        buyPriceImpactPct: roundTripQuote.buy?.priceImpactPct ?? null,
        sellPriceImpactPct: roundTripQuote.sell?.priceImpactPct ?? null,
      },
    };
  } catch (error) {
    return { pass: false, reason: `Fresh token or momentum verification failed: ${error.message}` };
  }
}

export function validateSpotOpenRequest(args = {}, overrides = {}) {
  const tradingMode = overrides.tradingMode ?? config.trading.mode;
  const spotConfig = overrides.spotConfig ?? config.spot;
  if (tradingMode !== "spot_momentum") return { pass: false, reason: "tradingMode is not spot_momentum" };
  if (!args.pool_address) return { pass: false, reason: "pool_address is required" };
  try {
    new PublicKey(args.pool_address);
  } catch {
    return { pass: false, reason: "pool_address must be a valid base58 public key" };
  }
  try {
    assertSpotSwapAllowed({
      mode: tradingMode,
      direction: "buy",
      inputMint: SOL_MINT,
      outputMint: "validated-on-fresh-preflight",
      amount: spotConfig.tradeAmountSol,
      configuredTradeAmountSol: spotConfig.tradeAmountSol,
      maxTradeAmountSol: spotConfig.maxTradeAmountSol,
    });
  } catch (error) {
    return { pass: false, reason: error.message };
  }
  return { pass: true };
}

export async function openSpotPosition({ pool_address } = {}, overrides = {}) {
  const deps = spotDeps(overrides);
  const request = validateSpotOpenRequest({ pool_address }, overrides);
  if (!request.pass) return { success: false, blocked: true, reason: request.reason };
  const existing = deps.readSpotPosition();
  if (existing) return { success: false, blocked: true, reason: `Spot position ${existing.id} is already ${existing.status}.` };
  const [lpPositions, preflight] = await Promise.all([
    deps.getMyPositions({ force: true, silent: true }),
    validateSpotEntry(pool_address, overrides),
  ]);
  if ((lpPositions?.total_positions ?? lpPositions?.positions?.length ?? 0) > 0) {
    return { success: false, blocked: true, reason: "An LP position is still open; mixed LP and spot exposure is blocked." };
  }
  if (!preflight.pass) return { success: false, blocked: true, reason: preflight.reason, risk_metrics: preflight.metrics ?? null };
  const amountSol = deps.spotConfig.tradeAmountSol;
  if (deps.dryRun) {
    return {
      success: true,
      dry_run: true,
      would_open: {
        pool: preflight.pool.pool,
        mint: preflight.pool.base.mint,
        symbol: preflight.pool.base.symbol,
        amount_sol: amountSol,
      },
      signal_snapshot: preflight.signalSnapshot,
      message: "DRY RUN — spot entry passed but no transaction or state write occurred",
    };
  }

  const [solBefore, tokenBefore] = await Promise.all([
    deps.getTokenBalanceByMint(SOL_MINT),
    deps.getTokenBalanceByMint(preflight.pool.base.mint),
  ]);
  if (solBefore.amount + Number.EPSILON < deps.spotConfig.minWalletSol) {
    return { success: false, blocked: true, reason: `Insufficient SOL: ${solBefore.amount} available; ${deps.spotConfig.minWalletSol} required for ${amountSol} SOL capital plus reserve.` };
  }
  let reservation;
  try {
    reservation = deps.reserveSpotBuy({
      amountSol,
      maxDailyBuySol: deps.spotConfig.maxDailyBuySol,
      maxDailyLossSol: deps.spotConfig.maxDailyLossSol,
    });
  } catch (error) {
    return { success: false, blocked: true, reason: error.message };
  }
  let pending;
  try {
    pending = deps.beginSpotOpen({
      pool: preflight.pool.pool,
      poolName: preflight.pool.name,
      mint: preflight.pool.base.mint,
      symbol: preflight.pool.base.symbol,
      entryCostSol: amountSol,
      solBalanceBefore: solBefore.amount,
      tokenBalanceBefore: tokenBefore.amount,
      tokenRawBalanceBefore: tokenBefore.raw_amount,
      tokenDecimals: tokenBefore.decimals,
      signalSnapshot: preflight.signalSnapshot,
    });
  } catch (error) {
    try { deps.releaseSpotBuy(reservation); } catch (releaseError) { log("spot_risk_error", releaseError.message); }
    return { success: false, blocked: true, reason: `Could not persist pending spot entry: ${error.message}` };
  }

  let buy;
  try {
    buy = await deps.buySpotToken({ mint: preflight.pool.base.mint, amountSol });
  } catch (error) {
    buy = { success: false, error: error.message, submission_attempted: error.submissionAttempted === true, tx: error.signature || null };
  }
  if (buy?.success !== true) {
    if (buy?.submission_attempted) {
      try { deps.markSpotOpeningSubmitted(pending.id, { buyTx: buy?.tx || null }); } catch (error) { log("spot_state_error", error.message); }
      try { deps.commitSpotBuy(reservation); } catch (error) { log("spot_risk_error", error.message); }
      return { success: false, pending: true, blocked: true, reason: `Spot buy outcome is uncertain; state remains opening: ${buy?.error || "unknown error"}`, tx: buy?.tx || null };
    }
    deps.cancelSpotOpen(pending.id, buy?.error || "buy rejected before submission");
    deps.releaseSpotBuy(reservation);
    return { success: false, blocked: true, reason: buy?.error || "Spot buy failed before submission." };
  }

  try { deps.markSpotOpeningSubmitted(pending.id, { buyTx: buy.tx }); } catch (error) { log("spot_state_error", error.message); }

  let budgetWarning = null;
  try {
    deps.commitSpotBuy(reservation);
  } catch (error) {
    budgetWarning = `Spot buy budget remains reserved and future entries must stay blocked: ${error.message}`;
    log("spot_risk_error", budgetWarning);
  }
  try {
    const [tokenAfter, solAfter] = await Promise.all([
      deps.getTokenBalanceByMint(preflight.pool.base.mint),
      deps.getTokenBalanceByMint(SOL_MINT),
    ]);
    let prices = {};
    try {
      prices = await deps.getJupiterPrices([preflight.pool.base.mint, SOL_MINT]);
    } catch (error) {
      log("spot_price_warn", `Buy finalized; entry price metadata unavailable: ${error.message}`);
    }
    const acquiredRaw = BigInt(tokenAfter.raw_amount) - BigInt(tokenBefore.raw_amount);
    const acquired = tokenAfter.amount - tokenBefore.amount;
    if (acquiredRaw <= 0n || acquired <= 0) throw new Error("Finalized token balance did not increase after the buy");
    const entryCostSol = measuredSpotEntryCost(solBefore.amount, solAfter.amount, deps.spotConfig);
    const opened = deps.confirmSpotOpen(pending.id, {
      tokenAmount: acquired,
      tokenRawAmount: acquiredRaw.toString(),
      tokenDecimals: tokenAfter.decimals,
      entryTokenUsd: safeNumber(prices?.[preflight.pool.base.mint]?.usdPrice),
      entrySolUsd: safeNumber(prices?.[SOL_MINT]?.usdPrice),
      entryCostSol,
      buyTx: buy.tx,
    });
    deps.appendDecision({
      type: "spot_open",
      actor: "SCREENER",
      pool: opened.pool,
      pool_name: opened.poolName,
      position: opened.id,
      summary: `Bought ${opened.symbol} with ${amountSol} SOL`,
      reason: "Fresh deterministic audit and 5m+15m momentum passed",
      metrics: preflight.signalSnapshot,
    });
    return { success: true, trade_status: "open", position: opened, tx: buy.tx, amount_sol: amountSol, budget_warning: budgetWarning };
  } catch (error) {
    log("spot_state_error", `Buy ${buy.tx} finalized but state confirmation failed: ${error.message}`);
    return {
      success: true,
      trade_status: "buy_confirmed_state_pending",
      pending: true,
      tx: buy.tx,
      reason: `Buy finalized, but state requires reconciliation: ${error.message}`,
    };
  }
}

async function reconcileSpotOpening(position, deps) {
  const beforeRawText = String(position.tokenRawBalanceBefore ?? "");
  if (!/^[0-9]+$/.test(beforeRawText)) {
    return { position, reconciled: false, reason: "Opening state lacks a valid pre-buy token balance." };
  }
  const [tokenAfter, solAfter] = await Promise.all([
    deps.getTokenBalanceByMint(position.mint),
    deps.getTokenBalanceByMint(SOL_MINT),
  ]);
  const acquiredRaw = BigInt(String(tokenAfter.raw_amount || "0")) - BigInt(beforeRawText);
  if (acquiredRaw <= 0n) {
    return { position, reconciled: false, reason: "No finalized token increase is visible yet." };
  }
  const acquired = atomicToUiAmount(acquiredRaw, tokenAfter.decimals);
  let measuredCost;
  try {
    measuredCost = measuredSpotEntryCost(position.solBalanceBefore, solAfter.amount, deps.spotConfig);
  } catch (error) {
    return { position, reconciled: false, reason: error.message };
  }
  let prices = {};
  try {
    prices = await deps.getJupiterPrices([position.mint, SOL_MINT]);
  } catch (error) {
    log("spot_price_warn", `Reconciled spot buy without entry price metadata: ${error.message}`);
  }
  const opened = deps.confirmSpotOpen(position.id, {
    tokenAmount: acquired,
    tokenRawAmount: acquiredRaw.toString(),
    tokenDecimals: tokenAfter.decimals,
    entryTokenUsd: safeNumber(prices?.[position.mint]?.usdPrice),
    entrySolUsd: safeNumber(prices?.[SOL_MINT]?.usdPrice),
    entryCostSol: measuredCost,
    buyTx: position.buyTx || null,
  });
  log("spot", `Reconciled finalized spot entry ${opened.id} from wallet balances`);
  return { position: opened, reconciled: true, reason: "Finalized token balance proves the buy landed." };
}

export async function getSpotPositionSnapshot(_args = {}, overrides = {}) {
  const deps = spotDeps(overrides);
  let position = deps.readSpotPosition();
  if (!position) return { position: null, status: "none" };
  if (position.status === "opening") {
    try {
      const reconciliation = await reconcileSpotOpening(position, deps);
      if (!reconciliation.reconciled) {
        return { position, status: "opening", priceable: false, reason: reconciliation.reason };
      }
      position = reconciliation.position;
    } catch (error) {
      return { position, status: "opening", priceable: false, reason: `Opening reconciliation failed: ${error.message}` };
    }
  }
  if (position.status !== "open") return { position, status: position.status, priceable: false };

  const [balance, activeBinResult] = await Promise.all([
    deps.getTokenBalanceByMint(position.mint),
    deps.getActiveBin({ pool_address: position.pool })
      .then((value) => ({ value, error: null }))
      .catch((error) => ({ value: null, error })),
  ]);
  const trackedRaw = BigInt(String(position.tokenRawAmount || "0"));
  const walletRaw = BigInt(String(balance.raw_amount || "0"));
  if (trackedRaw <= 0n || walletRaw < trackedRaw) {
    return { position, status: "open", priceable: false, reason: "Finalized wallet balance is below the position's tracked token amount; reconciliation is required." };
  }
  const trackedTokenAmount = atomicToUiAmount(trackedRaw, position.tokenDecimals);
  const activeBinPrice = safeNumber(activeBinResult.value?.price);
  let currentValueSol;
  let tokenPrice = null;
  let solPrice = null;
  let priceSource;
  let blockLag = null;
  let activeBinId = null;
  let poolPriceSolPerToken = null;

  if (activeBinPrice != null && activeBinPrice > 0) {
    currentValueSol = trackedTokenAmount * activeBinPrice;
    priceSource = "meteora_active_bin_confirmed";
    activeBinId = safeNumber(activeBinResult.value?.binId);
    poolPriceSolPerToken = activeBinPrice;
  } else {
    const [prices, finalizedSlot] = await Promise.all([
      deps.getJupiterPrices([position.mint, SOL_MINT]),
      deps.getFinalizedSlot(),
    ]);
    tokenPrice = safeNumber(prices?.[position.mint]?.usdPrice);
    solPrice = safeNumber(prices?.[SOL_MINT]?.usdPrice);
    const tokenBlock = safeNumber(prices?.[position.mint]?.blockId);
    const solBlock = safeNumber(prices?.[SOL_MINT]?.blockId);
    if (tokenPrice == null || tokenPrice <= 0 || solPrice == null || solPrice <= 0 || tokenBlock == null || solBlock == null) {
      return { position, status: "open", priceable: false, reason: `Meteora active-bin price was unavailable${activeBinResult.error ? ` (${activeBinResult.error.message})` : ""}, and Jupiter declined to provide a trustworthy fallback price.` };
    }
    const rawBlockLag = finalizedSlot - Math.min(tokenBlock, solBlock);
    blockLag = Math.max(0, rawBlockLag);
    // Price V3 may observe a recent confirmed slot ahead of this RPC's finalized
    // root. That is fresh (lag 0), not stale; only an older price is rejected.
    if (!Number.isFinite(rawBlockLag) || rawBlockLag > deps.spotConfig.maxPriceBlockLag) {
      return { position, status: "open", priceable: false, reason: `Jupiter fallback price is stale by ${rawBlockLag} slots.` };
    }
    currentValueSol = (trackedTokenAmount * tokenPrice) / solPrice;
    priceSource = "jupiter_price_v3_fallback";
  }
  const exit = evaluateSpotExit({ position, currentValueSol, now: deps.now(), policy: deps.spotConfig });
  const updated = deps.updateSpotObservation(position.id, {
    pnlPct: exit.pnlPct,
    peakPnlPct: exit.peakPnlPct,
    currentValueSol,
  });
  return {
    position: updated,
    status: "open",
    priceable: true,
    token_balance: { ...balance, position_amount: trackedTokenAmount, position_raw_amount: trackedRaw.toString() },
    token_price_usd: tokenPrice,
    sol_price_usd: solPrice,
    pool_price_sol_per_token: poolPriceSolPerToken,
    current_value_sol: currentValueSol,
    pnl_pct: exit.pnlPct,
    peak_pnl_pct: exit.peakPnlPct,
    exit,
    price_source: priceSource,
    active_bin_id: activeBinId,
    block_lag: blockLag,
  };
}

export async function closeSpotPosition({ reason = "manual spot close" } = {}, overrides = {}) {
  const deps = spotDeps(overrides);
  const position = deps.readSpotPosition();
  if (!position) return { success: false, blocked: true, reason: "No spot position is open." };
  if (position.status !== "open") return { success: false, blocked: true, pending: true, reason: `Spot position ${position.id} is ${position.status}.` };
  if (deps.dryRun) {
    return { success: true, dry_run: true, would_close: { id: position.id, mint: position.mint, reason }, message: "DRY RUN — no spot sell sent" };
  }

  const [tokenBefore, solBefore] = await Promise.all([
    deps.getTokenBalanceByMint(position.mint),
    deps.getTokenBalanceByMint(SOL_MINT),
  ]);
  const trackedRaw = BigInt(String(position.tokenRawAmount || "0"));
  const walletRawBefore = BigInt(String(tokenBefore.raw_amount || "0"));
  if (trackedRaw <= 0n || walletRawBefore < trackedRaw) {
    return { success: false, blocked: true, reason: "Finalized RPC shows no token balance to sell; manual reconciliation is required." };
  }
  const executionPolicy = spotExitExecutionPolicy(reason, position, deps.spotConfig);
  deps.markSpotClosing(position.id, {
    reason,
    solBalanceBeforeClose: solBefore.amount,
    tokenBalanceBeforeClose: tokenBefore.amount,
  });
  const trackedAmount = atomicToUiAmount(trackedRaw, position.tokenDecimals);
  const sell = await deps.sellSpotToken({
    mint: position.mint,
    amount: trackedAmount,
    rawAmount: trackedRaw.toString(),
    ...executionPolicy,
  });
  if (sell?.success !== true) {
    if (!sell?.submission_attempted) deps.restoreSpotOpen(position.id, sell?.error || "sell rejected before submission");
    return {
      success: false,
      blocked: true,
      pending: sell?.submission_attempted === true,
      reason: sell?.submission_attempted
        ? `Spot sell outcome is uncertain; state remains closing: ${sell?.error || "unknown error"}`
        : sell?.error || "Spot sell failed before submission.",
      tx: sell?.tx || null,
    };
  }

  const [tokenAfter, solAfter] = await Promise.all([
    deps.getTokenBalanceByMint(position.mint),
    deps.getTokenBalanceByMint(SOL_MINT),
  ]);
  const walletRawAfter = BigInt(String(tokenAfter.raw_amount || "0"));
  const consumedRaw = walletRawBefore - walletRawAfter;
  if (consumedRaw < trackedRaw) {
    const residualRaw = trackedRaw - (consumedRaw > 0n ? consumedRaw : 0n);
    deps.updateSpotTokenBalance(position.id, {
      amount: atomicToUiAmount(residualRaw, position.tokenDecimals),
      raw_amount: residualRaw.toString(),
      decimals: position.tokenDecimals,
    });
    return { success: false, pending: true, reason: "Sell finalized but part of the tracked position remains; state stays closing for manual reconciliation.", tx: sell.tx };
  }
  const measuredExitSol = solAfter.amount - solBefore.amount;
  const fallbackExitSol = safeNumber(sell.output_amount_atomic, 0) / 1_000_000_000;
  const exitSol = measuredExitSol > 0 ? measuredExitSol : fallbackExitSol;
  const pnlSol = exitSol - Number(position.entryCostSol);
  const pnlPct = calculateSpotPnlPct(position.entryCostSol, exitSol);
  try {
    deps.recordSpotRealizedPnl({ pnlSol });
  } catch (error) {
    log("spot_risk_error", `Sell ${sell.tx} finalized but realized PnL could not be recorded: ${error.message}`);
    return {
      success: true,
      pending: true,
      trade_status: "sell_confirmed_state_pending",
      tx: sell.tx,
      exit_sol: exitSol,
      pnl_sol: pnlSol,
      pnl_pct: pnlPct,
      reason: `Sell finalized, but risk-budget reconciliation is required before the position can be cleared: ${error.message}`,
    };
  }
  let closed;
  try {
    closed = deps.completeSpotClose(position.id, {
      sellTx: sell.tx,
      exitSol,
      pnlSol,
      pnlPct,
      reason,
    });
  } catch (error) {
    log("spot_state_error", `Sell ${sell.tx} and risk-budget record succeeded, but close state could not be finalized: ${error.message}`);
    return {
      success: true,
      pending: true,
      trade_status: "sell_confirmed_state_pending",
      tx: sell.tx,
      exit_sol: exitSol,
      pnl_sol: pnlSol,
      pnl_pct: pnlPct,
      reason: `Sell and risk-budget record succeeded, but spot state requires reconciliation: ${error.message}`,
    };
  }
  deps.appendDecision({
    type: "spot_close",
    actor: "MANAGER",
    pool: closed.pool,
    pool_name: closed.poolName,
    position: closed.id,
    summary: `Closed ${closed.symbol} at ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
    reason,
    metrics: { entryCostSol: closed.entryCostSol, exitSol, pnlSol, pnlPct },
  });
  return { success: true, trade_status: "closed", position: closed, tx: sell.tx, exit_sol: exitSol, pnl_sol: pnlSol, pnl_pct: pnlPct };
}

export function getSpotStatus(_args = {}, overrides = {}) {
  const deps = spotDeps(overrides);
  const riskBudget = deps.getSpotRiskBudget({
    maxDailyBuySol: deps.spotConfig.maxDailyBuySol,
    maxDailyLossSol: deps.spotConfig.maxDailyLossSol,
  });
  const usedBuySol = Number(riskBudget.boughtSol || 0) + Number(riskBudget.reservedSol || 0);
  const buyCap = deps.spotConfig.maxDailyBuySol;
  const lossBlocked = Number(riskBudget.realizedPnlSol || 0) <= -deps.spotConfig.maxDailyLossSol + Number.EPSILON;
  const turnoverBlocked = buyCap != null && usedBuySol + deps.spotConfig.tradeAmountSol > buyCap + 1e-9;
  const riskReason = lossBlocked
    ? `Daily realized loss ${Number(riskBudget.realizedPnlSol).toFixed(6)} SOL reached the ${deps.spotConfig.maxDailyLossSol.toFixed(6)} SOL cap`
    : turnoverBlocked
    ? `Daily buy turnover ${usedBuySol.toFixed(6)} SOL leaves insufficient room for the fixed ${deps.spotConfig.tradeAmountSol.toFixed(6)} SOL entry`
    : null;
  return {
    mode: deps.tradingMode,
    position: deps.readSpotPosition(),
    realtime: getSpotRealtimeTelemetry(),
    recent_trades: deps.getSpotHistory(10),
    risk_budget: {
      ...riskBudget,
      usedBuySol,
      remainingBuySol: buyCap == null ? null : Math.max(0, buyCap - usedBuySol),
      blocked: Boolean(riskReason),
      reason: riskReason,
    },
  };
}
