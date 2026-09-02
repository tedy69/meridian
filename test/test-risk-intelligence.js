import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { config } from "../config.js";
import {
  buildRiskIntelligenceBrief,
  evaluateFreshPoolRisk,
  evaluateLossCircuitBreaker,
  evaluateTokenAuditRisk,
  parsePerformanceLedger,
} from "../risk-intelligence.js";
import { validateDeployPoolThresholds } from "../tools/executor.js";

const NOW = new Date("2026-09-02T06:00:00.000Z");

const circuitPolicy = {
  enabled: true,
  windowPositions: 5,
  maxConsecutiveLosses: 3,
  maxRollingLossPct: 12,
  maxSingleLossPct: 12,
  cooldownHours: 12,
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
});

test("risk intelligence has conservative defaults", () => {
  assert.equal(config.screening.maxVolatility, 12);
  assert.equal(config.screening.requireTokenAudit, true);
  assert.equal(config.risk.lossCircuitBreakerEnabled, true);
  assert.equal(config.risk.lossCircuitWindowPositions, 5);
  assert.equal(config.risk.maxConsecutiveLosses, 3);
  assert.equal(config.risk.maxRollingLossPct, 12);
  assert.equal(config.risk.maxSingleLossPct, 12);
  assert.equal(config.risk.lossCircuitCooldownHours, 12);
});

test("deploy safety checks the realized-loss circuit before remote pool preflight", () => {
  const source = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  const deploySafety = source.slice(source.indexOf('case "deploy_position"'), source.indexOf('case "update_config"'));
  const circuitIndex = deploySafety.indexOf("evaluateLossCircuitBreaker");
  const freshPoolIndex = deploySafety.indexOf("validateDeployPoolThresholds");

  assert.ok(circuitIndex >= 0, "deploy safety must evaluate realized losses");
  assert.ok(freshPoolIndex >= 0, "deploy safety must retain fresh pool preflight");
  assert.ok(circuitIndex < freshPoolIndex, "circuit breaker should stop before remote deploy preflight");
});

test("automatic screening receives realized risk context and deterministic token audit", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const screeningCycle = source.slice(source.indexOf("export async function runScreeningCycle"), source.indexOf("function computeBinsBelow"));

  assert.match(screeningCycle, /evaluateLossCircuitBreaker/);
  assert.match(screeningCycle, /evaluateTokenAuditRisk/);
  assert.match(screeningCycle, /buildRiskIntelligenceBrief/);
});

test("a corrupt performance ledger fails closed instead of erasing loss history", () => {
  assert.throws(() => parsePerformanceLedger("not-json"), /performance risk ledger.*invalid JSON/i);
  assert.throws(() => parsePerformanceLedger('{"performance":"unknown"}'), /performance.*must be an array/i);
  assert.deepEqual(parsePerformanceLedger('{"performance":[]}'), []);
});
