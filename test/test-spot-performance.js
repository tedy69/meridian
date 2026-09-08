import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSpotPerformance, replaySpotExits } from "../spot-performance.js";

test("equal wins and losses can still have negative realized expectancy", () => {
  const trades = [0.005, 0.006, -0.017, -0.018].map((pnlSol) => ({ status: "closed", pnlSol }));
  const result = summarizeSpotPerformance(trades);
  assert.equal(result.closedTrades, 4);
  assert.equal(result.winRatePct, 50);
  assert.ok(Math.abs(result.realizedNetSol + 0.024) < 1e-10);
  assert.ok(result.averageLossSol > result.averageWinSol * 3);
  assert.ok(result.breakEvenWinRatePct > 75);
  assert.equal(result.profitableSample, false);
});

test("missing realized PnL is excluded explicitly, never booked as break-even", () => {
  const result = summarizeSpotPerformance([
    { status: "closed", pnlSol: null }, { status: "closed", pnlSol: "bad" },
    { status: "opening", pnlSol: 1 }, { status: "closed", pnlSol: 0 },
  ]);
  assert.equal(result.closedTrades, 1);
  assert.equal(result.invalidClosedTrades, 2);
  assert.equal(result.breakEvenTrades, 1);
  assert.equal(result.breakEvenWinRatePct, null);
});

test("a gross green quote is not profit after exit fees and minimum output", () => {
  const result = replaySpotExits({ entryCostSol: 0.501, openedAt: "2026-09-07T00:00:00Z", quotes: [
    { at: "2026-09-07T00:00:01Z", minimumOutSol: 0.502, exitFeeSol: 0.003 },
  ], policy: { takeProfitPct: 0.1 } });
  assert.equal(result.action, "HOLD");
  assert.ok(result.lastNetPnlPct < 0);
});

test("replay selects a net-profitable exit and uses full measured entry cost", () => {
  const result = replaySpotExits({ entryCostSol: 0.501, openedAt: "2026-09-07T00:00:00Z", quotes: [
    { at: "2026-09-07T00:00:01Z", minimumOutSol: 0.515, exitFeeSol: 0.001 },
  ] });
  assert.equal(result.action, "TAKE_PROFIT");
  assert.ok(Math.abs(result.netPnlSol - 0.013) < 1e-10);
  assert.equal(result.executed, false, "a replay must never claim a real fill");
});

test("replay preserves loss exits instead of pretending every trade can be profitable", () => {
  const result = replaySpotExits({ entryCostSol: 0.5, openedAt: "2026-09-07T00:00:00Z", quotes: [
    { at: "2026-09-07T00:00:01Z", minimumOutSol: 0.48, exitFeeSol: 0.001 },
  ] });
  assert.equal(result.action, "STOP_LOSS");
  assert.ok(result.netPnlSol < 0);
});

test("replay includes exit fees even when they exceed sale proceeds", () => {
  const result = replaySpotExits({ entryCostSol: 0.5, openedAt: "2026-09-07T00:00:00Z", quotes: [
    { at: "2026-09-07T00:00:01Z", minimumOutSol: 0, exitFeeSol: 0.001 },
  ] });
  assert.equal(result.action, "STOP_LOSS");
  assert.ok(Math.abs(result.netPnlSol + 0.501) < 1e-10);
  assert.ok(Math.abs(result.lastNetPnlPct + 100.2) < 1e-10);
  assert.equal(result.executed, false);
});

test("replay refuses missing fees and disordered observations", () => {
  const args = { entryCostSol: 0.5, openedAt: "2026-09-07T00:00:00Z" };
  assert.throws(() => replaySpotExits({ ...args, quotes: [{ at: "2026-09-07T00:00:01Z", minimumOutSol: 0.5 }] }), /fee/i);
  assert.throws(() => replaySpotExits({ ...args, quotes: [{ at: "2026-09-06T23:59:00Z", minimumOutSol: 0.5, exitFeeSol: 0 }] }), /order|time/i);
});
