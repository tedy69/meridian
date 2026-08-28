import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateStopLossExecution,
  isUrgentStopLossClose,
  revalidateStopLossExecution,
  selectExitConfirmationTicks,
} from "../stop-loss-safety.js";

async function withTemporaryState(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-stop-loss-state-"));
  const previousStateFile = process.env.MERIDIAN_STATE_FILE;
  process.env.MERIDIAN_STATE_FILE = path.join(directory, "state.json");
  try {
    const state = await import(`../state.js?stop-loss-test=${Date.now()}-${Math.random()}`);
    await callback(state);
  } finally {
    if (previousStateFile === undefined) delete process.env.MERIDIAN_STATE_FILE;
    else process.env.MERIDIAN_STATE_FILE = previousStateFile;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("state emits stop-loss at the early trigger, not only at the intended maximum", async () => {
  await withTemporaryState(async (state) => {
    const position = "Position11111111111111111111111111111111111";
    state.trackPosition({ position, pool: "Pool111111111111111111111111111111111111" });

    const exit = state.updatePnlAndCheckExits(position, {
      pnl_pct: -8.01,
      pnl_pct_suspicious: false,
      in_range: true,
      fee_per_tvl_24h: 10,
    }, {
      stopLossPct: -15,
      stopLossTriggerPct: -8,
      trailingTakeProfit: false,
      outOfRangeWaitMinutes: 30,
      minFeePerTvl24h: 7,
      minAgeBeforeYieldCheck: 60,
    });

    assert.equal(exit?.action, "STOP_LOSS");
    assert.match(exit?.reason || "", /-8%/);
  });
});

test("stop-loss can submit from its early trigger before the intended loss ceiling", () => {
  assert.deepEqual(
    evaluateStopLossExecution({
      currentPnlPct: -8.25,
      triggerPnlPct: -8,
      maximumPnlPct: -15,
    }),
    {
      allowed: true,
      reason: null,
      currentPnlPct: -8.25,
      triggerPnlPct: -8,
      maximumPnlPct: -15,
      atOrBeyondMaximum: false,
    },
  );
});

test("stop-loss skips a stale signal when fresh RPC PnL recovered above its trigger", () => {
  assert.deepEqual(
    evaluateStopLossExecution({
      currentPnlPct: -7.5,
      triggerPnlPct: -8,
      maximumPnlPct: -15,
    }),
    {
      allowed: false,
      reason: "fresh_pnl_recovered_above_trigger",
      currentPnlPct: -7.5,
      triggerPnlPct: -8,
      maximumPnlPct: -15,
      atOrBeyondMaximum: false,
    },
  );
});

test("stop-loss remains executable when fresh RPC PnL is already beyond its intended ceiling", () => {
  assert.deepEqual(
    evaluateStopLossExecution({
      currentPnlPct: -15.25,
      triggerPnlPct: -8,
      maximumPnlPct: -15,
    }),
    {
      allowed: true,
      reason: "fresh_pnl_at_or_beyond_maximum",
      currentPnlPct: -15.25,
      triggerPnlPct: -8,
      maximumPnlPct: -15,
      atOrBeyondMaximum: true,
    },
  );
});

test("fresh stop-loss revalidation rejects unavailable or suspicious PnL", async () => {
  const unavailable = await revalidateStopLossExecution({
    positionAddress: "Position111",
    triggerPnlPct: -8,
    maximumPnlPct: -15,
    fetchPositions: async () => ({ positions: [] }),
  });
  assert.equal(unavailable.allowed, false);
  assert.equal(unavailable.reason, "fresh_position_unavailable");

  const suspicious = await revalidateStopLossExecution({
    positionAddress: "Position111",
    triggerPnlPct: -8,
    maximumPnlPct: -15,
    fetchPositions: async () => ({
      positions: [{ position: "Position111", pnl_pct: -12, pnl_pct_suspicious: true }],
    }),
  });
  assert.equal(suspicious.allowed, false);
  assert.equal(suspicious.reason, "fresh_pnl_suspicious");
});

test("stop-loss uses a one-tick confirmation while other exits retain the configured confirmation", () => {
  assert.equal(selectExitConfirmationTicks({
    exitAction: "STOP_LOSS",
    defaultConfirmTicks: 2,
    stopLossConfirmTicks: 1,
  }), 1);
  assert.equal(selectExitConfirmationTicks({
    exitAction: "TRAILING_TP",
    defaultConfirmTicks: 2,
    stopLossConfirmTicks: 1,
  }), 2);
});

test("only an automatic stop-loss close qualifies for claim-and-close prioritization", () => {
  assert.equal(isUrgentStopLossClose("Stop loss: PnL -8.20% <= trigger -8%"), true);
  assert.equal(isUrgentStopLossClose("manual Telegram close"), false);
  assert.equal(isUrgentStopLossClose("Trailing TP: peak 5%"), false);
});
