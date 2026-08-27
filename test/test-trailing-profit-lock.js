import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function withTemporaryState(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-trailing-state-"));
  const previousStateFile = process.env.MERIDIAN_STATE_FILE;
  process.env.MERIDIAN_STATE_FILE = path.join(directory, "state.json");
  try {
    const state = await import(`../state.js?trailing-test=${Date.now()}-${Math.random()}`);
    await callback(state);
  } finally {
    if (previousStateFile === undefined) delete process.env.MERIDIAN_STATE_FILE;
    else process.env.MERIDIAN_STATE_FILE = previousStateFile;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("trailing take-profit does not close below its configured profit floor", async () => {
  await withTemporaryState(async (state) => {
    const position = "Position11111111111111111111111111111111111";
    state.trackPosition({ position, pool: "Pool111111111111111111111111111111111111" });
    state.confirmPeak(position, 3.14, 1);

    const exit = state.updatePnlAndCheckExits(position, {
      pnl_pct: 0.11,
      pnl_pct_suspicious: false,
      in_range: true,
      fee_per_tvl_24h: 10,
    }, {
      stopLossPct: -15,
      trailingTakeProfit: true,
      trailingTriggerPct: 3,
      trailingDropPct: 1.5,
      trailingMinClosePnlPct: 1,
      outOfRangeWaitMinutes: 30,
      minFeePerTvl24h: 7,
      minAgeBeforeYieldCheck: 60,
    });

    assert.equal(exit, null);
  });
});

test("trailing take-profit remains eligible above its configured profit floor", async () => {
  await withTemporaryState(async (state) => {
    const position = "Position22222222222222222222222222222222222";
    state.trackPosition({ position, pool: "Pool222222222222222222222222222222222222" });
    state.confirmPeak(position, 3.14, 1);

    const exit = state.updatePnlAndCheckExits(position, {
      pnl_pct: 1.5,
      pnl_pct_suspicious: false,
      in_range: true,
      fee_per_tvl_24h: 10,
    }, {
      stopLossPct: -15,
      trailingTakeProfit: true,
      trailingTriggerPct: 3,
      trailingDropPct: 1.5,
      trailingMinClosePnlPct: 1,
      outOfRangeWaitMinutes: 30,
      minFeePerTvl24h: 7,
      minAgeBeforeYieldCheck: 60,
    });

    assert.equal(exit?.action, "TRAILING_TP");
  });
});
