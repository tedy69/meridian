import assert from "node:assert/strict";
import test from "node:test";
import * as wallet from "../tools/wallet.js";
import { getTopCandidates } from "../tools/screening.js";
import { config } from "../config.js";

test("round-trip buy and sell quotes share one freshness deadline", async (t) => {
  const original = { trading: config.trading, spot: config.spot, jupiter: config.jupiter };
  t.after(() => Object.assign(config, original));
  config.trading = { ...config.trading, mode: "spot_momentum" };
  config.spot = { ...config.spot, quoteMaxAgeMs: 60 };
  config.jupiter = { ...config.jupiter, apiKey: "unit-test-only" };
  t.mock.method(globalThis, "fetch", async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    const params = new URL(url).searchParams;
    return new Response(JSON.stringify({
      swapMode: "ExactIn", inputMint: params.get("inputMint"), outputMint: params.get("outputMint"),
      inAmount: params.get("amount"), outAmount: "499000000", otherAmountThreshold: "498000000",
      slippageBps: Number(params.get("slippageBps")), priceImpact: 0.1, feeBps: 0,
    }));
  });
  await assert.rejects(wallet.getSpotRoundTripQuote({ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amountSol: 0.5 }), /timed out|freshness/i);
});

test("entry SOL balance uses finalized lamports and preserves a genuine zero", async () => {
  assert.equal(typeof wallet.getEntrySolBalance, "function");
  for (const raw of ["624545822", "0"]) {
    const result = await wallet.getEntrySolBalance({ readBalance: async () => ({
      source: "rpc-finalized", raw_amount: raw, amount: Number(raw) / 1e9,
    }) });
    assert.equal(result.sol, Number(raw) / 1e9);
    assert.equal(result.source, "rpc-finalized");
  }
});

test("entry balance failure is unknown, never a fabricated zero", async () => {
  assert.equal(typeof wallet.getEntrySolBalance, "function");
  await assert.rejects(wallet.getEntrySolBalance({ readBalance: async () => { throw new Error("RPC unavailable"); } }), /cannot verify|unavailable/i);
  await assert.rejects(wallet.getEntrySolBalance({ readBalance: async () => ({ source: "indexer", amount: 0 }) }), /finalized|invalid/i);
  await assert.rejects(wallet.getEntrySolBalance({ readBalance: async () => ({ source: "rpc-finalized", raw_amount: null, amount: 0 }) }), /invalid/i);
});

test("LP screening continues beyond rejected leaders and shares the fresh preflight gate", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("No network allowed in unit tests"); });
  const checked = [];
  const pools = Array.from({ length: 4 }, (_, i) => ({
    pool: `pool-${i}`, name: `TOKEN${i}-SOL`, base: { mint: `mint-${i}` },
    tvl: 50_000, fee_active_tvl_ratio: 1 - i / 10, volatility: 5,
  }));
  const result = await getTopCandidates({ limit: 1 }, {
    discoverPools: async () => ({ pools }),
    getMyPositions: async () => ({ positions: [] }),
    screening: { minTvl: 10_000, maxTvl: 150_000, minFeeActiveTvlRatio: 0.08, avoidPvpSymbols: false },
    isPoolOnCooldown: () => false, isBaseMintOnCooldown: () => false, isDevBlocked: () => false,
    validateCandidate: async (pool) => {
      checked.push(pool.pool);
      return pool.pool === "pool-3"
        ? { pass: true, riskMetrics: { momentum: { enabled: true, confirmed: true, intervals: [{ ok: true, confirmed: true }] } } }
        : { pass: false, reason: "Bot-holder concentration exceeds safety limit" };
    },
  });
  assert.deepEqual(checked, pools.map((p) => p.pool));
  assert.deepEqual(result.candidates.map((p) => p.pool), ["pool-3"]);
  assert.equal(result.fresh_rejected, 3);
  assert.equal(result.candidates[0].indicator_confirmation.confirmed, true);
});
