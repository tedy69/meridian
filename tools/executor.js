import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getTokenBalanceByMint, getWalletBalances, normalizeMint, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getAllPerformanceRecords, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import {
  completePendingAutoSwap,
  getPendingAutoSwaps,
  queuePendingAutoSwap,
  recordPendingAutoSwapAttempt,
  setPositionInstruction,
} from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { confirmIndicatorPreset } from "./chart-indicators.js";
import {
  config,
  getCircuitAdjustedDeploySizing,
  reloadScreeningThresholds,
  MIN_SAFE_BINS_BELOW,
} from "../config.js";
import { getRecentDecisions } from "../decision-log.js";
import fs from "fs";
import { execSync, spawn } from "child_process";
import { REPO_ROOT, repoPath } from "../repo-root.js";
import { normalizeTimeframe, scaleScreeningToTimeframe } from "../screening-scales.js";
import { evaluateFreshPoolRisk, evaluateLossCircuitBreaker, evaluateTokenAuditRisk } from "../risk-intelligence.js";
import {
  assertAutonomousSwapAllowed,
  assertLiveTradingEnabled,
  assertNoPendingCloseSettlement,
  isDryRun,
} from "../execution-guard.js";
import { evaluateAutoSwapBalance } from "../close-settlement.js";
import {
  commitDailyDeployReservation,
  reserveDailyDeploy,
} from "../execution-budget.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
import { log, logAction } from "../logger.js";
import { notifyAutoSwapPending, notifyDeploy, notifyClose, notifySwap } from "../telegram.js";

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

function compactMomentumIntervals(momentum) {
  if (!Array.isArray(momentum?.intervals)) return [];

  const optionalNumber = (value) => {
    if (value == null || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  return momentum.intervals
    .filter((entry) => entry?.ok === true)
    .map((entry) => {
      const signal = entry.signal || {};
      const close = optionalNumber(signal.close);
      const previousClose = optionalNumber(signal.previousClose);
      const supertrendValue = optionalNumber(signal.supertrendValue);
      return {
        interval: entry.interval,
        confirmed: entry.confirmed === true,
        rsi: optionalNumber(signal.rsi),
        supertrend_direction: String(signal.supertrendDirection || "unknown"),
        close_above_trend: Number.isFinite(close) && Number.isFinite(supertrendValue)
          ? close >= supertrendValue
          : null,
        rising_candle: Number.isFinite(close) && Number.isFinite(previousClose)
          ? close > previousClose
          : null,
        supertrend_break_up: signal.supertrendBreakUp === true,
      };
    });
}

function buildEntrySignalSnapshot({ poolRisk, tokenAudit, momentum, momentumPreset }) {
  const snapshot = {
    base_mint: poolRisk.baseMint,
    organic_score: poolRisk.metrics.baseOrganic,
    quote_organic_score: poolRisk.metrics.quoteOrganic,
    fee_tvl_ratio: poolRisk.metrics.feeActiveTvlRatio,
    volume_active_tvl_ratio: poolRisk.metrics.volumeActiveTvlRatio,
    volatility: poolRisk.metrics.volatility,
    ...poolRisk.entryMarketData,
    token_global_fees_sol: tokenAudit.metrics?.globalFeesSol ?? null,
    token_top10_pct: tokenAudit.metrics?.top10Pct ?? null,
    token_bot_holders_pct: tokenAudit.metrics?.botHoldersPct ?? null,
  };

  if (momentum) {
    snapshot.momentum_preset = momentum.preset ?? momentumPreset;
    snapshot.momentum_confirmed = momentum.confirmed === true;
    snapshot.momentum_intervals = compactMomentumIntervals(momentum);
  }

  return snapshot;
}

export async function validateDeployPoolThresholds(args, {
  screening = config.screening,
  indicators = config.indicators,
  fetchPoolDetail = fetchFreshPoolDetail,
  fetchTokenInfo = getTokenInfo,
  fetchIndicatorConfirmation = confirmIndicatorPreset,
} = {}) {
  const sourceTimeframe = screening.timeframe || "5m";
  let detail;
  try {
    detail = await fetchPoolDetail(args.pool_address, sourceTimeframe);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${error.message}`,
    };
  }

  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);
  let volatilityDetail = detail;
  if (sourceTimeframe !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchPoolDetail(args.pool_address, volatilityTimeframe);
      if (!volatilityDetail) throw new Error(`Pool ${args.pool_address} not found`);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
      };
    }
  }

  const poolRisk = evaluateFreshPoolRisk({
    detail,
    volatility: volatilityDetail?.volatility,
    volatilityTimeframe,
    screening,
  });
  if (!poolRisk.pass) return poolRisk;

  if (!poolRisk.baseMint && (screening.requireTokenAudit ?? true)) {
    return { pass: false, reason: "Could not identify the base mint for fresh token audit." };
  }

  let tokenInfo = null;
  if (poolRisk.baseMint) {
    try {
      const tokenResult = await fetchTokenInfo({ query: poolRisk.baseMint });
      tokenInfo = tokenResult?.results?.[0] ?? null;
    } catch (error) {
      return {
        pass: false,
        reason: `Could not refresh token audit before deploy: ${error.message}`,
      };
    }
  }
  const tokenAudit = evaluateTokenAuditRisk(tokenInfo, screening, { expectedMint: poolRisk.baseMint });
  if (!tokenAudit.pass) return tokenAudit;

  let momentum = null;
  if (indicators.enabled) {
    if (!poolRisk.baseMint) {
      return { pass: false, reason: "Could not identify the base mint for fresh entry-momentum confirmation." };
    }
    try {
      momentum = await fetchIndicatorConfirmation({
        mint: poolRisk.baseMint,
        side: "entry",
        preset: indicators.entryPreset,
        intervals: indicators.intervals,
        refresh: true,
      });
    } catch (error) {
      return {
        pass: false,
        reason: `Could not refresh entry momentum before deploy: ${error.message}`,
      };
    }
    const failClosed = indicators.entryFailClosed ?? true;
    if (momentum?.confirmed !== true || (failClosed && momentum?.skipped === true)) {
      return {
        pass: false,
        reason: `Entry momentum is not confirmed: ${momentum?.reason || "fresh indicator evidence is unavailable"}.`,
        momentum,
      };
    }
  }

  return {
    pass: true,
    trustedPoolArgs: {
      base_mint: poolRisk.baseMint,
      bin_step: poolRisk.metrics.binStep,
      volatility: poolRisk.metrics.volatility,
      fee_tvl_ratio: poolRisk.metrics.feeActiveTvlRatio,
      organic_score: poolRisk.metrics.baseOrganic,
    },
    entryMarketData: poolRisk.entryMarketData,
    entrySignalSnapshot: buildEntrySignalSnapshot({
      poolRisk,
      tokenAudit,
      momentum,
      momentumPreset: indicators.entryPreset,
    }),
    riskMetrics: {
      pool: poolRisk.metrics,
      tokenAudit: tokenAudit.metrics,
      momentum,
    },
  };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

function coerceBoolean(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`${key} must be true or false`);
}

function coerceFiniteNumber(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a finite number`);
  return n;
}

function coerceString(value, key) {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
}

function coerceStringArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map((entry) => coerceString(entry, key)).filter(Boolean);
}

export function normalizeConfigValue(key, value) {
  const booleanKeys = new Set([
    "excludeHighSupplyConcentration",
    "useDiscordSignals",
    "avoidPvpSymbols",
    "blockPvpSymbols",
    "requireTokenAudit",
    "autoSwapAfterClaim",
    "repeatDeployCooldownEnabled",
    "trailingTakeProfit",
    "solMode",
    "darwinEnabled",
    "lpAgentRelayEnabled",
    "opportunityPollEnabled",
    "chartIndicatorsEnabled",
    "requireAllIntervals",
    "entryFailClosed",
  ]);
  const arrayKeys = new Set(["allowedLaunchpads", "blockedLaunchpads", "indicatorIntervals"]);
  const stringKeys = new Set([
    "timeframe",
    "category",
    "discordSignalMode",
    "strategy",
    "managementModel",
    "screeningModel",
    "generalModel",
    "hiveMindUrl",
    "hiveMindApiKey",
    "agentId",
    "hiveMindPullMode",
    "publicApiKey",
    "agentMeridianApiUrl",
    "pnlSource",
    "pnlRpcUrl",
    "gmgnFeeSource",
    "gmgnApiKey",
    "repeatDeployCooldownScope",
    "indicatorEntryPreset",
    "indicatorExitPreset",
  ]);
  if (value === null) return null;
  if (booleanKeys.has(key)) return coerceBoolean(value, key);
  if (arrayKeys.has(key)) return coerceStringArray(value, key);
  if (stringKeys.has(key)) return coerceString(value, key);
  if (key === "stopLossConfirmTicks") {
    const ticks = coerceFiniteNumber(value, key);
    if (!Number.isInteger(ticks) || ticks < 1) throw new Error(`${key} must be a positive integer`);
    return ticks;
  }
  return coerceFiniteNumber(value, key);
}

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        if (!process.env.pm_id) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: REPO_ROOT,
          });
          child.unref();
        }
        process.exit(0);
      }, 3000);
      const restartMode = process.env.pm_id
        ? "PM2 detected — exiting in 3s so PM2 can restart the managed process."
        : "Restarting in 3s...";
      return { success: true, updated: true, message: `Updated! ${restartMode}\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    if (!config.security.allowAgentConfigMutation) {
      return {
        success: false,
        blocked: true,
        error: "Agent configuration mutation is disabled. Edit user-config.json manually after review.",
        reason,
      };
    }

    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minVolumeActiveTvlRatio: ["screening", "minVolumeActiveTvlRatio"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      loneCandidateMinDegen: ["screening", "loneCandidateMinDegen"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      autoSwapRetryAttempts: ["management", "autoSwapRetryAttempts"],
      autoSwapRetryDelayMs: ["management", "autoSwapRetryDelayMs"],
      autoSwapSlippageBps: ["management", "autoSwapSlippageBps"],
      closeSlippageBps: ["management", "closeSlippageBps"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      stopLossTriggerPct: ["management", "stopLossTriggerPct"],
      stopLossConfirmTicks: ["management", "stopLossConfirmTicks"],
      stopLossCooldownHours: ["management", "stopLossCooldownHours"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      trailingMinClosePnlPct: ["management", "trailingMinClosePnlPct"],
      trailingLossCooldownHours: ["management", "trailingLossCooldownHours"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      // pnl poller
      pnlConfirmTicks: ["pnl", "confirmTicks"],
      // opportunity poller (interval/enabled changes apply on next restart)
      opportunityPollEnabled: ["opportunity", "enabled"],
      opportunityPollIntervalSec: ["opportunity", "pollIntervalSec"],
      opportunityDecisionMinIntervalSec: ["opportunity", "decisionMinIntervalSec"],
      opportunityPollLimit: ["opportunity", "limit"],
      opportunityMinScore: ["opportunity", "minScore"],
      opportunitySmartWalletBonus: ["opportunity", "smartWalletScoreBonus"],
      degenTargetVolRatio: ["opportunity", "targetVolRatio"],
      degenTargetLpCount: ["opportunity", "targetLpCount"],
      degenTargetFeeRatio: ["opportunity", "targetFeeRatio"],
      degenTargetLiquidity: ["opportunity", "targetLiquidity"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      lossCircuitStreakCooldownHours: ["risk", "lossCircuitStreakCooldownHours"],
      lossCircuitRollingCooldownHours: ["risk", "lossCircuitRollingCooldownHours"],
      lossCircuitSingleCooldownHours: ["risk", "lossCircuitSingleCooldownHours"],
      lossCircuitRecoverySizePct: ["risk", "lossCircuitRecoverySizePct"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      // strategy
      strategy: ["strategy", "strategy"],
      binsBelow: ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      defaultBinsBelow: ["strategy", "defaultBinsBelow"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // pnl fetcher / poller
      pnlSource: ["pnl", "source", ["pnlSource"]],
      pnlRpcUrl: ["pnl", "rpcUrl", ["pnlRpcUrl"]],
      pnlPollIntervalSec: ["pnl", "pollIntervalSec", ["pnlPollIntervalSec"]],
      pnlDepositCacheTtlSec: ["pnl", "depositCacheTtlSec", ["pnlDepositCacheTtlSec"]],
      // gmgn fee source
      gmgnFeeSource: ["gmgn", "feeSource", ["gmgnFeeSource"]],
      gmgnApiKey: ["gmgn", "apiKey", ["gmgnApiKey"]],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      entryRsiMin: ["indicators", "entryRsiMin", ["chartIndicators", "entryRsiMin"]],
      entryRsiMax: ["indicators", "entryRsiMax", ["chartIndicators", "entryRsiMax"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
      entryFailClosed: ["indicators", "entryFailClosed", ["chartIndicators", "entryFailClosed"]],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return { success: false, error: "changes must be an object", reason };
    }

    const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);
    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      try {
        let normalizedVal = val;
        if (STRATEGY_BIN_KEYS.has(match[0])) {
          const numericVal = Number(val);
          if (!Number.isFinite(numericVal)) {
            throw new Error(`${match[0]} must be a finite number`);
          }
          normalizedVal = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numericVal));
        } else {
          normalizedVal = normalizeConfigValue(match[0], val);
        }
        applied[match[0]] = normalizedVal;
      } catch (error) {
        return { success: false, error: error.message, key: match[0], reason };
      }
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    const changesStopLossPolicy = applied.stopLossPct != null || applied.stopLossTriggerPct != null;
    if (changesStopLossPolicy) {
      const maximumPnlPct = Number(applied.stopLossPct ?? config.management.stopLossPct);
      const triggerPnlPct = Number(applied.stopLossTriggerPct ?? config.management.stopLossTriggerPct);
      if (!Number.isFinite(maximumPnlPct) || !Number.isFinite(triggerPnlPct) || maximumPnlPct >= 0 || triggerPnlPct >= 0 || triggerPnlPct <= maximumPnlPct) {
        return {
          success: false,
          error: "stopLossTriggerPct must be below 0 and above stopLossPct (for example trigger -8 with target max -15).",
          reason,
        };
      }
    }

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      } catch (error) {
        return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
      }
    }

    // Auto-scale fee/volume when timeframe changes (unless user set them explicitly in same call).
    if (applied.timeframe != null && applied.minFeeActiveTvlRatio == null && applied.minVolume == null) {
      const tf = normalizeTimeframe(applied.timeframe);
      applied.timeframe = tf;
      const scaled = scaleScreeningToTimeframe(tf);
      applied.minFeeActiveTvlRatio = scaled.minFeeActiveTvlRatio;
      applied.minVolume = scaled.minVolume;
      applied._timeframeScaled = true;
      log("config", `timeframe ${tf} → auto-scaled minFeeActiveTvlRatio=${scaled.minFeeActiveTvlRatio}, minVolume=${scaled.minVolume}`);
    }

    // Apply to live config immediately after the persisted config is known-good.
    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }
    if (
      applied.binsBelow != null ||
      applied.minBinsBelow != null ||
      applied.maxBinsBelow != null ||
      applied.defaultBinsBelow != null
    ) {
      config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)));
      config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)));
      config.strategy.defaultBinsBelow = Math.max(
        config.strategy.minBinsBelow,
        Math.min(
          config.strategy.maxBinsBelow,
          Math.round(Number(config.strategy.defaultBinsBelow ?? config.strategy.maxBinsBelow)),
        ),
      );
    }

    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const persistPath = CONFIG_MAP[key]?.[2];
      if (Array.isArray(persistPath) && persistPath.length > 0) {
        let target = userConfig;
        for (const part of persistPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[persistPath[persistPath.length - 1]] = val;
      } else {
        userConfig[key] = val;
      }
    }
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null || applied.pnlPollIntervalSec != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m, pnlPoll: ${config.pnl.pollIntervalSec}s`);
    }

    // Skip repeated volatility-driven interval changes; they are operational tuning, not reusable lessons.
    const lessonsKeys = Object.keys(applied).filter(
      k => !k.startsWith("_") && k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
  "update_config",
]);

const MANUAL_ONLY_CONFIG_KEYS = new Set([
  "maxPositions",
  "maxDeployAmount",
  "maxDailyDeploySol",
  "minClaimAmount",
  "autoSwapAfterClaim",
  "autoSwapRetryAttempts",
  "autoSwapRetryDelayMs",
  "autoSwapSlippageBps",
  "closeSlippageBps",
  "outOfRangeBinsToClose",
  "outOfRangeWaitMinutes",
  "oorCooldownTriggerCount",
  "oorCooldownHours",
  "repeatDeployCooldownEnabled",
  "repeatDeployCooldownTriggerCount",
  "repeatDeployCooldownHours",
  "repeatDeployCooldownScope",
  "repeatDeployCooldownMinFeeEarnedPct",
  "minVolumeToRebalance",
  "stopLossPct",
  "stopLossTriggerPct",
  "stopLossConfirmTicks",
  "stopLossCooldownHours",
  "takeProfitPct",
  "takeProfitFeePct",
  "trailingTakeProfit",
  "trailingTriggerPct",
  "trailingDropPct",
  "trailingMinClosePnlPct",
  "trailingLossCooldownHours",
  "pnlSanityMaxDiffPct",
  "minSolToOpen",
  "deployAmountSol",
  "gasReserve",
  "positionSizePct",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let _autoSwapDrainPromise = null;

/**
 * Swap a base token back to SOL with retry. Balance reads are direct finalized
 * RPC reads, not an indexer/USD-price view, so an unavailable token index can
 * never be mistaken for a completed settlement.
 */
async function swapBaseToSolWithRetry(baseMint, label, { onFailure = null } = {}) {
  const normalizedMint = normalizeMint(baseMint);
  if (!normalizedMint) {
    return { settled: false, swapped: false, error: "Missing base-token mint" };
  }
  if (normalizedMint === config.tokens.SOL) {
    return {
      settled: true,
      swapped: false,
      settlement_status: "settled_in_sol",
      balance: null,
    };
  }

  const attempts = Math.max(1, Number(config.management.autoSwapRetryAttempts ?? 3));
  const delayMs = Math.max(0, Number(config.management.autoSwapRetryDelayMs ?? 3000));
  let lastError = null;
  let lastBalance = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let observedAmount = null;
    try {
      const balance = await getTokenBalanceByMint(normalizedMint);
      lastBalance = balance;
      observedAmount = balance.amount;
      const balanceDecision = evaluateAutoSwapBalance({
        balanceReadSucceeded: true,
        amount: balance.amount,
      });
      if (balanceDecision.action === "settled") {
        return {
          settled: true,
          swapped: false,
          settlement_status: balanceDecision.settlement_status,
          balance,
        };
      }

      log("executor", `Auto-swapping ${label} ${normalizedMint.slice(0, 8)} (${balance.amount}) back to SOL (attempt ${attempt}/${attempts})`);
      const swapResult = await swapToken({
        input_mint: normalizedMint,
        output_mint: "SOL",
        amount: balance.amount,
        slippage_bps: config.management.autoSwapSlippageBps,
      });
      const swapFinalized = swapResult?.success === true && swapResult?.finalized === true && !!swapResult.tx;
      if (!swapFinalized) {
        lastError = swapResult?.error || swapResult?.reason || "swap did not finalize";
      } else {
        const remaining = await getTokenBalanceByMint(normalizedMint);
        lastBalance = remaining;
        observedAmount = remaining.amount;
        const remainingDecision = evaluateAutoSwapBalance({
          balanceReadSucceeded: true,
          amount: remaining.amount,
        });
        if (remainingDecision.action === "settled") {
          return {
            settled: true,
            swapped: true,
            settlement_status: "settled_to_sol",
            result: swapResult,
            balance: remaining,
          };
        }
        lastError = `Swap finalized but ${remaining.amount} ${normalizedMint.slice(0, 8)} remains on finalized RPC`;
      }
    } catch (error) {
      lastError = error.message;
    }

    log("executor_warn", `Auto-swap ${label} attempt ${attempt}/${attempts} failed: ${lastError}`);
    if (onFailure) {
      await onFailure({ error: lastError, observed_amount: observedAmount });
    }
    if (attempt < attempts) await sleep(delayMs);
  }

  log("executor_warn", `Auto-swap ${label} failed after ${attempts} attempts — base token remains pending (${normalizedMint.slice(0, 8)})`);
  return {
    settled: false,
    swapped: false,
    error: lastError || "autoswap did not settle",
    balance: lastBalance,
  };
}

async function settleQueuedAutoSwap(entry, label) {
  const outcome = await swapBaseToSolWithRetry(entry.base_mint, label, {
    onFailure: ({ error, observed_amount }) => {
      recordPendingAutoSwapAttempt(entry.key, { error, observed_amount });
    },
  });
  if (outcome.settled) {
    completePendingAutoSwap(entry.key, {
      settlement_status: outcome.settlement_status,
      tx: outcome.result?.tx || null,
      observed_amount: outcome.balance?.amount ?? null,
    });
  }
  return outcome;
}

/**
 * Drain persisted close settlements. It is invoked by the management loop even
 * when no LP positions remain, so an outage/restart cannot strand base tokens.
 */
export async function drainPendingAutoSwaps() {
  if (_autoSwapDrainPromise) return _autoSwapDrainPromise;
  _autoSwapDrainPromise = (async () => {
    const pending = getPendingAutoSwaps();
    if (pending.length === 0) {
      return { processed: 0, settled: 0, pending: 0, results: [] };
    }
    if (isDryRun()) {
      return {
        processed: 0,
        settled: 0,
        pending: pending.length,
        results: [],
        skipped: "dry_run",
      };
    }

    const results = [];
    for (const entry of pending) {
      const outcome = await settleQueuedAutoSwap(entry, "queued close settlement");
      results.push({ key: entry.key, position: entry.position_address, ...outcome });
    }
    return {
      processed: pending.length,
      settled: results.filter((result) => result.settled).length,
      pending: getPendingAutoSwaps().length,
      results,
    };
  })();
  try {
    return await _autoSwapDrainPromise;
  } finally {
    _autoSwapDrainPromise = null;
  }
}

async function settleCloseToSol(result, args) {
  if (args.skip_swap) {
    result.settlement_status = "manual_hold";
    result.auto_swap_note = "Base token was intentionally kept because skip_swap=true. Do not claim it was converted to SOL.";
    return;
  }
  if (result.close_status !== "confirmed_on_chain") {
    result.settlement_status = "not_started";
    result.auto_swap_note = "Close is not confirmed on-chain, so no settlement was attempted.";
    return;
  }
  if (!result.base_mint) {
    result.settlement_status = "requires_manual_review";
    result.auto_swap_pending = true;
    result.auto_swap_note = "Close is confirmed, but the returned base-token mint is unknown. Funds are not confirmed as SOL.";
    notifyAutoSwapPending({
      position: result.position,
      baseMint: null,
      error: "Base-token mint unavailable after a confirmed close",
    }).catch(() => {});
    return;
  }

  const baseMint = normalizeMint(result.base_mint);
  if (baseMint === config.tokens.SOL) {
    result.settlement_status = "settled_in_sol";
    result.auto_swap_note = "Close proceeds are already SOL; no token swap was required.";
    return;
  }

  const pending = queuePendingAutoSwap({
    position_address: result.position || args.position_address,
    base_mint: baseMint,
    close_txs: result.close_txs || result.txs || [],
  });
  const drain = await drainPendingAutoSwaps();
  const outcome = drain.results.find((entry) => entry.key === pending.key) || {
    settled: false,
    swapped: false,
    error: "autoswap queue is being processed; retry remains pending",
  };
  result.settlement_status = outcome.settlement_status || "pending_auto_swap";
  if (outcome.settled) {
    result.auto_swapped = outcome.swapped;
    result.auto_swap_note = outcome.swapped
      ? `Base token was swapped to SOL in finalized transaction ${outcome.result?.tx || ""}. Do NOT call swap_token again.`
      : "No residual base-token balance exists at finalized commitment; no swap was required.";
    if (outcome.result?.amount_out) result.sol_received = outcome.result.amount_out;
    return;
  }

  result.auto_swapped = false;
  result.auto_swap_pending = true;
  result.auto_swap_error = outcome.error || "auto-swap remains pending";
  result.auto_swap_note = "Base token is NOT confirmed as SOL. Automatic retries are queued; do NOT state that all funds have been swapped.";
  notifyAutoSwapPending({
    position: result.position,
    baseMint,
    error: result.auto_swap_error,
  }).catch(() => {});
}

/**
 * Execute a tool call with safety checks and logging.
 */
export function logDailyDeployReservation(reservation, {
  amountSol,
  maxDailyDeploySol,
}, writeLog = log) {
  if (!reservation) {
    writeLog("budget", `Daily deploy cap disabled; ${amountSol} SOL is not reserved.`);
    return;
  }
  writeLog(
    "budget",
    `Reserved ${amountSol} SOL of ${maxDailyDeploySol} SOL daily deploy cap (${reservation.usedSol.toFixed(6)} SOL used/reserved).`,
  );
}

export async function executeTool(name, args) {
  const startTime = Date.now();
  let deployBudgetReservation = null;

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  if (WRITE_TOOLS.has(name) && !isDryRun()) {
    try {
      assertLiveTradingEnabled(name);
    } catch (error) {
      log("safety_block", `${name} blocked: ${error.message}`);
      return { blocked: true, reason: error.message };
    }
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  if (name === "deploy_position" && !isDryRun()) {
    try {
      const amountSol = Number(args?.amount_y ?? args?.amount_sol ?? 0);
      deployBudgetReservation = reserveDailyDeploy({
        amountSol,
        maxDailyDeploySol: config.risk.maxDailyDeploySol,
      });
      logDailyDeployReservation(deployBudgetReservation, {
        amountSol,
        maxDailyDeploySol: config.risk.maxDailyDeploySol,
      });
    } catch (error) {
      log("safety_block", `deploy_position blocked: ${error.message}`);
      return { blocked: true, reason: error.message };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    if (deployBudgetReservation) {
      try {
        const committed = commitDailyDeployReservation(deployBudgetReservation);
        log(
          "budget",
          `Counted ${deployBudgetReservation.amountSol} SOL against today's deploy cap (${committed.usedSol.toFixed(6)} SOL used).`,
        );
      } catch (budgetError) {
        log("budget_error", `Could not finalize deploy budget reservation; it remains fail-closed: ${budgetError.message}`);
      }
    }
    const success = result?.success !== false && !result?.error;

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
      } else if (name === "close_position") {
        notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0 }).catch(() => {});
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Persist then settle the returned base token. A close is not reported as
        // fully converted to SOL until a finalized balance check proves it.
        try {
          await settleCloseToSol(result, args);
        } catch (settlementError) {
          result.settlement_status = "requires_manual_review";
          result.auto_swap_pending = true;
          result.auto_swap_error = settlementError.message;
          result.auto_swap_note = "Close is confirmed, but auto-swap persistence failed. Funds are NOT confirmed as SOL.";
          notifyAutoSwapPending({
            position: result.position,
            baseMint: result.base_mint,
            error: settlementError.message,
          }).catch(() => {});
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        await swapBaseToSolWithRetry(result.base_mint, "after claim");
      }
    }

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: Date.now() - startTime,
      success,
    });

    return result;
  } catch (error) {
    if (deployBudgetReservation) {
      try {
        const committed = commitDailyDeployReservation(deployBudgetReservation);
        log(
          "budget_warn",
          `Deploy ended with an error; conservatively counted ${deployBudgetReservation.amountSol} SOL against today's cap (${committed.usedSol.toFixed(6)} SOL used).`,
        );
      } catch (budgetError) {
        log("budget_error", `Could not finalize uncertain deploy budget reservation; it remains fail-closed: ${budgetError.message}`);
      }
    }
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
export async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      const pendingAutoSwaps = getPendingAutoSwaps();
      try {
        assertNoPendingCloseSettlement(pendingAutoSwaps);
      } catch (error) {
        return {
          pass: false,
          reason: error.message,
        };
      }
      let lossCircuit;
      try {
        lossCircuit = evaluateLossCircuitBreaker({
          performance: getAllPerformanceRecords(),
          policy: config.risk,
        });
      } catch (error) {
        return {
          pass: false,
          reason: `Cannot verify realized-loss circuit breaker: ${error.message}`,
        };
      }
      if (!lossCircuit.pass) {
        return {
          pass: false,
          reason: `Realized-loss circuit breaker: ${lossCircuit.reason}`,
          blocked_until: lossCircuit.blockedUntil,
          trigger: lossCircuit.trigger,
        };
      }
      const poolThresholds = await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;
      if (poolThresholds.trustedPoolArgs) Object.assign(args, poolThresholds.trustedPoolArgs);
      if (poolThresholds.entryMarketData) Object.assign(args, poolThresholds.entryMarketData);
      if (poolThresholds.entrySignalSnapshot) args.entry_signal_snapshot = poolThresholds.entrySignalSnapshot;

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove !== 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy must use bins_above=0.",
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = deployAmountY;
      if (!Number.isFinite(amountY) || amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      let minDeploy = Math.max(0.01, config.management.deployAmountSol);
      let balance = null;
      let allowedSizing = null;
      if (!isDryRun()) {
        balance = await getWalletBalances();
        allowedSizing = getCircuitAdjustedDeploySizing(balance.sol, lossCircuit);
        if (!allowedSizing.funded) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL; less than 0.01 SOL remains after ${allowedSizing.reserve} SOL gas reserve.`,
          };
        }
        minDeploy = allowedSizing.minimumAmount;
      }
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount for the current wallet (${minDeploy} SOL).`,
        };
      }
      if (config.risk.maxDeployAmount !== null && amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }
      if (allowedSizing && amountY > allowedSizing.maximumAmount + Number.EPSILON) {
        return {
          pass: false,
          reason: allowedSizing.recoveryMode
            ? `Recovery mode caps this deploy at ${allowedSizing.maximumAmount} SOL (${(allowedSizing.recoverySizePct * 100).toFixed(0)}% of the normal ${allowedSizing.normalAmount} SOL size).`
            : `SOL amount ${amountY} exceeds the trusted backend sizing limit (${allowedSizing.maximumAmount}).`,
        };
      }

      // Check SOL balance
      if (!isDryRun()) {
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      try {
        assertAutonomousSwapAllowed({
          inputMint: normalizeMint(args?.input_mint),
          outputMint: normalizeMint(args?.output_mint),
          amount: args?.amount,
        });
      } catch (error) {
        return { pass: false, reason: error.message };
      }
      return { pass: true };
    }

    case "update_config": {
      if (!config.security.allowAgentConfigMutation) {
        return {
          pass: false,
          reason: "Agent configuration mutation is disabled. Edit user-config.json manually after review.",
        };
      }
      const requestedKeys = Object.keys(args?.changes || {});
      const manualOnly = requestedKeys.filter((key) => MANUAL_ONLY_CONFIG_KEYS.has(key));
      if (manualOnly.length > 0) {
        return {
          pass: false,
          reason: `Risk and execution settings are manual-only: ${manualOnly.join(", ")}.`,
        };
      }
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
