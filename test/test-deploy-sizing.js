import assert from "node:assert/strict";
import test from "node:test";
import { computeDeployAmount, formatSolAmount } from "../config.js";

test("an uncapped full-wallet deploy keeps the configured gas reserve", () => {
  const amount = computeDeployAmount(1.053766, {
    gasReserve: 0.2,
    positionSizePct: 1,
    deployAmountSol: 0.5,
    maxDeployAmount: null,
  });

  assert.equal(amount, 0.85);
});

test("an uncapped full-wallet deploy floors at two decimals to preserve gas reserve", () => {
  const amount = computeDeployAmount(1.059, {
    gasReserve: 0.2,
    positionSizePct: 1,
    deployAmountSol: 0.5,
    maxDeployAmount: null,
  });

  assert.equal(amount, 0.85);
});

test("SOL amounts always render with two decimal places", () => {
  assert.equal(formatSolAmount(0.8), "0.80");
  assert.equal(formatSolAmount(0.85), "0.85");
});
