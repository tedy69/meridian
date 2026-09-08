import assert from "node:assert/strict";
import test from "node:test";
import { config, buildRiskConfig } from "../config.js";
import { evaluateLossCircuitBreaker } from "../risk-intelligence.js";
import { getSpotExitQuote } from "../tools/wallet.js";
import { getSpotPositionSnapshot } from "../tools/spot.js";

test("legacy loss cooldown settings cannot freeze re-entry after a losing streak", () => {
  const now = new Date("2026-09-08T00:00:00Z");
  const policy = buildRiskConfig({ lossCircuitCooldownHours: 12, lossCircuitStreakCooldownHours: 6 });
  const performance = [-1, -2, -3].map((pnl_pct, index) => ({
    pnl_pct, recorded_at: new Date(now.getTime() - (3 - index) * 1_000).toISOString(),
  }));
  const result = evaluateLossCircuitBreaker({ performance, policy, now });
  assert.equal(result.pass, true);
  assert.equal(result.blockedUntil, null);
  assert.equal(result.recoveryMode, true);
  assert.equal(result.recoverySizePct, 0.5);
});

test("each completed exit-quote read sees the new market, while overlapping reads coalesce", async (t) => {
  const previousKey = config.jupiter.apiKey;
  config.jupiter.apiKey = "test-key";
  t.after(() => { config.jupiter.apiKey = previousKey; });
  let calls = 0;
  const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  t.mock.method(globalThis, "fetch", async (url) => {
    calls += 1;
    const query = new URL(url).searchParams;
    const out = calls === 1 ? "510000000" : "475000000";
    return new Response(JSON.stringify({
      inputMint: query.get("inputMint"), outputMint: query.get("outputMint"),
      inAmount: query.get("amount"), outAmount: out, otherAmountThreshold: String(Number(out) * 0.995),
      swapMode: "ExactIn", slippageBps: 50, priceImpact: 0, feeBps: 0,
      signatureFeeLamports: 5_000, prioritizationFeeLamports: 0, rentFeeLamports: 0,
    }), { status: 200 });
  });
  const args = { mint, rawAmount: "1000000" };
  const [first, concurrent] = await Promise.all([getSpotExitQuote(args), getSpotExitQuote(args)]);
  assert.equal(calls, 1);
  assert.equal(concurrent.netValueSol, first.netValueSol);
  const second = await getSpotExitQuote(args);
  assert.equal(calls, 2, "a completed quote must never mask a subsequent price move");
  assert.ok(second.netValueSol < first.netValueSol);
});

test("Meteora spot stop-loss uses executable proceeds even when the pool mark shows profit", async () => {
  const position = { id: "meteora-spot", pool: "pool", mint: "mint", status: "open",
    priceSource: "meteora_active_bin", tokenRawAmount: "100000", tokenDecimals: 3,
    entryCostSol: 0.5, openedAt: new Date().toISOString(), peakPnlPct: 0 };
  const result = await getSpotPositionSnapshot({}, {
    readSpotPosition: () => position,
    getTokenBalanceByMint: async () => ({ raw_amount: "100000", amount: 100, decimals: 3 }),
    getActiveBin: async () => ({ price: 0.0052, binId: 42 }),
    getSpotExitQuote: async () => ({ netValueSol: 0.485, minimumNetValueSol: 0.4825 }),
    updateSpotObservation: (_id, observation) => ({ ...position, ...observation }),
  });
  assert.equal(result.current_value_sol, 0.485);
  assert.equal(result.exit.action, "STOP_LOSS");
});

test("balance and exit-quote reads begin concurrently", async () => {
  const position = { id: "spot-concurrent", pool: "pool", mint: "mint", status: "open",
    priceSource: "jupiter_quote", tokenRawAmount: "100000", tokenDecimals: 3,
    entryCostSol: 0.5, openedAt: new Date().toISOString(), peakPnlPct: 0 };
  let quoteStarted = false;
  const result = await getSpotPositionSnapshot({}, {
    readSpotPosition: () => position,
    getTokenBalanceByMint: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(quoteStarted, true, "quote must not wait for the balance RPC round trip");
      return { raw_amount: "100000", amount: 100, decimals: 3 };
    },
    getSpotExitQuote: async () => { quoteStarted = true; return { netValueSol: 0.49 }; },
    updateSpotObservation: (_id, observation) => ({ ...position, ...observation }),
  });
  assert.equal(result.balance_verified, true);
  assert.equal(result.exit.action, "STOP_LOSS");
});

test("late quote responses cannot update a position whose close has already started", async () => {
  let position = { id: "closing-race", pool: "pool", mint: "mint", status: "open",
    priceSource: "jupiter_quote", tokenRawAmount: "100000", tokenDecimals: 3,
    entryCostSol: 0.5, openedAt: new Date().toISOString(), peakPnlPct: 0 };
  const result = await getSpotPositionSnapshot({}, {
    readSpotPosition: () => position,
    getTokenBalanceByMint: async () => ({ raw_amount: "100000", amount: 100, decimals: 3 }),
    getSpotExitQuote: async () => { position = { ...position, status: "closing" }; return { netValueSol: 0.45 }; },
    updateSpotObservation: () => assert.fail("a late quote must not overwrite a closing position"),
  });
  assert.equal(result.status, "closing");
  assert.equal(result.priceable, false);
});

test("maximum holding time still triggers when both balance and quote providers fail", async () => {
  const now = new Date("2026-09-08T01:00:00Z");
  const position = { id: "outage", pool: "pool", mint: "mint", status: "open",
    tokenRawAmount: "100000", tokenDecimals: 3, entryCostSol: 0.5,
    openedAt: "2026-09-08T00:00:00Z", peakPnlPct: 0 };
  const result = await getSpotPositionSnapshot({}, {
    readSpotPosition: () => position, now: () => now,
    getTokenBalanceByMint: async () => { throw new Error("balance RPC unavailable"); },
    getSpotExitQuote: async () => { throw new Error("quote unavailable"); },
    markSpotQuoteUnavailable: () => position,
  });
  assert.equal(result.priceable, false);
  assert.equal(result.exit.action, "MAX_HOLD");
});
