import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { buildSpotConfig, buildSpotDiscoveryConfig, buildTradingConfig } from "../config.js";
import { SOL_MINT } from "../execution-guard.js";
import {
  calculateSpotSpikeScore,
  evaluateSpotExit,
  evaluateSpotMomentumCandidate,
} from "../spot-momentum.js";
import {
  beginSpotOpen,
  completeSpotClose,
  confirmSpotOpen,
  getSpotPosition,
  markSpotOpeningSubmitted,
  markSpotClosing,
  updateSpotObservation,
} from "../spot-state.js";
import {
  commitSpotBuy,
  getSpotRiskBudget,
  recordSpotRealizedPnl,
  reserveSpotBuy,
} from "../spot-risk-budget.js";
import {
  LEGACY_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID_STRING,
  deriveAssociatedTokenAddress,
  validateMintProgramSafety,
  validateJupiterExecutionResult,
  validateJupiterOrder,
  validateJupiterQuote,
  validateJupiterTransactionEnvelope,
  validateSimulatedSwapEffects,
  runSubmittedSwapStep,
} from "../tools/wallet.js";
import {
  closeSpotPosition,
  getSpotMomentumCandidates,
  getSpotPositionSnapshot,
  getSpotStatus,
  openSpotPosition,
  validateSpotEntry,
} from "../tools/spot.js";

function withTempFiles(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-spot-"));
  try {
    return callback({
      statePath: path.join(directory, "spot-state.json"),
      budgetPath: path.join(directory, "spot-budget.json"),
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function passingCandidate() {
  const mint = "TokenMint111111111111111111111111111111111";
  return {
    pool: {
      pool: "Pool1111111111111111111111111111111111111",
      name: "MEME-SOL",
      base: { mint, symbol: "MEME", organic: 82 },
      quote: { mint: SOL_MINT, symbol: "SOL" },
      tvl: 80_000,
      volume_window: 12_000,
      volume_active_tvl_ratio: 0.15,
      organic_score: 82,
      holders: 1_200,
      mcap: 900_000,
      token_age_hours: 4,
      price_change_pct: 4.2,
      volume_change_pct: 35,
      indicator_confirmation: {
        enabled: true,
        confirmed: true,
        skipped: false,
        intervals: [
          { interval: "5_MINUTE", ok: true, confirmed: true },
          { interval: "15_MINUTE", ok: true, confirmed: true },
        ],
      },
    },
    tokenInfo: {
      mint,
      holders: 1_200,
      audit: {
        mint_disabled: true,
        freeze_disabled: true,
        top_holders_pct: "22.4",
        bot_holders_pct: "8.1",
      },
      stats_1h: {
        buy_vol: "45000",
        sell_vol: "25000",
        net_buyers: 37,
      },
    },
  };
}

test("spot momentum explicitly enables a backend-capped 0.5 SOL trade", () => {
  const trading = buildTradingConfig({ tradingMode: "spot_momentum" });
  const spot = buildSpotConfig({});
  assert.equal(trading.mode, "spot_momentum");
  assert.equal(buildTradingConfig({}).mode, "dlmm_lp");
  assert.throws(() => buildTradingConfig({ tradingMode: "typo" }), /tradingMode/i);
  assert.throws(() => buildSpotConfig({ spotTradeAmountSol: 0.6 }), /0\.5 SOL/i);
  assert.throws(() => buildSpotConfig({ spotEntrySlippageBps: 501 }), /spotEntrySlippageBps/i);
  assert.equal(spot.tradeAmountSol, 0.5);
  assert.equal(spot.maxTradeAmountSol, 0.5);
  assert.equal(spot.gasReserveSol, 0.1);
  assert.equal(spot.minWalletSol, 0.6);
  assert.equal(spot.maxOpenPositions, 1);
  assert.equal(spot.maxDailyBuySol, null);
  assert.equal(buildSpotConfig({ spotMaxDailyBuySol: 2 }).maxDailyBuySol, 2);
  assert.throws(() => buildSpotConfig({ spotMaxDailyBuySol: "unlimited" }), /spotMaxDailyBuySol/i);
  assert.equal(spot.stopLossTriggerPct, -3);
  assert.equal(spot.stopLossPct, -5);
  assert.equal(spot.takeProfitPct, 1);
  assert.equal(spot.minProfitExitPct, 0.1);
  assert.equal(spot.profitExitSlippageBps, 50);
  assert.equal(spot.trailingTriggerPct, 1.5);
  assert.equal(spot.trailingDropPct, 0.5);
  assert.equal(spot.maxHoldMinutes, 5);
  assert.equal(spot.exitConfirmTicks, 1);
  assert.equal(spot.scanIntervalSec, 5);
  assert.equal(spot.managementPollIntervalSec, 1);
  assert.equal(spot.realtimeEnabled, true);
  assert.equal(spot.realtimeCommitment, "processed");
  assert.equal(spot.realtimeEventDebounceMs, 100);
  assert.equal(spot.realtimeMinRefreshMs, 500);
  assert.equal(spot.minPriceChange5mPct, 1.5);
  assert.equal(spot.maxPriceChange5mPct, 8);
  assert.equal(spot.minVolumeChangePct, 20);
  assert.equal(spot.minBuySellVolumeRatio, 1.15);
  assert.equal(spot.minSpikeScore, 40);
  assert.equal(spot.maxEntryRoundTripLossPct, 0.75);
  assert.throws(
    () => buildSpotConfig({ spotMaxEntryRoundTripLossPct: 0.9 }),
    /roundtriplosspct.*below.*takeprofitpct/i,
  );
  assert.equal(buildSpotConfig({ spotRealtimeMinRefreshMs: 200 }).realtimeMinRefreshMs, 200);
  assert.throws(() => buildSpotConfig({ spotRealtimeEnabled: "false" }), /spotRealtimeEnabled/i);
  assert.throws(() => buildSpotConfig({ spotRealtimeCommitment: "fastest" }), /spotRealtimeCommitment/i);
  assert.throws(() => buildSpotConfig({ spotRealtimeEventDebounceMs: 10 }), /spotRealtimeEventDebounceMs/i);
});

test("spot discovery is broad while the fresh entry gate stays selective", () => {
  const discovery = buildSpotDiscoveryConfig({});
  const entry = buildSpotConfig({});

  assert.deepEqual({
    liquidity: discovery.minLiquidityUsd,
    volume: discovery.minVolume5mUsd,
    volumeRatio: discovery.minVolumeLiquidityRatio,
    organic: discovery.minOrganic,
    holders: discovery.minHolders,
    minMcap: discovery.minMarketCapUsd,
    maxMcap: discovery.maxMarketCapUsd,
    minAgeMinutes: discovery.minTokenAgeMinutes,
    maxAgeHours: discovery.maxTokenAgeHours,
  }, {
    liquidity: 20_000,
    volume: 500,
    volumeRatio: 0.025,
    organic: 60,
    holders: 200,
    minMcap: 75_000,
    maxMcap: 50_000_000,
    minAgeMinutes: 20,
    maxAgeHours: 2_160,
  });
  assert.deepEqual({
    liquidity: entry.minLiquidityUsd,
    volume: entry.minVolume5mUsd,
    volumeRatio: entry.minVolumeLiquidityRatio,
    organic: entry.minOrganic,
    holders: entry.minHolders,
    minMcap: entry.minMarketCapUsd,
    maxMcap: entry.maxMarketCapUsd,
    minAgeMinutes: entry.minTokenAgeMinutes,
    maxAgeHours: entry.maxTokenAgeHours,
    priceChange: entry.minPriceChange5mPct,
    volumeChange: entry.minVolumeChangePct,
    buySellRatio: entry.minBuySellVolumeRatio,
  }, {
    liquidity: 30_000,
    volume: 2_000,
    volumeRatio: 0.03,
    organic: 65,
    holders: 300,
    minMcap: 100_000,
    maxMcap: 30_000_000,
    minAgeMinutes: 30,
    maxAgeHours: 2_160,
    priceChange: 1.5,
    volumeChange: 20,
    buySellRatio: 1.15,
  });
  assert.equal(entry.allowMetadataOnlyToken2022, true);
  assert.equal(entry.requireLegacyTokenProgram, false);
  assert.ok(discovery.minLiquidityUsd < entry.minLiquidityUsd);
  assert.ok(discovery.minVolume5mUsd < entry.minVolume5mUsd);
});

test("Token-2022 mint safety only permits metadata extensions with disabled authorities", () => {
  const legacy = validateMintProgramSafety({
    mint: "legacy",
    programId: LEGACY_TOKEN_PROGRAM_ID,
    decimals: 6,
    mintAuthority: null,
    freezeAuthority: null,
    extensionTypes: [],
  });
  assert.equal(legacy.legacyTokenProgram, true);

  const metadataOnly = validateMintProgramSafety({
    mint: "token-2022",
    programId: TOKEN_2022_PROGRAM_ID_STRING,
    decimals: 6,
    mintAuthority: null,
    freezeAuthority: null,
    extensionTypes: [18, 19],
  }, { requireLegacyTokenProgram: false, allowMetadataOnlyToken2022: true });
  assert.equal(metadataOnly.metadataOnlyToken2022, true);
  assert.deepEqual(metadataOnly.extensionTypes, ["MetadataPointer", "TokenMetadata"]);

  for (const extension of [
    "TransferFeeConfig",
    "TransferHook",
    "PermanentDelegate",
    "PausableConfig",
    "NonTransferable",
    "MintCloseAuthority",
    "Unknown(65535)",
  ]) {
    assert.throws(() => validateMintProgramSafety({
      mint: "unsafe-token-2022",
      programId: TOKEN_2022_PROGRAM_ID_STRING,
      decimals: 6,
      mintAuthority: null,
      freezeAuthority: null,
      extensionTypes: ["MetadataPointer", extension],
    }, { requireLegacyTokenProgram: false, allowMetadataOnlyToken2022: true }), new RegExp(extension.replace(/[()]/g, "\\$&"), "i"));
  }

  assert.throws(() => validateMintProgramSafety({
    mint: "metadata-disabled",
    programId: TOKEN_2022_PROGRAM_ID_STRING,
    decimals: 6,
    mintAuthority: null,
    freezeAuthority: null,
    extensionTypes: ["TokenMetadata"],
  }), /legacy SPL Token program/i);
  assert.throws(() => validateMintProgramSafety({
    mint: "authority-enabled",
    programId: TOKEN_2022_PROGRAM_ID_STRING,
    decimals: 6,
    mintAuthority: "authority",
    freezeAuthority: null,
    extensionTypes: ["TokenMetadata"],
  }, { requireLegacyTokenProgram: false, allowMetadataOnlyToken2022: true }), /mint authority/i);
  assert.throws(() => validateMintProgramSafety({
    mint: "uninitialized",
    programId: LEGACY_TOKEN_PROGRAM_ID,
    decimals: 6,
    isInitialized: false,
    mintAuthority: null,
    freezeAuthority: null,
  }), /not initialized/i);

  const owner = new PublicKey("11111111111111111111111111111111");
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  assert.notEqual(
    deriveAssociatedTokenAddress(owner, mint, LEGACY_TOKEN_PROGRAM_ID).toBase58(),
    deriveAssociatedTokenAddress(owner, mint, TOKEN_2022_PROGRAM_ID_STRING).toBase58(),
    "associated-token derivation must bind the mint's token program",
  );
});

test("broadly discovered pools still must pass the stricter fresh entry policy", async () => {
  const candidate = passingCandidate();
  candidate.pool.tvl = 25_000;
  candidate.pool.volume_window = 1_000;
  candidate.pool.volume_active_tvl_ratio = 0.04;
  candidate.pool.organic_score = 62;
  candidate.pool.base.organic = 62;
  candidate.pool.holders = 250;
  candidate.tokenInfo.holders = 250;
  candidate.pool.mcap = 90_000;
  candidate.pool.token_age_hours = 1;
  candidate.pool.price_change_pct = 1;
  candidate.pool.volume_change_pct = 0;
  let auditReads = 0;

  const result = await getSpotMomentumCandidates({ limit: 10 }, {
    tradingMode: "spot_momentum",
    spotConfig: buildSpotConfig({}),
    spotDiscoveryConfig: buildSpotDiscoveryConfig({}),
    readSpotPosition: () => null,
    discoverPools: async () => ({ pools: [candidate.pool] }),
    getTokenInfo: async () => { auditReads += 1; return { results: [candidate.tokenInfo] }; },
    confirmIndicatorPreset: async () => ({ confirmed: true, skipped: false, intervals: [] }),
    inspectMintSafety: async () => ({ legacyTokenProgram: true, extensionTypes: [] }),
    indicatorConfig: { entryPreset: "momentum_quality", intervals: ["5_MINUTE", "15_MINUTE"] },
    sleep: async () => {},
  });

  assert.equal(auditReads, 0, "known entry rejection should not consume audit/indicator API requests");
  assert.equal(result.shortlist_size, 1);
  assert.equal(result.candidates.length, 0);
  assert.match(result.filtered_examples[0].reason, /liquidity.*30000/i);
});

test("spot preflight accepts a normalized cross-DEX market in hybrid mode", async () => {
  const { pool, tokenInfo } = passingCandidate();
  pool.pool = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
  pool.venue = "raydium";
  pool.price_source = "jupiter_quote";
  const result = await validateSpotEntry(pool.pool, {
    tradingMode: "hybrid", spotConfig: buildSpotConfig({}),
    getPoolDetail: async () => pool,
    getTokenInfo: async () => ({ results: [tokenInfo] }),
    confirmIndicatorPreset: async () => pool.indicator_confirmation,
    inspectMintSafety: async () => ({ legacyTokenProgram: true }),
    getSpotRoundTripQuote: async () => ({ pass: true, expectedLossPct: 0.2 }),
  });
  assert.equal(result.pass, true, result.reason);
  assert.equal(result.pool.venue, "raydium");
});

test("cross-DEX positions use tracked-size net exit quotes and never decode DLMM", async () => {
  const position = { id: "spot-other", status: "open", mint: "mint", pool: "pool", priceSource: "jupiter_quote",
    tokenRawAmount: "100000", tokenDecimals: 3, entryCostSol: 0.5, peakPnlPct: 0,
    openedAt: "2026-09-04T12:00:00Z" };
  const deps = { readSpotPosition: () => position, spotConfig: buildSpotConfig({}),
    getTokenBalanceByMint: async () => ({ amount: 150, raw_amount: "150000", decimals: 3 }),
    getActiveBin: async () => assert.fail("non-DLMM must not be decoded with DLMM SDK"),
    getSpotExitQuote: async ({ rawAmount }) => { assert.equal(rawAmount, "100000"); return { netValueSol: 0.51 }; },
    updateSpotObservation: (_id, value) => ({ ...position, ...value }),
    now: () => new Date("2026-09-04T12:01:00Z") };
  const result = await getSpotPositionSnapshot({}, deps);
  assert.equal(result.current_value_sol, 0.51);
  assert.equal(result.price_source, "jupiter_quote");
  assert.equal(result.exit.action, "TAKE_PROFIT");
  const failed = await getSpotPositionSnapshot({}, { ...deps, getSpotExitQuote: async () => { throw new Error("HTTP 429"); } });
  assert.equal(failed.priceable, false);
  assert.match(failed.reason, /429/);
});

test("candidate screening rejects a behavioral Token-2022 extension before AI selection", async () => {
  const candidate = passingCandidate();
  let mintSafetyReads = 0;
  const result = await getSpotMomentumCandidates({ limit: 10 }, {
    tradingMode: "spot_momentum",
    spotConfig: buildSpotConfig({}),
    spotDiscoveryConfig: buildSpotDiscoveryConfig({}),
    readSpotPosition: () => null,
    discoverPools: async () => ({ pools: [candidate.pool] }),
    getTokenInfo: async () => ({ results: [candidate.tokenInfo] }),
    confirmIndicatorPreset: async () => ({ confirmed: true, skipped: false, intervals: [] }),
    inspectMintSafety: async () => {
      mintSafetyReads += 1;
      throw new Error("unsupported Token-2022 extension(s): TransferFeeConfig");
    },
    indicatorConfig: { entryPreset: "momentum_quality", intervals: ["5_MINUTE", "15_MINUTE"] },
    sleep: async () => {},
  });

  assert.equal(mintSafetyReads, 1);
  assert.equal(result.candidates.length, 0);
  assert.match(result.filtered_examples[0].reason, /TransferFeeConfig/);
});

test("candidate gate requires safe audit, SOL quote, and confirmed momentum", () => {
  const candidate = passingCandidate();
  const accepted = evaluateSpotMomentumCandidate(candidate);
  assert.equal(accepted.pass, true);
  assert.ok(accepted.score > 0);
  assert.ok(accepted.metrics.spikeScore >= 40);
  assert.equal(accepted.metrics.entryStyle, "early_spike");
  assert.equal(calculateSpotSpikeScore({
    priceChange5mPct: 2.426576794539904,
    volumeChangePct: 54.6,
    buySellVolumeRatio: 1.2035908481453539,
  }), 49.09);
  candidate.pool.volume_active_tvl_ratio = 99;
  assert.equal(evaluateSpotMomentumCandidate(candidate).metrics.volumeLiquidityRatio, 0.15);

  const authorityEnabled = structuredClone(candidate);
  authorityEnabled.tokenInfo.audit.mint_disabled = false;
  assert.match(evaluateSpotMomentumCandidate(authorityEnabled).reason, /mint authority/i);

  const chasing = structuredClone(candidate);
  chasing.pool.price_change_pct = 9;
  assert.match(evaluateSpotMomentumCandidate(chasing).reason, /chase limit/i);

  const weakSpike = structuredClone(candidate);
  weakSpike.pool.price_change_pct = 1.5;
  weakSpike.pool.volume_change_pct = 20;
  weakSpike.tokenInfo.stats_1h.buy_vol = "28750";
  weakSpike.tokenInfo.stats_1h.sell_vol = "25000";
  assert.match(evaluateSpotMomentumCandidate(weakSpike).reason, /spike strength/i);

  const staleMomentum = structuredClone(candidate);
  staleMomentum.pool.indicator_confirmation.skipped = true;
  assert.match(evaluateSpotMomentumCandidate(staleMomentum).reason, /momentum/i);
});

test("required momentum rejects disabled or evidence-free indicator confirmations", () => {
  const disabled = passingCandidate();
  disabled.pool.indicator_confirmation = {
    enabled: false,
    confirmed: true,
    skipped: false,
    intervals: [],
  };
  const disabledResult = evaluateSpotMomentumCandidate(disabled);
  assert.equal(disabledResult.pass, false);
  assert.match(disabledResult.reason, /indicator evidence/i);

  const empty = passingCandidate();
  empty.pool.indicator_confirmation.intervals = [];
  const emptyResult = evaluateSpotMomentumCandidate(empty);
  assert.equal(emptyResult.pass, false);
  assert.match(emptyResult.reason, /indicator evidence/i);
});

test("round-trip execution gate rejects entries whose spread consumes the profit target", async () => {
  const { evaluateSpotRoundTripQuote } = await import("../spot-momentum.js");
  assert.equal(typeof evaluateSpotRoundTripQuote, "function");

  const viable = evaluateSpotRoundTripQuote({
    inputLamports: "500000000",
    expectedReturnLamports: "496994891",
    maxLossPct: 0.75,
  });
  assert.equal(viable.pass, true);
  assert.ok(Math.abs(viable.expectedLossPct - 0.6010218) < 1e-9);

  const expensive = evaluateSpotRoundTripQuote({
    inputLamports: "500000000",
    expectedReturnLamports: "487756591",
    maxLossPct: 0.75,
  });
  assert.equal(expensive.pass, false);
  assert.match(expensive.reason, /round-trip.*2\.45%.*0\.75%/i);
});

test("entry selector favors lower executable round-trip cost after all gates pass", async () => {
  const { selectSpotEntryCandidate } = await import("../spot-momentum.js");
  assert.equal(typeof selectSpotEntryCandidate, "function");
  const selected = selectSpotEntryCandidate([
    { pool: "high-score", spot_score: 90, round_trip_quote: { expectedLossPct: 0.7 } },
    { pool: "cleaner-exit", spot_score: 82, round_trip_quote: { expectedLossPct: 0.2 } },
  ]);
  assert.equal(selected.pool, "cleaner-exit");
});

test("spike scalp exits immediately at the tight stop, quick profit, fade, or five-minute timeout", () => {
  const position = {
    entryCostSol: 0.5,
    openedAt: "2026-09-02T00:00:00.000Z",
    peakPnlPct: 0,
  };
  const beforeTimeout = new Date("2026-09-02T00:01:00.000Z");
  assert.equal(evaluateSpotExit({ position, currentValueSol: 0.485, now: beforeTimeout }).action, "STOP_LOSS");
  assert.equal(evaluateSpotExit({ position, currentValueSol: 0.505, now: beforeTimeout }).action, "TAKE_PROFIT");
  assert.equal(evaluateSpotExit({ position, currentValueSol: 0.5049, now: beforeTimeout }).action, "HOLD");

  const trailing = evaluateSpotExit({
    position: { ...position, peakPnlPct: 2 },
    currentValueSol: 0.5075,
    now: beforeTimeout,
    policy: { takeProfitPct: 3 },
  });
  assert.equal(trailing.action, "TRAILING_TAKE_PROFIT");

  const timed = evaluateSpotExit({
    position,
    currentValueSol: 0.501,
    now: new Date("2026-09-02T00:05:00.000Z"),
  });
  assert.equal(timed.action, "MAX_HOLD");
});

test("spot state persists opening, open, observation, and closed transitions", () => {
  withTempFiles(({ statePath }) => {
    const options = { statePath };
    const opening = beginSpotOpen({
      pool: "pool",
      poolName: "MEME-SOL",
      mint: "mint",
      symbol: "MEME",
      entryCostSol: 0.5,
      solBalanceBefore: 1,
      tokenBalanceBefore: 0,
      tokenRawBalanceBefore: "0",
      tokenDecimals: 4,
    }, options);
    assert.equal(getSpotPosition(options).status, "opening");
    markSpotOpeningSubmitted(opening.id, { buyTx: "buy-tx" }, options);
    assert.equal(getSpotPosition(options).buyTx, "buy-tx");

    const open = confirmSpotOpen(opening.id, {
      tokenAmount: 100,
      tokenRawAmount: "1000000",
      tokenDecimals: 4,
      entryTokenUsd: 0.01,
      entrySolUsd: 150,
      entryCostSol: 0.504,
      buyTx: "buy-tx",
    }, options);
    assert.equal(open.entryCostSol, 0.504);
    updateSpotObservation(open.id, { pnlPct: 4, peakPnlPct: 4, currentValueSol: 0.524 }, options);
    markSpotClosing(open.id, { reason: "take profit", solBalanceBeforeClose: 0.4, tokenBalanceBeforeClose: 100 }, options);
    const closed = completeSpotClose(open.id, {
      sellTx: "sell-tx",
      exitSol: 0.54,
      pnlSol: 0.036,
      pnlPct: 7.14,
      reason: "take profit",
    }, options);
    assert.equal(closed.status, "closed");
    assert.equal(getSpotPosition(options), null);
  });
});

test("spot opening completion is idempotent when realtime reconciliation wins the race", () => {
  withTempFiles(({ statePath }) => {
    const options = { statePath };
    const opening = beginSpotOpen({
      pool: "pool",
      poolName: "MEME-SOL",
      mint: "mint",
      symbol: "MEME",
      entryCostSol: 0.5,
      solBalanceBefore: 1,
      tokenBalanceBefore: 0,
      tokenRawBalanceBefore: "0",
      tokenDecimals: 4,
    }, options);
    confirmSpotOpen(opening.id, {
      tokenAmount: 100,
      tokenRawAmount: "1000000",
      tokenDecimals: 4,
      entryCostSol: 0.5,
    }, options);

    assert.doesNotThrow(() => markSpotOpeningSubmitted(opening.id, { buyTx: "buy-tx" }, options));
    const reconciledAgain = confirmSpotOpen(opening.id, {
      tokenAmount: 100,
      tokenRawAmount: "1000000",
      tokenDecimals: 4,
      entryCostSol: 0.502,
      buyTx: "buy-tx",
    }, options);
    assert.equal(reconciledAgain.status, "open");
    assert.equal(reconciledAgain.buyTx, "buy-tx");
    assert.equal(reconciledAgain.entryCostSol, 0.502);
  });
});

test("opening spot state reconciles from finalized balance growth", async () => {
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const opening = {
    id: "spot-reconcile",
    status: "opening",
    pool: "11111111111111111111111111111111",
    mint,
    symbol: "MEME",
    entryCostSol: 0.5,
    solBalanceBefore: 1.2,
    tokenRawBalanceBefore: "50000",
    tokenDecimals: 3,
    buyTx: "buy-tx",
  };
  let priceReads = 0;
  let confirmed = null;
  const snapshot = await getSpotPositionSnapshot({}, {
    spotConfig: buildSpotConfig({}),
    readSpotPosition: () => opening,
    getTokenBalanceByMint: async (requestedMint) => requestedMint === SOL_MINT
      ? { amount: 0.695, raw_amount: "695000000", decimals: 9 }
      : { amount: 150, raw_amount: "150000", decimals: 3 },
    getJupiterPrices: async () => {
      priceReads += 1;
      if (priceReads === 1) throw new Error("temporary price outage");
      return { [mint]: { usdPrice: 0.5, blockId: 1_000 }, [SOL_MINT]: { usdPrice: 100, blockId: 1_000 } };
    },
    getActiveBin: async () => { throw new Error("temporary active-bin outage"); },
    confirmSpotOpen: (_id, data) => {
      confirmed = data;
      return { ...opening, ...data, status: "open", openedAt: "2026-09-02T00:00:00.000Z", peakPnlPct: 0 };
    },
    getFinalizedSlot: async () => 1_000,
    updateSpotObservation: (_id, observation) => ({ ...opening, status: "open", ...confirmed, ...observation }),
    now: () => new Date("2026-09-02T00:01:00.000Z"),
  });
  assert.equal(snapshot.status, "open");
  assert.equal(confirmed.tokenRawAmount, "100000");
  assert.equal(confirmed.tokenAmount, 100);
  assert.equal(confirmed.entryTokenUsd, null);
  assert.ok(Math.abs(confirmed.entryCostSol - 0.505) < 1e-12);
  assert.equal(snapshot.price_source, "jupiter_price_v3_fallback");
});

test("opening reconciliation rejects an airdrop without the exact SOL debit", async () => {
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const position = {
    id: "spot-airdrop",
    status: "opening",
    mint,
    entryCostSol: 0.5,
    solBalanceBefore: 1.2,
    tokenRawBalanceBefore: "0",
    tokenDecimals: 3,
  };
  const snapshot = await getSpotPositionSnapshot({}, {
    spotConfig: buildSpotConfig({}),
    readSpotPosition: () => position,
    getTokenBalanceByMint: async (requestedMint) => requestedMint === SOL_MINT
      ? { amount: 1.2, raw_amount: "1200000000", decimals: 9 }
      : { amount: 100, raw_amount: "100000", decimals: 3 },
  });
  assert.equal(snapshot.status, "opening");
  assert.match(snapshot.reason, /SOL debit/i);
});

test("spot budget caps turnover and blocks after the realized loss limit", () => {
  withTempFiles(({ budgetPath }) => {
    const now = new Date("2026-09-02T10:00:00.000Z");
    const first = reserveSpotBuy({ amountSol: 0.5, maxDailyBuySol: 1, maxDailyLossSol: 0.05, budgetPath, now });
    commitSpotBuy(first, { budgetPath, now });
    const second = reserveSpotBuy({ amountSol: 0.5, maxDailyBuySol: 1, maxDailyLossSol: 0.05, budgetPath, now });
    commitSpotBuy(second, { budgetPath, now });
    assert.throws(
      () => reserveSpotBuy({ amountSol: 0.01, maxDailyBuySol: 1, maxDailyLossSol: 0.05, budgetPath, now }),
      /daily spot buy cap/i,
    );
    recordSpotRealizedPnl({ pnlSol: -0.05, budgetPath, now });
    assert.throws(
      () => reserveSpotBuy({ amountSol: 0.5, maxDailyBuySol: 2, maxDailyLossSol: 0.05, budgetPath, now }),
      /daily spot loss cap/i,
    );
    assert.equal(getSpotRiskBudget({ budgetPath, now }).realizedPnlSol, -0.05);
  });
});

test("spot daily buy turnover can be unlimited while the daily loss breaker stays active", () => {
  withTempFiles(({ budgetPath }) => {
    const now = new Date("2026-09-02T10:00:00.000Z");
    const first = reserveSpotBuy({ amountSol: 0.5, maxDailyBuySol: null, maxDailyLossSol: 0.05, budgetPath, now });
    commitSpotBuy(first, { budgetPath, now });
    const second = reserveSpotBuy({ amountSol: 0.5, maxDailyBuySol: null, maxDailyLossSol: 0.05, budgetPath, now });
    commitSpotBuy(second, { budgetPath, now });

    const budget = getSpotRiskBudget({ budgetPath, now, maxDailyBuySol: null, maxDailyLossSol: 0.05 });
    assert.equal(budget.boughtSol, 1);
    assert.equal(budget.maxDailyBuySol, null);

    recordSpotRealizedPnl({ pnlSol: -0.05, budgetPath, now });
    assert.throws(
      () => reserveSpotBuy({ amountSol: 0.5, maxDailyBuySol: null, maxDailyLossSol: 0.05, budgetPath, now }),
      /daily spot loss cap/i,
    );
  });
});

test("spot status reports unlimited turnover without treating prior buys as blocked", () => {
  const status = getSpotStatus({}, {
    tradingMode: "spot_momentum",
    spotConfig: buildSpotConfig({ spotMaxDailyBuySol: null }),
    readSpotPosition: () => null,
    getSpotHistory: () => [],
    getSpotRiskBudget: () => ({
      date: "2026-09-02",
      boughtSol: 100,
      reservedSol: 0,
      realizedPnlSol: 0,
      reservations: {},
      maxDailyBuySol: null,
      maxDailyLossSol: 0.05,
    }),
  });

  assert.equal(status.risk_budget.maxDailyBuySol, null);
  assert.equal(status.risk_budget.remainingBuySol, null);
  assert.equal(status.risk_budget.blocked, false);
  assert.equal(status.risk_budget.reason, null);
});

test("Jupiter order validation binds mints, minimum output, impact, fees, and freshness", () => {
  const requestedAt = 1_000;
  const order = {
    transaction: "base64-transaction",
    requestId: "request-1",
    swapMode: "ExactIn",
    taker: "Wallet11111111111111111111111111111111111",
    router: "metis",
    lastValidBlockHeight: "123456",
    inputMint: SOL_MINT,
    outputMint: "TokenMint111111111111111111111111111111111",
    inAmount: "500000000",
    outAmount: "1000000",
    otherAmountThreshold: "985000",
    slippageBps: 150,
    priceImpact: -0.8,
    feeBps: 50,
    feeMint: SOL_MINT,
    signatureFeeLamports: 5000,
    signatureFeePayer: "Wallet11111111111111111111111111111111111",
    prioritizationFeeLamports: 2_000_000,
    prioritizationFeePayer: "Wallet11111111111111111111111111111111111",
    rentFeeLamports: 2_000_000,
    rentFeePayer: "Wallet11111111111111111111111111111111111",
    gasless: false,
  };
  assert.doesNotThrow(() => validateJupiterOrder(order, {
    inputMint: SOL_MINT,
    outputMint: order.outputMint,
    inAmount: order.inAmount,
    expectedTaker: order.taker,
    allowedRouters: ["metis", "dflow", "okx"],
    requireTakerPaysFees: true,
    maxSlippageBps: 150,
    maxPriceImpactPct: 1,
    maxFeeBps: 60,
    maxPriorityFeeLamports: 2_000_000,
    maxTotalFeeLamports: 5_000_000,
    quoteMaxAgeMs: 3_000,
    requestedAt,
    now: 2_000,
  }));

  assert.throws(() => validateJupiterOrder({ ...order, priceImpact: -1.2 }, {
    inputMint: SOL_MINT,
    outputMint: order.outputMint,
    inAmount: order.inAmount,
    maxPriceImpactPct: 1,
  }), /price impact/i);
  assert.throws(() => validateJupiterOrder(order, {
    inputMint: SOL_MINT,
    outputMint: order.outputMint,
    inAmount: order.inAmount,
    quoteMaxAgeMs: 3_000,
    requestedAt,
    now: 5_000,
  }), /older than/i);

  assert.throws(() => validateJupiterOrder({ ...order, otherAmountThreshold: "1000001" }, {
    inputMint: SOL_MINT,
    outputMint: order.outputMint,
    inAmount: order.inAmount,
  }), /minimum output exceeds/i);
  assert.throws(() => validateJupiterOrder({ ...order, rentFeeLamports: undefined }, {
    inputMint: SOL_MINT,
    outputMint: order.outputMint,
    inAmount: order.inAmount,
    maxTotalFeeLamports: 5_000_000,
  }), /fee breakdown/i);
  assert.throws(() => validateJupiterOrder({ ...order, taker: "attacker" }, {
    inputMint: SOL_MINT,
    outputMint: order.outputMint,
    inAmount: order.inAmount,
    expectedTaker: order.taker,
  }), /taker/i);
  assert.throws(() => validateJupiterOrder({ ...order, router: "jupiterz" }, {
    inputMint: SOL_MINT,
    outputMint: order.outputMint,
    inAmount: order.inAmount,
    allowedRouters: ["metis", "dflow", "okx"],
  }), /router/i);
  assert.throws(() => validateJupiterOrder({ ...order, gasless: true }, {
    inputMint: SOL_MINT,
    outputMint: order.outputMint,
    inAmount: order.inAmount,
    expectedTaker: order.taker,
    requireTakerPaysFees: true,
  }), /gasless/i);
  assert.throws(() => validateJupiterOrder({ ...order, signatureFeePayer: "sponsor" }, {
    inputMint: SOL_MINT,
    outputMint: order.outputMint,
    inAmount: order.inAmount,
    expectedTaker: order.taker,
    requireTakerPaysFees: true,
  }), /fee payer/i);
});

test("round-trip quote validation binds both mints, amount, impact, fee, and minimum output", () => {
  const quote = {
    swapMode: "ExactIn",
    inputMint: SOL_MINT,
    outputMint: "TokenMint111111111111111111111111111111111",
    inAmount: "500000000",
    outAmount: "1000000",
    otherAmountThreshold: "985000",
    slippageBps: 150,
    priceImpact: -0.4,
    feeBps: 10,
    feeMint: SOL_MINT,
    router: "metis",
    mode: "manual",
  };
  const validated = validateJupiterQuote(quote, {
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.inAmount,
    maxSlippageBps: 150,
    maxPriceImpactPct: 1,
    maxFeeBps: 60,
  });
  assert.equal(validated.outAmount, "1000000");
  assert.equal(validated.priceImpactPct, -0.4);

  assert.throws(() => validateJupiterQuote({ ...quote, outputMint: "attacker" }, {
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.inAmount,
  }), /mint pair/i);
  assert.throws(() => validateJupiterQuote({ ...quote, otherAmountThreshold: "1000001" }, {
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.inAmount,
  }), /minimum output exceeds/i);
});

test("a profit exit rejects any Jupiter order whose minimum net SOL can fall below locked profit", () => {
  const sellOrder = {
    transaction: "base64-transaction",
    requestId: "request-profit",
    swapMode: "ExactIn",
    taker: "Wallet11111111111111111111111111111111111",
    router: "metis",
    lastValidBlockHeight: "123456",
    inputMint: "TokenMint111111111111111111111111111111111",
    outputMint: SOL_MINT,
    inAmount: "1000000",
    outAmount: "505000000",
    otherAmountThreshold: "502000000",
    slippageBps: 50,
    priceImpact: -0.2,
    feeBps: 0,
    feeMint: SOL_MINT,
    signatureFeeLamports: 5000,
    signatureFeePayer: "Wallet11111111111111111111111111111111111",
    prioritizationFeeLamports: 300000,
    prioritizationFeePayer: "Wallet11111111111111111111111111111111111",
    rentFeeLamports: 0,
    rentFeePayer: "Wallet11111111111111111111111111111111111",
    gasless: false,
  };
  const policy = {
    inputMint: sellOrder.inputMint,
    outputMint: SOL_MINT,
    inAmount: sellOrder.inAmount,
    expectedTaker: sellOrder.taker,
    allowedRouters: ["metis", "dflow", "okx"],
    requireTakerPaysFees: true,
    maxSlippageBps: 50,
    maxPriceImpactPct: 3,
    maxFeeBps: 60,
    maxPriorityFeeLamports: 2000000,
    maxTotalFeeLamports: 5000000,
    minimumNetOutputLamports: "501000000",
  };

  const accepted = validateJupiterOrder(sellOrder, policy);
  assert.equal(accepted.minimumNetOutputAmount, "501695000");
  assert.throws(
    () => validateJupiterOrder(sellOrder, { ...policy, minimumNetOutputLamports: "501700000" }),
    /net output floor/i,
  );
});

test("simulation effects enforce exact input and bounded minimum output", () => {
  assert.doesNotThrow(() => validateSimulatedSwapEffects({
    inputMint: SOL_MINT,
    outputMint: "token",
    inAmount: "500000000",
    minimumOutAmount: "985000",
    totalFeeLamports: "2000000",
    walletLamportsBefore: "1000000000",
    walletLamportsAfter: "498000000",
    outputTokenRawBefore: "0",
    outputTokenRawAfter: "1000000",
  }));
  assert.throws(() => validateSimulatedSwapEffects({
    inputMint: SOL_MINT,
    outputMint: "token",
    inAmount: "500000000",
    minimumOutAmount: "985000",
    totalFeeLamports: "2000000",
    walletLamportsBefore: "1000000000",
    walletLamportsAfter: "497000000",
    outputTokenRawBefore: "0",
    outputTokenRawAfter: "1000000",
  }), /fees/i);

  assert.doesNotThrow(() => validateSimulatedSwapEffects({
    inputMint: "token",
    outputMint: SOL_MINT,
    inAmount: "1000000",
    minimumOutAmount: "500000000",
    totalFeeLamports: "2000000",
    walletLamportsBefore: "400000000",
    walletLamportsAfter: "898000000",
    inputTokenRawBefore: "1000000",
    inputTokenRawAfter: "0",
  }));
  assert.throws(() => validateSimulatedSwapEffects({
    inputMint: "token",
    outputMint: SOL_MINT,
    inAmount: "1000000",
    minimumOutAmount: "500000000",
    totalFeeLamports: "2000000",
    walletLamportsBefore: "400000000",
    walletLamportsAfter: "898000000",
    inputTokenRawBefore: "1000000",
    inputTokenRawAfter: "1",
  }), /exact requested token input/i);
});

test("transport or parse failure after swap submission remains uncertain with local signature", async () => {
  await assert.rejects(runSubmittedSwapStep(async () => { throw new TypeError("fetch failed"); }, "local-sig"), (error) => {
    assert.equal(error.submissionAttempted, true);
    assert.equal(error.signature, "local-sig");
    return true;
  });
});

test("Jupiter execution result is bound to local signature and min output", () => {
  const result = {
    status: "Success",
    code: 0,
    signature: "local-signature",
    totalInputAmount: "500000000",
    totalOutputAmount: "1000000",
  };
  assert.deepEqual(validateJupiterExecutionResult(result, {
    expectedSignature: "local-signature",
    inAmount: "500000000",
    minimumOutAmount: "985000",
  }), {
    inputAmount: "500000000",
    outputAmount: "1000000",
    signature: "local-signature",
  });
  assert.throws(() => validateJupiterExecutionResult({ ...result, signature: "other" }, {
    expectedSignature: "local-signature",
    inAmount: "500000000",
    minimumOutAmount: "985000",
  }), /signature/i);
  assert.throws(() => validateJupiterExecutionResult({ ...result, totalOutputAmount: "984999" }, {
    expectedSignature: "local-signature",
    inAmount: "500000000",
    minimumOutAmount: "985000",
  }), /minimum output/i);
});

test("Jupiter transaction envelope permits only the wallet as sole signer", () => {
  const wallet = "wallet";
  const transaction = {
    message: {
      staticAccountKeys: [{ toBase58: () => wallet }],
      header: { numRequiredSignatures: 1 },
    },
  };
  assert.equal(validateJupiterTransactionEnvelope(transaction, wallet), true);
  assert.throws(() => validateJupiterTransactionEnvelope(transaction, "other"), /fee payer/i);
  assert.throws(() => validateJupiterTransactionEnvelope({
    message: { ...transaction.message, header: { numRequiredSignatures: 2 } },
  }, wallet), /exactly one/i);
});

test("spot open records only tokens acquired by the fixed 0.5 SOL entry", async () => {
  const pool = "11111111111111111111111111111111";
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const spotConfig = buildSpotConfig({});
  let solReads = 0;
  let tokenReads = 0;
  let buyArgs = null;
  let confirmed = null;
  let roundTripReads = 0;
  let openingData = null;
  const result = await openSpotPosition({ pool_address: pool }, {
    tradingMode: "spot_momentum",
    spotConfig,
    dryRun: false,
    readSpotPosition: () => null,
    getMyPositions: async () => ({ total_positions: 0, positions: [] }),
    getPoolDetail: async () => ({
      pool_address: pool,
      pool_type: "dlmm",
      token_x: { address: mint, symbol: "MEME", organic_score: 82, market_cap: 900_000, created_at: Date.now() - 4 * 3_600_000 },
      token_y: { address: SOL_MINT, symbol: "SOL" },
      tvl: 80_000,
      active_tvl: 80_000,
      volume: 12_000,
      volume_active_tvl_ratio: 0.15,
      base_token_holders: 1_200,
      pool_price_change_pct: 4.2,
      volume_change_pct: 35,
    }),
    getTokenInfo: async () => ({ results: [{ ...passingCandidate().tokenInfo, mint }] }),
    confirmIndicatorPreset: async () => passingCandidate().pool.indicator_confirmation,
    inspectMintSafety: async () => ({ mint, mintAuthorityDisabled: true, freezeAuthorityDisabled: true }),
    getSpotRoundTripQuote: async () => {
      roundTripReads += 1;
      return { pass: true, expectedLossPct: 0.4, expectedReturnLamports: "498000000" };
    },
    getTokenBalanceByMint: async (requestedMint) => {
      if (requestedMint === SOL_MINT) {
        solReads += 1;
        return solReads === 1
          ? { amount: 1.2, raw_amount: "1200000000", decimals: 9 }
          : { amount: 0.695, raw_amount: "695000000", decimals: 9 };
      }
      tokenReads += 1;
      return tokenReads === 1
        ? { amount: 50, raw_amount: "50000", decimals: 3 }
        : { amount: 150, raw_amount: "150000", decimals: 3 };
    },
    reserveSpotBuy: () => ({ id: "reservation", amountSol: 0.5 }),
    beginSpotOpen: (data) => { openingData = data; return { id: "spot-test" }; },
    markSpotOpeningSubmitted: () => true,
    buySpotToken: async (args) => { buyArgs = args; return { success: true, tx: "buy-tx" }; },
    commitSpotBuy: () => true,
    getJupiterPrices: async () => ({
      [mint]: { usdPrice: 0.01 },
      [SOL_MINT]: { usdPrice: 100 },
    }),
    confirmSpotOpen: (_id, data) => {
      confirmed = data;
      return { id: "spot-test", pool, mint, symbol: "MEME", ...data };
    },
    appendDecision: () => {},
  });
  assert.equal(result.trade_status, "open");
  assert.equal(buyArgs.amountSol, 0.5);
  assert.equal(confirmed.tokenRawAmount, "100000");
  assert.equal(confirmed.tokenAmount, 100);
  assert.ok(Math.abs(confirmed.entryCostSol - 0.505) < 1e-12);
  assert.equal(roundTripReads, 1);
  assert.equal(openingData.signalSnapshot.roundTripExpectedLossPct, 0.4);
});

test("dry-run spot entry performs no transaction, state, or budget write", async () => {
  const pool = "11111111111111111111111111111111";
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  let writeAttempts = 0;
  let buyAttempts = 0;
  const result = await openSpotPosition({ pool_address: pool }, {
    tradingMode: "spot_momentum",
    spotConfig: buildSpotConfig({}),
    dryRun: true,
    readSpotPosition: () => null,
    getMyPositions: async () => ({ total_positions: 0, positions: [] }),
    getPoolDetail: async () => ({
      pool_address: pool,
      pool_type: "dlmm",
      token_x: { address: mint, symbol: "MEME", organic_score: 82, market_cap: 900_000, created_at: Date.now() - 4 * 3_600_000 },
      token_y: { address: SOL_MINT, symbol: "SOL" },
      tvl: 80_000,
      active_tvl: 80_000,
      volume: 12_000,
      base_token_holders: 1_200,
      pool_price_change_pct: 4.2,
      volume_change_pct: 35,
    }),
    getTokenInfo: async () => ({ results: [{ ...passingCandidate().tokenInfo, mint }] }),
    confirmIndicatorPreset: async () => passingCandidate().pool.indicator_confirmation,
    inspectMintSafety: async () => ({ mint, mintAuthorityDisabled: true, freezeAuthorityDisabled: true }),
    getSpotRoundTripQuote: async () => ({ pass: true, expectedLossPct: 0.4, expectedReturnLamports: "498000000" }),
    reserveSpotBuy: () => { writeAttempts += 1; },
    beginSpotOpen: () => { writeAttempts += 1; },
    buySpotToken: async () => { buyAttempts += 1; },
  });
  assert.equal(result.dry_run, true);
  assert.equal(result.would_open.amount_sol, 0.5);
  assert.equal(writeAttempts, 0);
  assert.equal(buyAttempts, 0);
});

test("spot snapshot and close value only the tracked tokens, not unrelated wallet holdings", async () => {
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const position = {
    id: "spot-test",
    status: "open",
    pool: "11111111111111111111111111111111",
    mint,
    symbol: "MEME",
    tokenAmount: 100,
    tokenRawAmount: "100000",
    tokenDecimals: 3,
    entryCostSol: 0.5,
    openedAt: "2026-09-02T00:00:00.000Z",
    peakPnlPct: 0,
  };
  let jupiterPriceReads = 0;
  const snapshot = await getSpotPositionSnapshot({}, {
    spotConfig: buildSpotConfig({}),
    readSpotPosition: () => position,
    getTokenBalanceByMint: async () => ({ amount: 150, raw_amount: "150000", decimals: 3 }),
    getActiveBin: async () => ({ binId: 42, price: "0.01" }),
    getJupiterPrices: async () => {
      jupiterPriceReads += 1;
      throw new Error("Jupiter price API must not be used when the on-chain active bin is available");
    },
    updateSpotObservation: (_id, observation) => ({ ...position, ...observation }),
    now: () => new Date("2026-09-02T00:01:00.000Z"),
  });
  assert.equal(snapshot.current_value_sol, 1);
  assert.equal(snapshot.price_source, "meteora_active_bin_confirmed");
  assert.equal(snapshot.active_bin_id, 42);
  assert.equal(snapshot.block_lag, null);
  assert.equal(snapshot.token_balance.position_amount, 100);
  assert.equal(jupiterPriceReads, 0);

  let tokenReads = 0;
  let solReads = 0;
  let sold = null;
  let recordedPnl = null;
  const closed = await closeSpotPosition({ reason: "TAKE_PROFIT: lock a real net gain" }, {
    dryRun: false,
    spotConfig: buildSpotConfig({
      spotTakeProfitPct: 1,
      spotMinProfitExitPct: 0.1,
      spotProfitExitSlippageBps: 50,
    }),
    readSpotPosition: () => position,
    getTokenBalanceByMint: async (requestedMint) => {
      if (requestedMint === SOL_MINT) {
        solReads += 1;
        return solReads === 1
          ? { amount: 0.4, raw_amount: "400000000", decimals: 9 }
          : { amount: 0.93, raw_amount: "930000000", decimals: 9 };
      }
      tokenReads += 1;
      return tokenReads === 1
        ? { amount: 150, raw_amount: "150000", decimals: 3 }
        : { amount: 50, raw_amount: "50000", decimals: 3 };
    },
    markSpotClosing: () => ({ ...position, status: "closing" }),
    sellSpotToken: async (args) => { sold = args; return { success: true, tx: "sell-tx", output_amount_atomic: "530000000" }; },
    recordSpotRealizedPnl: ({ pnlSol }) => { recordedPnl = pnlSol; },
    completeSpotClose: (_id, data) => ({ ...position, status: "closed", ...data }),
    appendDecision: () => {},
  });
  assert.equal(sold.rawAmount, "100000");
  assert.equal(sold.amount, 100);
  assert.equal(sold.slippageBps, 50);
  assert.equal(sold.minimumNetOutputLamports, "500500000");
  assert.equal(closed.trade_status, "closed");
  assert.ok(Math.abs(recordedPnl - 0.03) < 1e-12);
});
