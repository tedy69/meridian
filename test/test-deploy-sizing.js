import assert from "node:assert/strict";
import test from "node:test";
import {
  computeDeployAmount,
  formatSolAmount,
  getAutoDeploySizing,
} from "../config.js";

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

test("auto deploy uses the balance below its preferred size while preserving gas reserve", () => {
  const sizing = getAutoDeploySizing(0.673723, {
    gasReserve: 0.2,
    positionSizePct: 1,
    deployAmountSol: 0.5,
    maxDeployAmount: null,
  });

  assert.equal(sizing.funded, true);
  assert.equal(sizing.amount, 0.47);
  assert.equal(sizing.minimumAmount, 0.47);
  assert.equal(sizing.reserve, 0.2);
});

test("auto deploy needs at least one cent beyond its gas reserve", () => {
  const sizing = getAutoDeploySizing(0.21, {
    gasReserve: 0.2,
    positionSizePct: 1,
    deployAmountSol: 0.5,
    maxDeployAmount: null,
  });

  assert.equal(sizing.funded, true);
  assert.equal(sizing.amount, 0.01);
  assert.equal(sizing.minimumAmount, 0.01);

  const insufficient = getAutoDeploySizing(0.209, {
    gasReserve: 0.2,
    positionSizePct: 1,
    deployAmountSol: 0.5,
    maxDeployAmount: null,
  });

  assert.equal(insufficient.funded, false);
  assert.equal(insufficient.amount, 0);
});

test("SOL amounts always render with two decimal places", () => {
  assert.equal(formatSolAmount(0.8), "0.80");
  assert.equal(formatSolAmount(0.85), "0.85");
});
