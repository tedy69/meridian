import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildIndicatorConfig,
  buildRiskConfig,
  buildScreeningConfig,
  config,
  getCircuitAdjustedDeploySizing,
} from "../config.js";
import {
  evaluateIndicatorPreset,
  resolveIndicatorConfirmation,
} from "../tools/chart-indicators.js";
import {
  buildRiskIntelligenceBrief,
  evaluateFreshPoolRisk,
  evaluateLossCircuitBreaker,
  evaluateTokenAuditRisk,
  parsePerformanceLedger,
} from "../risk-intelligence.js";
import { summarizeEntryMomentum } from "../lessons.js";
import { normalizeConfigValue, validateDeployPoolThresholds } from "../tools/executor.js";

const NOW = new Date("2026-09-02T06:00:00.000Z");

const circuitPolicy = {
  enabled: true,
  windowPositions: 5,
  maxConsecutiveLosses: 3,
  maxRollingLossPct: 12,
  maxSingleLossPct: 12,
  cooldownHours: 12,
};

const adaptiveCircuitPolicy = {
  enabled: true,
  windowPositions: 5,
  maxConsecutiveLosses: 3,
  maxRollingLossPct: 12,
  maxSingleLossPct: 12,
  lossCircuitStreakCooldownHours: 1,
  lossCircuitRollingCooldownHours: 2,
  lossCircuitSingleCooldownHours: 4,
  lossCircuitRecoverySizePct: 0.5,
};

const noCooldownCircuitPolicy = {
  ...adaptiveCircuitPolicy,
  lossCircuitStreakCooldownHours: 0,
  lossCircuitRollingCooldownHours: 0,
  lossCircuitSingleCooldownHours: 0,
};

function performance(pnlPct, minutesAgo, extra = {}) {
  return {
    pnl_pct: pnlPct,
    pnl_usd: pnlPct,
    recorded_at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    ...extra,
  };
}

test("loss circuit breaker blocks a fresh deploy after one severe realized loss", () => {
  const status = evaluateLossCircuitBreaker({
    performance: [performance(1, 90), performance(-14, 30)],
    policy: circuitPolicy,
    now: NOW,
  });

  assert.equal(status.pass, false);
  assert.equal(status.trigger, "single_loss");
  assert.match(status.reason, /-14\.00%.*12\.00%/);
  assert.equal(status.blockedUntil, "2026-09-02T17:30:00.000Z");
});

test("loss circuit breaker blocks accumulated losses before another position opens", () => {
  const status = evaluateLossCircuitBreaker({
    performance: [
      performance(2, 50),
      performance(-5, 40),
      performance(-4, 30),
      performance(-6, 20),
    ],
    policy: circuitPolicy,
    now: NOW,
  });

  assert.equal(status.pass, false);
  assert.equal(status.trigger, "rolling_loss");
  assert.equal(status.metrics.rollingPnlPct, -13);
});

test("loss circuit breaker catches three consecutive smaller losses", () => {
  const status = evaluateLossCircuitBreaker({
    performance: [
      performance(2, 50),
      performance(-2, 40),
      performance(-2, 30),
      performance(-2, 20),
    ],
    policy: circuitPolicy,
    now: NOW,
  });

  assert.equal(status.pass, false);
  assert.equal(status.trigger, "loss_streak");
  assert.equal(status.metrics.consecutiveLosses, 3);
});

test("loss circuit breaker automatically releases after its cooldown", () => {
  const status = evaluateLossCircuitBreaker({
    performance: [performance(-14, 13 * 60)],
    policy: circuitPolicy,
    now: NOW,
  });

  assert.equal(status.pass, true);
  assert.equal(status.trigger, null);
});

test("loss circuit breaker uses a four-hour pause for a severe single loss", () => {
  const status = evaluateLossCircuitBreaker({
    performance: [performance(1, 90), performance(-14, 30)],
    policy: adaptiveCircuitPolicy,
    now: NOW,
  });

  assert.equal(status.pass, false);
  assert.equal(status.trigger, "single_loss");
  assert.equal(status.cooldownHours, 4);
  assert.equal(status.blockedUntil, "2026-09-02T09:30:00.000Z");
});

test("loss circuit breaker uses a two-hour pause for rolling losses", () => {
  const status = evaluateLossCircuitBreaker({
    performance: [
      performance(2, 50),
      performance(-5, 40),
      performance(-4, 30),
      performance(-6, 20),
    ],
    policy: adaptiveCircuitPolicy,
    now: NOW,
  });

  assert.equal(status.pass, false);
  assert.equal(status.trigger, "rolling_loss");
  assert.equal(status.cooldownHours, 2);
  assert.equal(status.blockedUntil, "2026-09-02T07:40:00.000Z");
});

test("loss circuit breaker uses a one-hour pause for a small-loss streak", () => {
  const status = evaluateLossCircuitBreaker({
    performance: [
      performance(2, 50),
      performance(-2, 40),
      performance(-2, 30),
      performance(-2, 20),
    ],
    policy: adaptiveCircuitPolicy,
    now: NOW,
  });

  assert.equal(status.pass, false);
  assert.equal(status.trigger, "loss_streak");
  assert.equal(status.cooldownHours, 1);
  assert.equal(status.blockedUntil, "2026-09-02T06:40:00.000Z");
});

test("an expired circuit stays in half-size recovery until a profitable close", () => {
  const status = evaluateLossCircuitBreaker({
    performance: [performance(-14, 5 * 60)],
    policy: adaptiveCircuitPolicy,
    now: NOW,
  });

  assert.equal(status.pass, true);
  assert.equal(status.recoveryMode, true);
  assert.equal(status.recoverySizePct, 0.5);
  assert.equal(status.lastTrigger, "single_loss");
});

test("a profitable close after cooldown restores normal deploy sizing", () => {
  const status = evaluateLossCircuitBreaker({
    performance: [performance(-14, 7 * 60), performance(1, 60)],
    policy: adaptiveCircuitPolicy,
    now: NOW,
  });

  assert.equal(status.pass, true);
  assert.equal(status.recoveryMode, false);
  assert.equal(status.recoverySizePct, 1);
});

test("circuit-adjusted sizing halves the trusted backend amount during recovery", () => {
  const sizing = getCircuitAdjustedDeploySizing(1, {
    recoveryMode: true,
    recoverySizePct: 0.5,
  }, { maxDeployAmount: 0.3 });

  assert.equal(sizing.normalAmount, 0.3);
  assert.equal(sizing.amount, 0.15);
  assert.equal(sizing.maximumAmount, 0.15);
  assert.equal(sizing.recoveryMode, true);
});

test("loss-aware recovery starts immediately when timed cooldowns are zero", () => {
  const status = evaluateLossCircuitBreaker({
    performance: [performance(-14, 1)],
    policy: noCooldownCircuitPolicy,
    now: NOW,
  });

  assert.equal(status.pass, true);
  assert.equal(status.trigger, null);
  assert.equal(status.lastTrigger, "single_loss");
  assert.equal(status.blockedUntil, null);
  assert.equal(status.cooldownHours, 0);
  assert.equal(status.recoveryMode, true);
  assert.equal(status.recoverySizePct, 0.5);
  assert.match(status.reason, /no timed cooldown/i);
});

test("momentum-quality entry requires a rising candle above bullish Supertrend with balanced RSI", () => {
  const result = evaluateIndicatorPreset("entry", "momentum_quality", {
    latest: {
      candle: { close: 105 },
      previousCandle: { close: 100 },
      rsi: { value: 58 },
      supertrend: { value: 98, direction: "bullish" },
      states: { supertrendBreakUp: false },
    },
  }, { entryRsiMin: 45, entryRsiMax: 72 });

  assert.equal(result.confirmed, true);
});

test("momentum-quality entry rejects an overbought chase even in a bullish trend", () => {
  const result = evaluateIndicatorPreset("entry", "momentum_quality", {
    latest: {
      candle: { close: 105 },
      previousCandle: { close: 100 },
      rsi: { value: 79 },
      supertrend: { value: 98, direction: "bullish" },
      states: { supertrendBreakUp: false },
    },
  }, { entryRsiMin: 45, entryRsiMax: 72 });

  assert.equal(result.confirmed, false);
  assert.match(result.reason, /RSI 79.*45-72/i);
});

test("momentum-quality entry rejects a falling candle even on a fresh Supertrend flip", () => {
  const result = evaluateIndicatorPreset("entry", "momentum_quality", {
    latest: {
      candle: { close: 101 },
      previousCandle: { close: 103 },
      rsi: { value: 55 },
      supertrend: { value: 98, direction: "bullish" },
      states: { supertrendBreakUp: true },
    },
  }, { entryRsiMin: 45, entryRsiMax: 72 });

  assert.equal(result.confirmed, false);
  assert.match(result.reason, /rising price/i);
});

test("entry indicators fail closed when every fresh interval is unavailable", () => {
  const result = resolveIndicatorConfirmation({
    side: "entry",
    preset: "momentum_quality",
    targets: ["5_MINUTE", "15_MINUTE"],
    results: [
      { interval: "5_MINUTE", ok: false, confirmed: null, reason: "timeout" },
      { interval: "15_MINUTE", ok: false, confirmed: null, reason: "timeout" },
    ],
    requireAllIntervals: true,
    failClosed: true,
  });

  assert.equal(result.confirmed, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /unavailable.*refusing entry/i);
});

test("multi-timeframe entry confirmation rejects a missing required interval", () => {
  const result = resolveIndicatorConfirmation({
    side: "entry",
    preset: "momentum_quality",
    targets: ["5_MINUTE", "15_MINUTE"],
    results: [
      { interval: "5_MINUTE", ok: true, confirmed: true, reason: "confirmed" },
      { interval: "15_MINUTE", ok: false, confirmed: null, reason: "timeout" },
    ],
    requireAllIntervals: true,
    failClosed: true,
  });

  assert.equal(result.confirmed, false);
  assert.match(result.reason, /missing required interval/i);
});

const screening = {
  minTvl: 10_000,
  maxTvl: 150_000,
  minFeeActiveTvlRatio: 0.08,
  minVolume: 500,
  minOrganic: 60,
  minQuoteOrganic: 60,
  minHolders: 500,
  minMcap: 150_000,
  maxMcap: 10_000_000,
  minBinStep: 80,
  maxBinStep: 125,
  maxVolatility: 12,
  excludeHighSupplyConcentration: true,
};

const noIndicators = { enabled: false };

function healthyPool(overrides = {}) {
  return {
    pool_type: "dlmm",
    tvl: 50_000,
    active_tvl: 40_000,
    volume: 2_500,
    fee_active_tvl_ratio: 0.2,
    volatility: 8,
    base_token_holders: 1_000,
    base_token_has_high_supply_concentration: false,
    base_token_has_high_single_ownership: false,
    base_token_has_critical_warnings: false,
    quote_token_has_critical_warnings: false,
    dlmm_params: { bin_step: 100 },
    token_x: {
      address: "Mint111111111111111111111111111111111111",
      market_cap: 500_000,
      organic_score: 80,
    },
    token_y: { organic_score: 90 },
    ...overrides,
  };
}

test("fresh backend validation blocks the high-volatility tail before deploy", () => {
  const result = evaluateFreshPoolRisk({
    detail: healthyPool(),
    volatility: 12.49,
    volatilityTimeframe: "30m",
    screening,
  });

  assert.equal(result.pass, false);
  assert.match(result.reason, /volatility.*12\.49.*maximum 12/i);
});

test("fresh backend validation blocks stale low-volume data", () => {
  const result = evaluateFreshPoolRisk({
    detail: healthyPool({ volume: 0 }),
    volatility: 8,
    volatilityTimeframe: "30m",
    screening,
  });

  assert.equal(result.pass, false);
  assert.match(result.reason, /volume.*below.*500/i);
});

test("fresh backend validation blocks weak activity relative to liquidity", () => {
  const result = evaluateFreshPoolRisk({
    detail: healthyPool({ active_tvl: 100_000, volume: 1_000 }),
    volatility: 8,
    screening: { ...screening, minVolumeActiveTvlRatio: 0.02 },
  });

  assert.equal(result.pass, false);
  assert.match(result.reason, /volume\/active-TVL.*0\.01.*minimum 0\.02/i);
});

test("fresh backend validation fails closed on critical token warnings", () => {
  const result = evaluateFreshPoolRisk({
    detail: healthyPool({ base_token_has_critical_warnings: true }),
    volatility: 8,
    volatilityTimeframe: "30m",
    screening,
  });

  assert.equal(result.pass, false);
  assert.match(result.reason, /critical warning/i);
});

test("fresh backend validation accepts a complete healthy snapshot", () => {
  const result = evaluateFreshPoolRisk({
    detail: healthyPool(),
    volatility: 8,
    volatilityTimeframe: "30m",
    screening,
  });

  assert.equal(result.pass, true);
  assert.equal(result.entryMarketData.entry_volume, 2_500);
});

const tokenAuditPolicy = {
  requireTokenAudit: true,
  minTokenFeesSol: 30,
  maxTop10Pct: 60,
  maxBotHoldersPct: 30,
};

test("token audit is mandatory and fails closed when recon is unavailable", () => {
  const result = evaluateTokenAuditRisk(null, tokenAuditPolicy);

  assert.equal(result.pass, false);
  assert.match(result.reason, /token audit.*unavailable/i);
});

test("token audit hard-blocks holder concentration instead of advising the AI", () => {
  const result = evaluateTokenAuditRisk({
    global_fees_sol: 100,
    audit: { top_holders_pct: 72, bot_holders_pct: 5 },
  }, tokenAuditPolicy);

  assert.equal(result.pass, false);
  assert.match(result.reason, /top10 concentration 72%.*60%/i);
});

test("token audit accepts complete metrics within policy", () => {
  const result = evaluateTokenAuditRisk({
    global_fees_sol: 100,
    audit: { top_holders_pct: 25, bot_holders_pct: 5 },
  }, tokenAuditPolicy);

  assert.equal(result.pass, true);
});

test("token audit must be bound to the pool base mint", () => {
  const result = evaluateTokenAuditRisk({
    global_fees_sol: 100,
    audit: { top_holders_pct: 25, bot_holders_pct: 5 },
  }, tokenAuditPolicy, { expectedMint: "ExpectedMint111" });

  assert.equal(result.pass, false);
  assert.match(result.reason, /audit mint.*unavailable/i);
});

test("risk brief exposes recent expectancy and tail-risk to the screener AI", () => {
  const history = [
    performance(1.5, 60, { volatility: 5, close_reason: "take profit" }),
    performance(-14, 30, { volatility: 14, close_reason: "stop loss" }),
  ];
  const brief = buildRiskIntelligenceBrief({
    performance: history,
    policy: circuitPolicy,
    maxVolatility: 12,
    now: NOW,
  });

  assert.match(brief, /REALIZED RISK INTELLIGENCE/);
  assert.match(brief, /profit factor 0\.11/i);
  assert.match(brief, /high-volatility tail.*-14\.00%/i);
  assert.match(brief, /CIRCUIT OPEN/i);
});

test("deploy preflight uses the longer volatility window and blocks its tail", async () => {
  const result = await validateDeployPoolThresholds({ pool_address: "Pool111" }, {
    screening: { ...screening, timeframe: "5m", requireTokenAudit: true, ...tokenAuditPolicy },
    indicators: noIndicators,
    fetchPoolDetail: async (_poolAddress, timeframe) => timeframe === "30m"
      ? healthyPool({ volatility: 14 })
      : healthyPool({ volatility: 3 }),
    fetchTokenInfo: async () => ({
      found: true,
      results: [{
        mint: "Mint111111111111111111111111111111111111",
        global_fees_sol: 100,
        audit: { top_holders_pct: 25, bot_holders_pct: 5 },
      }],
    }),
  });

  assert.equal(result.pass, false);
  assert.match(result.reason, /30m volatility 14.*maximum 12/i);
});

test("deploy preflight re-fetches and enforces token audit", async () => {
  const result = await validateDeployPoolThresholds({ pool_address: "Pool111" }, {
    screening: { ...screening, timeframe: "30m", requireTokenAudit: true, ...tokenAuditPolicy },
    indicators: noIndicators,
    fetchPoolDetail: async () => healthyPool(),
    fetchTokenInfo: async () => ({
      found: true,
      results: [{
        mint: "Mint111111111111111111111111111111111111",
        global_fees_sol: 100,
        audit: { top_holders_pct: 75, bot_holders_pct: 5 },
      }],
    }),
  });

  assert.equal(result.pass, false);
  assert.match(result.reason, /top10 concentration 75%.*60%/i);
});

test("deploy preflight returns fresh entry metrics only after every gate passes", async () => {
  const result = await validateDeployPoolThresholds({ pool_address: "Pool111" }, {
    screening: { ...screening, timeframe: "30m", requireTokenAudit: true, ...tokenAuditPolicy },
    indicators: noIndicators,
    fetchPoolDetail: async () => healthyPool(),
    fetchTokenInfo: async () => ({
      found: true,
      results: [{
        mint: "Mint111111111111111111111111111111111111",
        global_fees_sol: 100,
        audit: { top_holders_pct: 25, bot_holders_pct: 5 },
      }],
    }),
  });

  assert.equal(result.pass, true);
  assert.deepEqual(result.entryMarketData, {
    entry_mcap: 500_000,
    entry_tvl: 50_000,
    entry_volume: 2_500,
    entry_holders: 1_000,
  });
  assert.deepEqual(result.trustedPoolArgs, {
    base_mint: "Mint111111111111111111111111111111111111",
    bin_step: 100,
    volatility: 8,
    fee_tvl_ratio: 0.2,
    organic_score: 80,
  });
});

test("deploy preflight fails closed when fresh entry momentum cannot be confirmed", async () => {
  const result = await validateDeployPoolThresholds({ pool_address: "Pool111" }, {
    screening: { ...screening, timeframe: "30m", requireTokenAudit: true, ...tokenAuditPolicy },
    indicators: {
      enabled: true,
      entryPreset: "momentum_quality",
      intervals: ["5_MINUTE", "15_MINUTE"],
      requireAllIntervals: true,
      entryFailClosed: true,
    },
    fetchPoolDetail: async () => healthyPool(),
    fetchTokenInfo: async () => ({
      found: true,
      results: [{
        mint: "Mint111111111111111111111111111111111111",
        global_fees_sol: 100,
        audit: { top_holders_pct: 25, bot_holders_pct: 5 },
      }],
    }),
    fetchIndicatorConfirmation: async () => ({
      enabled: true,
      confirmed: false,
      skipped: true,
      reason: "Indicator API unavailable; refusing entry",
      intervals: [],
    }),
  });

  assert.equal(result.pass, false);
  assert.match(result.reason, /momentum.*unavailable.*refusing entry/i);
});

test("deploy preflight records fresh multi-timeframe momentum after every gate passes", async () => {
  const confirmation = {
    enabled: true,
    confirmed: true,
    skipped: false,
    reason: "momentum_quality confirmed on 5_MINUTE, 15_MINUTE",
    intervals: [
      {
        interval: "5_MINUTE",
        ok: true,
        confirmed: true,
        signal: {
          close: 1.05,
          previousClose: 1,
          rsi: 58,
          supertrendValue: 0.98,
          supertrendDirection: "bullish",
          supertrendBreakUp: true,
        },
        latest: { should_not_be_persisted: true },
      },
      {
        interval: "15_MINUTE",
        ok: true,
        confirmed: true,
        signal: {
          close: 1.03,
          previousClose: 1.01,
          rsi: 54,
          supertrendValue: 0.99,
          supertrendDirection: "bullish",
          supertrendBreakUp: false,
        },
      },
    ],
  };
  const result = await validateDeployPoolThresholds({ pool_address: "Pool111" }, {
    screening: { ...screening, timeframe: "30m", requireTokenAudit: true, ...tokenAuditPolicy },
    indicators: {
      enabled: true,
      entryPreset: "momentum_quality",
      intervals: ["5_MINUTE", "15_MINUTE"],
      requireAllIntervals: true,
      entryFailClosed: true,
    },
    fetchPoolDetail: async () => healthyPool(),
    fetchTokenInfo: async () => ({
      found: true,
      results: [{
        mint: "Mint111111111111111111111111111111111111",
        global_fees_sol: 100,
        audit: { top_holders_pct: 25, bot_holders_pct: 5 },
      }],
    }),
    fetchIndicatorConfirmation: async () => confirmation,
  });

  assert.equal(result.pass, true);
  assert.deepEqual(result.riskMetrics.momentum, confirmation);
  assert.deepEqual(result.entrySignalSnapshot, {
    base_mint: "Mint111111111111111111111111111111111111",
    organic_score: 80,
    quote_organic_score: 90,
    fee_tvl_ratio: 0.2,
    volume_active_tvl_ratio: 0.0625,
    volatility: 8,
    entry_mcap: 500_000,
    entry_tvl: 50_000,
    entry_volume: 2_500,
    entry_holders: 1_000,
    token_global_fees_sol: 100,
    token_top10_pct: 25,
    token_bot_holders_pct: 5,
    momentum_preset: "momentum_quality",
    momentum_confirmed: true,
    momentum_intervals: [
      {
        interval: "5_MINUTE",
        confirmed: true,
        rsi: 58,
        supertrend_direction: "bullish",
        close_above_trend: true,
        rising_candle: true,
        supertrend_break_up: true,
      },
      {
        interval: "15_MINUTE",
        confirmed: true,
        rsi: 54,
        supertrend_direction: "bullish",
        close_above_trend: true,
        rising_candle: true,
        supertrend_break_up: false,
      },
    ],
  });
  assert.equal(JSON.stringify(result.entrySignalSnapshot).includes("should_not_be_persisted"), false);
});

test("risk intelligence defaults to immediate loss-aware re-entry with stronger entry quality", () => {
  const riskDefaults = buildRiskConfig();
  const screeningDefaults = buildScreeningConfig();
  const indicatorDefaults = buildIndicatorConfig();

  assert.equal(config.screening.maxVolatility, 12);
  assert.equal(config.screening.requireTokenAudit, true);
  assert.equal(riskDefaults.lossCircuitBreakerEnabled, true);
  assert.equal(riskDefaults.lossCircuitWindowPositions, 5);
  assert.equal(riskDefaults.maxConsecutiveLosses, 3);
  assert.equal(riskDefaults.maxRollingLossPct, 12);
  assert.equal(riskDefaults.maxSingleLossPct, 12);
  assert.equal(riskDefaults.maxDeployAmount, 0.3);
  assert.equal(screeningDefaults.minOrganic, 70);
  assert.equal(screeningDefaults.minFeeActiveTvlRatio, 0.15);
  assert.equal(screeningDefaults.minVolumeActiveTvlRatio, 0.02);
  assert.equal(indicatorDefaults.enabled, true);
  assert.equal(indicatorDefaults.entryPreset, "momentum_quality");
  assert.deepEqual(indicatorDefaults.intervals, ["5_MINUTE", "15_MINUTE"]);
  assert.equal(indicatorDefaults.requireAllIntervals, true);
  assert.equal(indicatorDefaults.entryFailClosed, true);
  assert.equal(riskDefaults.lossCircuitStreakCooldownHours, 0);
  assert.equal(riskDefaults.lossCircuitRollingCooldownHours, 0);
  assert.equal(riskDefaults.lossCircuitSingleCooldownHours, 0);
  assert.equal(riskDefaults.lossCircuitRecoverySizePct, 0.5);
});

test("entry-momentum settings retain their intended types when updated", () => {
  assert.equal(normalizeConfigValue("chartIndicatorsEnabled", false), false);
  assert.equal(normalizeConfigValue("entryFailClosed", true), true);
  assert.equal(normalizeConfigValue("requireAllIntervals", true), true);
  assert.equal(normalizeConfigValue("opportunityPollEnabled", false), false);
  assert.equal(normalizeConfigValue("indicatorEntryPreset", "momentum_quality"), "momentum_quality");
  assert.deepEqual(
    normalizeConfigValue("indicatorIntervals", ["5_MINUTE", "15_MINUTE"]),
    ["5_MINUTE", "15_MINUTE"],
  );
});

test("deploy safety checks the realized-loss circuit before remote pool preflight", () => {
  const source = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  const deploySafety = source.slice(source.indexOf('case "deploy_position"'), source.indexOf('case "update_config"'));
  const circuitIndex = deploySafety.indexOf("evaluateLossCircuitBreaker");
  const freshPoolIndex = deploySafety.indexOf("validateDeployPoolThresholds");

  assert.ok(circuitIndex >= 0, "deploy safety must evaluate realized losses");
  assert.ok(freshPoolIndex >= 0, "deploy safety must retain fresh pool preflight");
  assert.ok(circuitIndex < freshPoolIndex, "circuit breaker should stop before remote deploy preflight");
  assert.match(deploySafety, /getCircuitAdjustedDeploySizing/);
  assert.match(deploySafety, /allowedSizing\.maximumAmount/);
  assert.match(deploySafety, /trustedPoolArgs/);
  assert.match(deploySafety, /entry_signal_snapshot/);
});

test("deploy persistence combines fresh entry evidence even when Darwin learning is disabled", () => {
  const source = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  const deployPosition = source.slice(
    source.indexOf("export async function deployPosition"),
    source.indexOf("// ─── Close Position"),
  );

  assert.match(deployPosition, /entry_signal_snapshot/);
  assert.ok(
    deployPosition.match(/signal_snapshot:\s*signalSnapshot/g)?.length >= 2,
    "both relay and standard deploy paths must persist the entry snapshot",
  );
  assert.match(deployPosition, /\.\.\.\(entry_signal_snapshot \|\| \{\}\)/);
});

test("learned lessons summarize the exact multi-timeframe entry conditions", () => {
  const summary = summarizeEntryMomentum({
    momentum_preset: "momentum_quality",
    momentum_intervals: [
      {
        interval: "5_MINUTE",
        rsi: 58,
        supertrend_direction: "bullish",
        close_above_trend: true,
        rising_candle: true,
      },
      {
        interval: "15_MINUTE",
        rsi: 54,
        supertrend_direction: "bullish",
        close_above_trend: true,
        rising_candle: true,
      },
    ],
  });

  assert.equal(
    summary,
    "momentum_quality [5_MINUTE: RSI 58, bullish, rising, above trend; 15_MINUTE: RSI 54, bullish, rising, above trend]",
  );
});

test("automatic screening receives realized risk context and deterministic token audit", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const screeningCycle = source.slice(source.indexOf("export async function runScreeningCycle"), source.indexOf("function computeBinsBelow"));

  assert.match(screeningCycle, /evaluateLossCircuitBreaker/);
  assert.match(screeningCycle, /evaluateTokenAuditRisk/);
  assert.match(screeningCycle, /buildRiskIntelligenceBrief/);
  assert.match(screeningCycle, /getCircuitAdjustedDeploySizing/);
});

test("the Telegram risk menu preserves a fractional SOL deployment cap", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");

  assert.match(
    source,
    /stepButtons\("maxDeployAmount", "Max SOL", 0\.05, \{ digits: 2 \}\)/,
  );
});

test("a corrupt performance ledger fails closed instead of erasing loss history", () => {
  assert.throws(() => parsePerformanceLedger("not-json"), /performance risk ledger.*invalid JSON/i);
  assert.throws(() => parsePerformanceLedger('{"performance":"unknown"}'), /performance.*must be an array/i);
  assert.deepEqual(parsePerformanceLedger('{"performance":[]}'), []);
});
