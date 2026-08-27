import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateTrailingProfitFloor,
  isLosingTrailingExit,
  normalizeSlippageBps,
  revalidateTrailingProfitFloor,
} from "../trailing-safety.js";

test("a trailing close is blocked when fresh PnL falls below its profit floor", () => {
  assert.deepEqual(
    evaluateTrailingProfitFloor({ currentPnlPct: 0.11, minimumPnlPct: 1 }),
    {
      allowed: false,
      reason: "fresh_pnl_below_profit_floor",
      currentPnlPct: 0.11,
      minimumPnlPct: 1,
    },
  );
});

test("a trailing close can proceed when fresh PnL remains at or above its profit floor", () => {
  assert.deepEqual(
    evaluateTrailingProfitFloor({ currentPnlPct: 1, minimumPnlPct: 1 }),
    {
      allowed: true,
      reason: null,
      currentPnlPct: 1,
      minimumPnlPct: 1,
    },
  );
});

test("only a losing trailing exit applies the re-entry cooldown", () => {
  assert.equal(isLosingTrailingExit({ closeReason: "Trailing TP: peak 3.14% → current 0.11%", pnlPct: -1.22 }), true);
  assert.equal(isLosingTrailingExit({ closeReason: "Trailing TP: peak 4% → current 2%", pnlPct: 2 }), false);
  assert.equal(isLosingTrailingExit({ closeReason: "stop loss", pnlPct: -20 }), false);
});

test("automatic settlement slippage is constrained to valid Jupiter basis points", () => {
  assert.equal(normalizeSlippageBps(500), 500);
  assert.equal(normalizeSlippageBps(-1), null);
  assert.equal(normalizeSlippageBps(10_001), null);
  assert.equal(normalizeSlippageBps("not-a-number"), null);
});

test("fresh trailing revalidation fails closed when the PnL falls below the profit floor", async () => {
  const decision = await revalidateTrailingProfitFloor({
    positionAddress: "Position111",
    minimumPnlPct: 1,
    fetchPositions: async () => ({
      positions: [{ position: "Position111", pnl_pct: 0.11, pnl_pct_suspicious: false }],
    }),
  });

  assert.deepEqual(decision, {
    allowed: false,
    reason: "fresh_pnl_below_profit_floor",
    currentPnlPct: 0.11,
    minimumPnlPct: 1,
  });
});

test("fresh trailing revalidation fails closed when an RPC read is unavailable", async () => {
  const decision = await revalidateTrailingProfitFloor({
    positionAddress: "Position111",
    minimumPnlPct: 1,
    fetchPositions: async () => { throw new Error("RPC unavailable"); },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "fresh_pnl_unavailable");
});
