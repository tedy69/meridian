import assert from "node:assert/strict";
import test from "node:test";
import { computeDeployAmount } from "../config.js";

test("an uncapped full-wallet deploy keeps the configured gas reserve", () => {
  const amount = computeDeployAmount(1.053766, {
    gasReserve: 0.2,
    positionSizePct: 1,
    deployAmountSol: 0.5,
    maxDeployAmount: null,
  });

  assert.equal(amount, 0.85);
});
