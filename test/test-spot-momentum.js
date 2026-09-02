import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSpotConfig, buildTradingConfig } from "../config.js";
import { SOL_MINT } from "../execution-guard.js";
import {
  calculateSpotPnlPct,
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
  validateJupiterExecutionResult,
  validateJupiterOrder,
  validateJupiterTransactionEnvelope,
  validateSimulatedSwapEffects,
} from "../tools/wallet.js";
import { closeSpotPosition, getSpotPositionSnapshot, openSpotPosition } from "../tools/spot.js";

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
      indicator_confirmation: { confirmed: true, skipped: false },
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
  assert.equal(spot.stopLossTriggerPct, -4);
  assert.equal(spot.stopLossPct, -5);
  assert.equal(spot.takeProfitPct, 6);
  assert.equal(spot.managementPollIntervalSec, 1);
  assert.equal(spot.realtimeEnabled, true);
  assert.equal(spot.realtimeCommitment, "processed");
  assert.equal(spot.realtimeEventDebounceMs, 100);
  assert.equal(spot.realtimeMinRefreshMs, 1_000);
  assert.equal(buildSpotConfig({ spotRealtimeMinRefreshMs: 200 }).realtimeMinRefreshMs, 200);
  assert.throws(() => buildSpotConfig({ spotRealtimeEnabled: "false" }), /spotRealtimeEnabled/i);
  assert.throws(() => buildSpotConfig({ spotRealtimeCommitment: "fastest" }), /spotRealtimeCommitment/i);
  assert.throws(() => buildSpotConfig({ spotRealtimeEventDebounceMs: 10 }), /spotRealtimeEventDebounceMs/i);
});

test("candidate gate requires safe audit, SOL quote, and confirmed momentum", () => {
  const candidate = passingCandidate();
  const accepted = evaluateSpotMomentumCandidate(candidate);
  assert.equal(accepted.pass, true);
  assert.ok(accepted.score > 0);
  candidate.pool.volume_active_tvl_ratio = 99;
  assert.equal(evaluateSpotMomentumCandidate(candidate).metrics.volumeLiquidityRatio, 0.15);

  const authorityEnabled = structuredClone(candidate);
  authorityEnabled.tokenInfo.audit.mint_disabled = false;
  assert.match(evaluateSpotMomentumCandidate(authorityEnabled).reason, /mint authority/i);

  const chasing = structuredClone(candidate);
  chasing.pool.price_change_pct = 18;
  assert.match(evaluateSpotMomentumCandidate(chasing).reason, /chase limit/i);

  const staleMomentum = structuredClone(candidate);
  staleMomentum.pool.indicator_confirmation.skipped = true;
  assert.match(evaluateSpotMomentumCandidate(staleMomentum).reason, /momentum/i);
});

test("spot exits prioritize the early stop trigger and fixed take profit", () => {
  const position = {
    entryCostSol: 0.5,
    openedAt: "2026-09-02T00:00:00.000Z",
    peakPnlPct: 0,
  };
  assert.equal(calculateSpotPnlPct(0.5, 0.48), -4.0000000000000036);
  assert.equal(evaluateSpotExit({ position, currentValueSol: 0.48 }).action, "STOP_LOSS");
  assert.equal(evaluateSpotExit({ position, currentValueSol: 0.53 }).action, "TAKE_PROFIT");

  const trailing = evaluateSpotExit({
    position: { ...position, peakPnlPct: 5 },
    currentValueSol: 0.5175,
  });
  assert.equal(trailing.action, "TRAILING_TAKE_PROFIT");
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
    confirmIndicatorPreset: async () => ({ confirmed: true, skipped: false, intervals: [] }),
    inspectMintSafety: async () => ({ mint, mintAuthorityDisabled: true, freezeAuthorityDisabled: true }),
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
    beginSpotOpen: () => ({ id: "spot-test" }),
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
    confirmIndicatorPreset: async () => ({ confirmed: true, skipped: false, intervals: [] }),
    inspectMintSafety: async () => ({ mint, mintAuthorityDisabled: true, freezeAuthorityDisabled: true }),
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
  const snapshot = await getSpotPositionSnapshot({}, {
    spotConfig: buildSpotConfig({}),
    readSpotPosition: () => position,
    getTokenBalanceByMint: async () => ({ amount: 150, raw_amount: "150000", decimals: 3 }),
    getJupiterPrices: async () => ({ [mint]: { usdPrice: 1, blockId: 1_005 }, [SOL_MINT]: { usdPrice: 100, blockId: 1_006 } }),
    getFinalizedSlot: async () => 1_000,
    updateSpotObservation: (_id, observation) => ({ ...position, ...observation }),
    now: () => new Date("2026-09-02T00:01:00.000Z"),
  });
  assert.equal(snapshot.current_value_sol, 1);
  assert.equal(snapshot.block_lag, 0);
  assert.equal(snapshot.token_balance.position_amount, 100);

  let tokenReads = 0;
  let solReads = 0;
  let sold = null;
  let recordedPnl = null;
  const closed = await closeSpotPosition({ reason: "test close" }, {
    dryRun: false,
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
  assert.equal(closed.trade_status, "closed");
  assert.ok(Math.abs(recordedPnl - 0.03) < 1e-12);
});
