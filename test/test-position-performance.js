import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "../prompt.js";
import { calculateOpenPositionPerformance } from "../position-performance.js";

test("positive LP fees do not turn a larger capital loss into floating profit", () => {
  const performance = calculateOpenPositionPerformance({
    depositsUsd: 100,
    balancesUsd: 90,
    withdrawalsUsd: 0,
    claimedFeesUsd: 2,
    unclaimedFeesUsd: 6,
  });

  assert.deepEqual(performance, {
    available: true,
    capitalPnlUsd: -10,
    feeContributionUsd: 8,
    netPnlUsd: -2,
    netPnlPct: -2,
    netPnlStatus: "FLOATING_NET_LOSS",
    capitalStatus: "CAPITAL_LOSS",
  });
});

test("fee-covered capital loss stays transparent even when total net PnL is positive", () => {
  const performance = calculateOpenPositionPerformance({
    depositsUsd: 100,
    balancesUsd: 97,
    withdrawalsUsd: 0,
    claimedFeesUsd: 1,
    unclaimedFeesUsd: 4,
  });

  assert.equal(performance.netPnlStatus, "FLOATING_NET_PROFIT");
  assert.equal(performance.capitalStatus, "CAPITAL_LOSS");
  assert.equal(performance.capitalPnlUsd, -3);
  assert.equal(performance.feeContributionUsd, 5);
  assert.equal(performance.netPnlUsd, 2);
});

test("the OpenRouter prompt requires net PnL classification and fee disclosure", () => {
  const prompt = buildSystemPrompt(
    "GENERAL",
    {},
    {
      total_positions: 1,
      positions: [{
        pair: "LOSS-SOL",
        net_pnl_status: "FLOATING_NET_LOSS",
        net_pnl_usd: -2,
        capital_pnl_usd: -10,
        fee_contribution_usd: 8,
      }],
    },
  );

  assert.match(prompt, /PNL ACCOUNTING — MANDATORY/);
  assert.match(prompt, /net_pnl_status/);
  assert.match(prompt, /FLOATING_NET_LOSS/);
  assert.match(prompt, /positive fee.*not.*profit/i);
});
