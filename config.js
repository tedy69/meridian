import fs from "fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";
import { getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES } from "./screening-scales.js";
import { assertNoVulnerableBigintBufferNativeBinding } from "./scripts/dependency-safety.js";

export { REPO_ROOT, repoPath, getScreeningDefaultsForTimeframe, normalizeTimeframe, scaleScreeningToTimeframe, TIMEFRAME_SCREENING_SCALES };

assertNoVulnerableBigintBufferNativeBinding();

const USER_CONFIG_PATH = repoPath("user-config.json");
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};
export const MIN_SAFE_BINS_BELOW = 35;
// Deploy amounts are rendered and submitted at two-decimal SOL precision.
// Keep a cent as the smallest useful LP amount after preserving gas.
export const MIN_DEPLOY_AMOUNT_SOL = 0.01;

function numericConfig(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const DEFAULT_STOP_LOSS_PCT = -15;
const DEFAULT_STOP_LOSS_TRIGGER_PCT = -8;

function configuredStopLossPolicy(userConfig) {
  const maximumPnlPct = numericConfig(userConfig.stopLossPct ?? userConfig.emergencyPriceDropPct) ?? DEFAULT_STOP_LOSS_PCT;
  // Existing configurations that only have stopLossPct inherit a seven-point
  // execution buffer, e.g. target -15% → trigger -8%.
  const triggerPnlPct = numericConfig(userConfig.stopLossTriggerPct) ?? (maximumPnlPct + 7);
  const valid = maximumPnlPct < 0 && triggerPnlPct < 0 && triggerPnlPct > maximumPnlPct;
  return valid
    ? { maximumPnlPct, triggerPnlPct }
    : { maximumPnlPct: DEFAULT_STOP_LOSS_PCT, triggerPnlPct: DEFAULT_STOP_LOSS_TRIGGER_PCT };
}

function positiveIntegerConfig(value, fallback) {
  const numeric = numericConfig(value);
  return numeric != null && numeric >= 1 ? Math.max(1, Math.round(numeric)) : fallback;
}

function boundedPositiveIntegerConfig(value, fallback, maximum, label) {
  if (value == null) return fallback;
  const numeric = numericConfig(value);
  if (numeric == null || !Number.isInteger(numeric) || numeric < 1 || numeric > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return numeric;
}

function positiveNumberConfig(value, fallback) {
  const numeric = numericConfig(value);
  return numeric != null && numeric > 0 ? numeric : fallback;
}

function nonNegativeNumberConfig(value, fallback) {
  const numeric = numericConfig(value);
  return numeric != null && numeric >= 0 ? numeric : fallback;
}

function fractionConfig(value, fallback) {
  const numeric = numericConfig(value);
  return numeric != null && numeric > 0 && numeric <= 1 ? numeric : fallback;
}

const legacyBinsBelow = numericConfig(u.binsBelow);
const stopLossPolicy = configuredStopLossPolicy(u);
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? MIN_SAFE_BINS_BELOW;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : 69);
const configuredDefaultBinsBelow = numericConfig(u.defaultBinsBelow) ?? legacyBinsBelow ?? configuredMaxBinsBelow;
const strategyMinBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(configuredMinBinsBelow));
const strategyMaxBinsBelow = Math.max(strategyMinBinsBelow, Math.round(configuredMaxBinsBelow));
const strategyDefaultBinsBelow = Math.max(
  strategyMinBinsBelow,
  Math.min(strategyMaxBinsBelow, Math.round(configuredDefaultBinsBelow)),
);

export function buildRiskConfig(userConfig = {}) {
  const legacyLossCircuitCooldownHours = nonNegativeNumberConfig(
    userConfig.lossCircuitCooldownHours,
    null,
  );
  return {
    maxPositions: userConfig.maxPositions ?? 1,
    // `null` deliberately disables the per-position SOL ceiling. An absent
    // value retains the conservative default.
    maxDeployAmount: userConfig.maxDeployAmount === null ? null : (userConfig.maxDeployAmount ?? 0.3),
    // `null` deliberately disables the aggregate daily deploy cap. An absent
    // value retains the conservative default.
    maxDailyDeploySol: userConfig.maxDailyDeploySol === null ? null : (userConfig.maxDailyDeploySol ?? 0.5),
    // Realized-loss circuit breaker. Values are positive loss magnitudes.
    // This gate is deterministic and cannot be overridden by an LLM decision.
    lossCircuitBreakerEnabled: userConfig.lossCircuitBreakerEnabled ?? true,
    lossCircuitWindowPositions: positiveIntegerConfig(userConfig.lossCircuitWindowPositions, 5),
    maxConsecutiveLosses: positiveIntegerConfig(userConfig.maxConsecutiveLosses, 3),
    maxRollingLossPct: numericConfig(userConfig.maxRollingLossPct) ?? 12,
    maxSingleLossPct: numericConfig(userConfig.maxSingleLossPct) ?? 12,
    // A zero-hour pause keeps loss context and reduced recovery sizing without
    // blocking the next high-quality setup. Existing explicit cooldown values
    // remain supported for backwards compatibility.
    lossCircuitCooldownHours: legacyLossCircuitCooldownHours ?? 0,
    lossCircuitStreakCooldownHours: nonNegativeNumberConfig(
      userConfig.lossCircuitStreakCooldownHours,
      legacyLossCircuitCooldownHours ?? 0,
    ),
    lossCircuitRollingCooldownHours: nonNegativeNumberConfig(
      userConfig.lossCircuitRollingCooldownHours,
      legacyLossCircuitCooldownHours ?? 0,
    ),
    lossCircuitSingleCooldownHours: nonNegativeNumberConfig(
      userConfig.lossCircuitSingleCooldownHours,
      legacyLossCircuitCooldownHours ?? 0,
    ),
    lossCircuitRecoverySizePct: fractionConfig(userConfig.lossCircuitRecoverySizePct, 0.5),
  };
}

export function buildScreeningConfig(userConfig = {}) {
  return {
    excludeHighSupplyConcentration: userConfig.excludeHighSupplyConcentration ?? true,
    // Calibrated against a 107-close production-ledger snapshot: below 0.15% fee/active-TVL,
    // organic <70, and volume <2% of active TVL were weak cohorts. These remain
    // deterministic pre-deploy gates rather than suggestions to the model.
    minFeeActiveTvlRatio: userConfig.minFeeActiveTvlRatio ?? 0.15,
    minVolumeActiveTvlRatio: userConfig.minVolumeActiveTvlRatio ?? 0.02,
    minTvl: userConfig.minTvl ?? 10_000,
    maxTvl: userConfig.maxTvl !== undefined ? userConfig.maxTvl : 150_000,
    minVolume: userConfig.minVolume ?? 500,
    minOrganic: userConfig.minOrganic ?? 70,
    minQuoteOrganic: userConfig.minQuoteOrganic ?? 60,
    minHolders: userConfig.minHolders ?? 500,
    minMcap: userConfig.minMcap ?? 150_000,
    maxMcap: userConfig.maxMcap ?? 10_000_000,
    minBinStep: userConfig.minBinStep ?? 80,
    maxBinStep: userConfig.maxBinStep ?? 125,
    maxVolatility: userConfig.maxVolatility ?? 12,
    timeframe: userConfig.timeframe ?? "5m",
    category: userConfig.category ?? "trending",
    minTokenFeesSol: userConfig.minTokenFeesSol ?? 30,
    useDiscordSignals: userConfig.useDiscordSignals ?? false,
    discordSignalMode: userConfig.discordSignalMode ?? "merge",
    avoidPvpSymbols: userConfig.avoidPvpSymbols ?? true,
    blockPvpSymbols: userConfig.blockPvpSymbols ?? false,
    maxBotHoldersPct: userConfig.maxBotHoldersPct ?? 30,
    maxTop10Pct: userConfig.maxTop10Pct ?? 60,
    requireTokenAudit: userConfig.requireTokenAudit ?? true,
    loneCandidateMinDegen: userConfig.loneCandidateMinDegen ?? 50,
    allowedLaunchpads: userConfig.allowedLaunchpads ?? [],
    blockedLaunchpads: userConfig.blockedLaunchpads ?? [],
    minTokenAgeHours: userConfig.minTokenAgeHours ?? null,
    maxTokenAgeHours: userConfig.maxTokenAgeHours ?? null,
  };
}

export function buildIndicatorConfig(userConfig = {}) {
  const indicators = userConfig.chartIndicators ?? {};
  return {
    enabled: indicators.enabled ?? true,
    entryPreset: indicators.entryPreset ?? "momentum_quality",
    exitPreset: indicators.exitPreset ?? "supertrend_break",
    rsiLength: indicators.rsiLength ?? 7,
    intervals: Array.isArray(indicators.intervals)
      ? indicators.intervals
      : ["5_MINUTE", "15_MINUTE"],
    candles: indicators.candles ?? 298,
    rsiOversold: indicators.rsiOversold ?? 30,
    rsiOverbought: indicators.rsiOverbought ?? 80,
    entryRsiMin: indicators.entryRsiMin ?? 45,
    entryRsiMax: indicators.entryRsiMax ?? 72,
    requireAllIntervals: indicators.requireAllIntervals ?? true,
    entryFailClosed: indicators.entryFailClosed ?? true,
  };
}

export function buildTradingConfig(userConfig = {}) {
  // Preserve existing installations unless they explicitly opt into spot.
  const requested = String(userConfig.tradingMode ?? "dlmm_lp").trim().toLowerCase();
  if (!["dlmm_lp", "spot_momentum"].includes(requested)) {
    throw new Error('tradingMode must be either "dlmm_lp" or "spot_momentum"');
  }
  return { mode: requested };
}

export function buildSpotConfig(userConfig = {}) {
  const tradeAmountSol = positiveNumberConfig(userConfig.spotTradeAmountSol, 0.5);
  const maxTradeAmountSol = positiveNumberConfig(userConfig.spotMaxTradeAmountSol, 0.5);
  if (tradeAmountSol > maxTradeAmountSol || maxTradeAmountSol > 0.5) {
    throw new Error("Spot trade amount and maximum must not exceed 0.5 SOL");
  }
  const gasReserveSol = positiveNumberConfig(userConfig.spotGasReserveSol, 0.2);
  const stopLossPct = numericConfig(userConfig.spotStopLossPct) ?? -5;
  const configuredStopTrigger = numericConfig(userConfig.spotStopLossTriggerPct) ?? -4;
  const stopLossTriggerPct = stopLossPct < 0 && configuredStopTrigger < 0 && configuredStopTrigger > stopLossPct
    ? configuredStopTrigger
    : -4;

  return {
    tradeAmountSol,
    maxTradeAmountSol,
    gasReserveSol,
    minWalletSol: Number((tradeAmountSol + gasReserveSol).toFixed(9)),
    maxOpenPositions: 1,
    maxDailyBuySol: positiveNumberConfig(userConfig.spotMaxDailyBuySol, 2),
    maxDailyLossSol: positiveNumberConfig(userConfig.spotMaxDailyLossSol, 0.05),

    minLiquidityUsd: positiveNumberConfig(userConfig.spotMinLiquidityUsd, 50_000),
    minVolume5mUsd: positiveNumberConfig(userConfig.spotMinVolume5mUsd, 5_000),
    minVolumeLiquidityRatio: positiveNumberConfig(userConfig.spotMinVolumeLiquidityRatio, 0.05),
    minOrganic: positiveNumberConfig(userConfig.spotMinOrganic, 70),
    minHolders: positiveIntegerConfig(userConfig.spotMinHolders, 500),
    minMarketCapUsd: positiveNumberConfig(userConfig.spotMinMarketCapUsd, 150_000),
    maxMarketCapUsd: positiveNumberConfig(userConfig.spotMaxMarketCapUsd, 10_000_000),
    minTokenAgeMinutes: positiveNumberConfig(userConfig.spotMinTokenAgeMinutes, 30),
    maxTokenAgeHours: positiveNumberConfig(userConfig.spotMaxTokenAgeHours, 72),
    maxTop10Pct: positiveNumberConfig(userConfig.spotMaxTop10Pct, 30),
    maxBotHoldersPct: positiveNumberConfig(userConfig.spotMaxBotHoldersPct, 20),
    minPriceChange5mPct: numericConfig(userConfig.spotMinPriceChange5mPct) ?? 0.5,
    maxPriceChange5mPct: positiveNumberConfig(userConfig.spotMaxPriceChange5mPct, 12),
    minVolumeChangePct: numericConfig(userConfig.spotMinVolumeChangePct) ?? 0,
    minBuySellVolumeRatio: positiveNumberConfig(userConfig.spotMinBuySellVolumeRatio, 1.1),
    requirePositiveNetBuyers: userConfig.spotRequirePositiveNetBuyers ?? true,
    requireMintAuthorityDisabled: userConfig.spotRequireMintAuthorityDisabled ?? true,
    requireFreezeAuthorityDisabled: userConfig.spotRequireFreezeAuthorityDisabled ?? true,
    requireLegacyTokenProgram: userConfig.spotRequireLegacyTokenProgram ?? true,
    requireMomentumConfirmation: userConfig.spotRequireMomentumConfirmation ?? true,

    entrySlippageBps: boundedPositiveIntegerConfig(userConfig.spotEntrySlippageBps, 150, 500, "spotEntrySlippageBps"),
    exitSlippageBps: boundedPositiveIntegerConfig(userConfig.spotExitSlippageBps, 300, 1_000, "spotExitSlippageBps"),
    maxEntryPriceImpactPct: positiveNumberConfig(userConfig.spotMaxEntryPriceImpactPct, 1),
    maxExitPriceImpactPct: positiveNumberConfig(userConfig.spotMaxExitPriceImpactPct, 3),
    maxFeeBps: positiveIntegerConfig(userConfig.spotMaxFeeBps, 60),
    maxPriorityFeeLamports: positiveIntegerConfig(userConfig.spotMaxPriorityFeeLamports, 2_000_000),
    maxTotalFeeLamports: positiveIntegerConfig(userConfig.spotMaxTotalFeeLamports, 5_000_000),
    quoteMaxAgeMs: positiveIntegerConfig(userConfig.spotQuoteMaxAgeMs, 3_000),
    maxPriceBlockLag: positiveIntegerConfig(userConfig.spotMaxPriceBlockLag, 150),

    takeProfitPct: positiveNumberConfig(userConfig.spotTakeProfitPct, 6),
    stopLossPct: stopLossPct < 0 ? stopLossPct : -5,
    stopLossTriggerPct,
    trailingTriggerPct: positiveNumberConfig(userConfig.spotTrailingTriggerPct, 3),
    trailingDropPct: positiveNumberConfig(userConfig.spotTrailingDropPct, 1.5),
    maxHoldMinutes: positiveNumberConfig(userConfig.spotMaxHoldMinutes, 30),
    exitConfirmTicks: positiveIntegerConfig(userConfig.spotExitConfirmTicks, 2),
    scanIntervalSec: positiveIntegerConfig(userConfig.spotScanIntervalSec, 30),
    managementPollIntervalSec: positiveIntegerConfig(userConfig.spotManagementPollIntervalSec, 5),
  };
}

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
if (u.telegramChatId) process.env.TELEGRAM_CHAT_ID ||= String(u.telegramChatId);

// Optional standalone GMGN config file (mirrors user-config layering)
const GMGN_CONFIG_PATH = repoPath("gmgn-config.json");
const gmgnUserConfig = fs.existsSync(GMGN_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(GMGN_CONFIG_PATH, "utf8"))
  : {};
if (gmgnUserConfig.apiKey || u.gmgnApiKey) {
  process.env.GMGN_API_KEY ||= gmgnUserConfig.apiKey || u.gmgnApiKey;
}

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export const config = {
  // ─── Trading mode ─────────────────────────
  trading: buildTradingConfig(u),

  // ─── Risk Limits ─────────────────────────
  risk: buildRiskConfig(u),

  // ─── Fast spot-momentum strategy ──────────
  spot: buildSpotConfig(u),

  // ─── Pool Screening Thresholds ───────────
  screening: buildScreeningConfig(u),

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? true,
    autoSwapRetryAttempts: u.autoSwapRetryAttempts ?? 3,    // retries for base→SOL auto-swap on Jupiter failure
    autoSwapRetryDelayMs:  u.autoSwapRetryDelayMs  ?? 3000, // delay between auto-swap retries
    autoSwapSlippageBps:   u.autoSwapSlippageBps   ?? 500,  // explicit Jupiter minimum-output tolerance
    closeSlippageBps:      u.closeSlippageBps      ?? 500,  // zap-out order tolerance; 5000 (50%) is unsafe
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    // stopLossPct is the intended maximum loss. The bot exits earlier at
    // stopLossTriggerPct to reserve room for finality and market movement.
    stopLossPct:           stopLossPolicy.maximumPnlPct,
    stopLossTriggerPct:    stopLossPolicy.triggerPnlPct,
    stopLossConfirmTicks:  positiveIntegerConfig(u.stopLossConfirmTicks, 1),
    // Stop a fresh re-entry into the same collapsing token after a loss.
    // Set to 0 only to explicitly disable this risk cooldown.
    stopLossCooldownHours: u.stopLossCooldownHours ?? 12,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 3,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    trailingMinClosePnlPct: u.trailingMinClosePnlPct ?? 1,  // never intentionally trail-close below this PnL
    trailingLossCooldownHours: u.trailingLossCooldownHours ?? 12, // avoid immediately re-entering a token after a losing trailing exit
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:     u.strategy     ?? "bid_ask",
    minBinsBelow: strategyMinBinsBelow,
    maxBinsBelow: strategyMaxBinsBelow,
    defaultBinsBelow: strategyDefaultBinsBelow,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? false,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, process.env.HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  // ─── PnL fetcher / poller (public infra: RPC + Meteora deposits + Jupiter) ──
  pnl: {
    // Live position value comes from on-chain reads on this RPC.
    // Defaults to the public pump.helius endpoint so the aggressive poller
    // never burns the main RPC_URL or the LPAgent sponsor budget.
    rpcUrl: nonEmptyString(u.pnlRpcUrl, process.env.PNL_RPC_URL, "https://pump.helius-rpc.com"),
    source: nonEmptyString(u.pnlSource, "rpc"), // rpc | meteora (fallback-only)
    pollIntervalSec: Number(u.pnlPollIntervalSec ?? 3),
    depositCacheTtlSec: Number(u.pnlDepositCacheTtlSec ?? 300),
    // Consecutive confirming polls required before a peak is raised or an exit fires.
    // At a 3s poll cadence, 2 ticks ≈ 3-6s — filters single-tick noise without the
    // old fixed 15s setTimeout recheck.
    confirmTicks: Number(u.pnlConfirmTicks ?? 2),
  },

  // ─── Opportunity poller (catches strong pools between screening cycles) ──
  opportunity: {
    enabled: u.opportunityPollEnabled ?? true,
    pollIntervalSec: Number(u.opportunityPollIntervalSec ?? 45),
    // This is only a model/API debounce, not a loss cooldown. A candidate can
    // be reconsidered quickly while duplicate concurrent decisions stay blocked.
    decisionMinIntervalSec: Number(u.opportunityDecisionMinIntervalSec ?? 90),
    limit: Number(u.opportunityPollLimit ?? 10),
    // Pre-gate: only trigger the full deploy decision when the best candidate's
    // Degen Score (0..100) clears this bar — avoids running screening every 45s.
    minScore: Number(u.opportunityMinScore ?? 40),
    // A smart wallet (from the agentmeridian server) sitting on the pool LOWERS the
    // effective minScore by this much — a strong signal nudges a borderline pool through.
    smartWalletScoreBonus: Number(u.opportunitySmartWalletBonus ?? 20),
    // Degen Score targets (each sub-score saturates at its target). Tune to calibrate.
    // Inputs are normalized to a fixed 30m reference window, so these are timeframe-independent.
    targetVolRatio: Number(u.degenTargetVolRatio ?? 20),     // (30m) volume/active_tvl for full trading sub-score
    targetLpCount: Number(u.degenTargetLpCount ?? 40),       // (30m) unique_lps + positions_created for full LP sub-score
    targetFeeRatio: Number(u.degenTargetFeeRatio ?? 0.20),   // (30m) fee/active_tvl for full fee sub-score (tune per timeframe; fees don't normalize as cleanly as volume)
    // active_tvl ($) for full liquidity sub-score. NOT timeframe-scaled. Set near your
    // active-TVL floor (≈ minTvl) so it acts as a dust floor, not a stretch goal — the
    // screening minTvl filter already removes tiny pools.
    targetLiquidity: Number(u.degenTargetLiquidity ?? 20000),
  },

  // ─── GMGN (fee source for minTokenFeesSol gate) ──────────────
  gmgn: {
    apiKey: nonEmptyString(gmgnUserConfig.apiKey, u.gmgnApiKey, process.env.GMGN_API_KEY),
    baseUrl: nonEmptyString(gmgnUserConfig.baseUrl, u.gmgnBaseUrl, "https://openapi.gmgn.ai"),
    requestDelayMs: Number(gmgnUserConfig.requestDelayMs ?? u.gmgnRequestDelayMs ?? 2500),
    maxRetries: Number(gmgnUserConfig.maxRetries ?? u.gmgnMaxRetries ?? 2),
    // gmgn = use GMGN total_fee for global_fees_sol; jupiter = legacy Jupiter fees
    feeSource: nonEmptyString(gmgnUserConfig.feeSource, u.gmgnFeeSource, "gmgn"),
  },

  jupiter: {
    // Internal Jupiter Ultra settings; override by env only, do not expose in user-config.
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount: process.env.JUPITER_REFERRAL_ACCOUNT ?? "",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 0,
    ),
  },

  // LLM-originated configuration changes are disabled until explicitly opted in.
  // Risk and execution limits remain manual-only even when this is enabled.
  security: {
    allowAgentConfigMutation: u.allowAgentConfigMutation === true,
  },

  indicators: buildIndicatorConfig(u),
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol,
 * ceil=maxDeployAmount when configured). The result never spends the gas
 * reserve even when the per-position ceiling is disabled. When the wallet is
 * below the preferred floor, the remaining deployable balance is intentional.
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol, overrides = {}) {
  const reserve  = overrides.gasReserve ?? config.management.gasReserve ?? 0.2;
  const pct      = overrides.positionSizePct ?? config.management.positionSizePct ?? 0.35;
  const floor    = overrides.deployAmountSol ?? config.management.deployAmountSol;
  const ceil     = Object.hasOwn(overrides, "maxDeployAmount")
    ? overrides.maxDeployAmount
    : config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const uncapped   = Math.min(deployable, Math.max(floor, dynamic));
  const result     = ceil === null ? uncapped : Math.min(ceil, uncapped);
  // Floor, rather than round, so full-wallet sizing never consumes part of
  // the configured gas reserve through a half-cent-style rounding increase.
  return Math.floor((result + Number.EPSILON) * 100) / 100;
}

/**
 * Resolve whether the wallet can fund an automatic deploy without treating
 * deployAmountSol as a hard block when the wallet is below that preferred size. The
 * returned minimumAmount preserves the configured floor whenever it is
 * affordable, but lets a smaller wallet use all of its deployable SOL.
 */
export function getAutoDeploySizing(walletSol, overrides = {}) {
  const reserve = overrides.gasReserve ?? config.management.gasReserve ?? 0.2;
  const configuredFloor = Number(overrides.deployAmountSol ?? config.management.deployAmountSol);
  const preferredMinimum = Number.isFinite(configuredFloor)
    ? Math.max(MIN_DEPLOY_AMOUNT_SOL, configuredFloor)
    : MIN_DEPLOY_AMOUNT_SOL;
  const amount = computeDeployAmount(walletSol, overrides);
  const wallet = Number(walletSol);
  const funded = Number.isFinite(wallet)
    && Number.isFinite(amount)
    && amount >= MIN_DEPLOY_AMOUNT_SOL
    && wallet + Number.EPSILON >= amount + reserve;

  return {
    amount,
    minimumAmount: funded ? Math.min(preferredMinimum, amount) : MIN_DEPLOY_AMOUNT_SOL,
    reserve,
    funded,
  };
}

/**
 * Apply the deterministic post-circuit recovery cap to the normal wallet
 * sizing result. The backend uses the same calculation as the screening
 * prompt, so an LLM cannot request the unreduced amount during recovery.
 */
export function getCircuitAdjustedDeploySizing(walletSol, circuitStatus = {}, overrides = {}) {
  const normal = getAutoDeploySizing(walletSol, overrides);
  const requestedRecoveryPct = Number(circuitStatus?.recoverySizePct);
  const recoverySizePct = Number.isFinite(requestedRecoveryPct)
    && requestedRecoveryPct > 0
    && requestedRecoveryPct <= 1
    ? requestedRecoveryPct
    : 0.5;

  if (circuitStatus?.recoveryMode !== true) {
    return {
      ...normal,
      normalAmount: normal.amount,
      maximumAmount: normal.amount,
      recoveryMode: false,
      recoverySizePct: 1,
    };
  }

  const flooredRecoveryCap = Math.floor((normal.amount * recoverySizePct + Number.EPSILON) * 100) / 100;
  const recoveryCap = normal.amount >= MIN_DEPLOY_AMOUNT_SOL
    ? Math.max(MIN_DEPLOY_AMOUNT_SOL, flooredRecoveryCap)
    : flooredRecoveryCap;
  const adjusted = getAutoDeploySizing(walletSol, {
    ...overrides,
    maxDeployAmount: recoveryCap,
  });

  return {
    ...adjusted,
    normalAmount: normal.amount,
    maximumAmount: recoveryCap,
    recoveryMode: true,
    recoverySizePct,
  };
}

export function formatSolAmount(amount) {
  const numeric = Number(amount);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "?";
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    if (!fs.existsSync(USER_CONFIG_PATH)) return;
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol  != null) s.minTokenFeesSol  = fresh.minTokenFeesSol;
    if (fresh.maxTop10Pct      != null) s.maxTop10Pct      = fresh.maxTop10Pct;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minVolumeActiveTvlRatio != null) s.minVolumeActiveTvlRatio = fresh.minVolumeActiveTvlRatio;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.maxVolatility  != null) s.maxVolatility  = fresh.maxVolatility;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.requireTokenAudit !== undefined) s.requireTokenAudit = fresh.requireTokenAudit;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    const minBinsBelow = numericConfig(fresh.minBinsBelow) ?? config.strategy.minBinsBelow;
    const maxBinsBelow = numericConfig(fresh.maxBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.maxBinsBelow;
    const defaultBinsBelow = numericConfig(fresh.defaultBinsBelow) ?? numericConfig(fresh.binsBelow) ?? config.strategy.defaultBinsBelow ?? maxBinsBelow;
    config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(minBinsBelow));
    config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(maxBinsBelow));
    config.strategy.defaultBinsBelow = Math.max(
      config.strategy.minBinsBelow,
      Math.min(config.strategy.maxBinsBelow, Math.round(defaultBinsBelow)),
    );
  } catch { /* ignore */ }
}
