import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { scanHybridCandidates } from "../hybrid-strategy.js";
import { createMarketDataCache } from "../market-data-cache.js";
import { withReadDeadline } from "../read-deadline.js";
import { runScreeningPipeline } from "../screening-pipeline.js";

// Execute the actual daemon declaration, not index.js module initialization: all
// wallet, network, state, logging, and transaction dependencies below are fakes.
const daemonSource = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
const declarationStart = daemonSource.indexOf("async function runHybridScreeningCycle");
const declarationEnd = daemonSource.indexOf("export async function runManagementCycle", declarationStart);
assert.ok(declarationStart >= 0 && declarationEnd > declarationStart, "the production hybrid cycle must be extractable");
const hybridCycleSource = daemonSource.slice(declarationStart, declarationEnd);

async function settleWithin(promise, ms = 300) {
  let watchdog;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("Regression probe did not settle")), ms);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

function candidate(pool) {
  return { pool, spot_score: 80, round_trip_quote: { expectedLossPct: 0.2, pass: true } };
}

function cycleHarness(overrides = {}) {
  const decisions = [];
  const health = [];
  const logs = [];
  const executions = [];
  const readSignals = [];
  const cache = createMarketDataCache();
  const execute = overrides.executeTool || (async () => ({ success: true }));
  const dependencies = {
    config: {
      hybrid: { maxDailyLossSol: 0.05, reserveSol: 0.1, spotCostBufferSol: 0.005 },
      spot: { tradeAmountSol: 0.5 },
      strategy: { strategy: "bidask" },
      risk: {},
    },
    runtimeHealth: {
      skipped: (reason) => health.push({ event: "skipped", reason }),
      stage: (stage, detail) => health.push({ event: "stage", stage, detail }),
      complete: (status, report) => health.push({ event: "complete", status, report }),
    },
    log: (category, message) => logs.push({ category, message }),
    wakeRealtimeExits: () => {},
    getHybridRiskStatus: () => ({ entry_pending: false }),
    readSpotPosition: () => null,
    getTrackedPositions: () => [],
    getMyPositions: async () => ({ positions: [], total_positions: 0 }),
    getEntrySolBalance: async () => ({ sol: 1 }),
    getSpotStatus: () => ({ risk_budget: { blocked: false } }),
    evaluateLossCircuitBreaker: () => ({ pass: true }),
    getAllPerformanceRecords: () => [],
    getCircuitAdjustedDeploySizing: () => ({ funded: true, amount: 0.15 }),
    getSpotMomentumCandidates: async () => ({ candidates: [candidate("qualified")] }),
    getTopCandidates: async () => ({ candidates: [] }),
    hybridLpCache: {
      get: (key, loader, options) => cache.get(key, loader, { ...options, requestTimeoutMs: 60 }),
    },
    scanHybridCandidates: (options) => scanHybridCandidates({ ...options, timeoutMs: 60 }),
    withReadDeadline: (read, options) => withReadDeadline(read, { ...options, timeoutMs: 60 }),
    runScreeningPipeline: (options) => runScreeningPipeline({
      ...options,
      timeoutMs: 20,
      read: ({ signal }) => {
        readSignals.push(signal);
        return options.read({ signal });
      },
    }),
    computeBinsBelow: () => 35,
    formatConfirmedSpotOpenResult: (result) => ({ text: result.success ? "Spot entry confirmed." : "Spot entry unresolved." }),
    appendDecision: (decision) => decisions.push(decision),
    telegramEnabled: () => false,
    sendMessage: () => assert.fail("the integration harness must never send a message"),
    ...overrides,
    executeTool: (name, args) => {
      executions.push({ name, args });
      return execute(name, args);
    },
  };
  const buildCycle = new Function(...Object.keys(dependencies), `
    let _screeningBusy = false;
    let _managementBusy = false;
    let _claimAllBusy = false;
    let _screeningLastTriggered = 0;
    const timers = {};
    ${hybridCycleSource}
    return { run: runHybridScreeningCycle, isBusy: () => _screeningBusy };
  `);
  return { ...buildCycle(...Object.values(dependencies)), decisions, health, logs, executions, readSignals };
}

test("daemon screening releases a timed-out read, accepts a later cycle, and never executes the late old selection", { timeout: 1_000 }, async () => {
  let finishExpiredScan;
  let scans = 0;
  const harness = cycleHarness({
    getSpotMomentumCandidates: () => {
      scans += 1;
      if (scans === 1) return new Promise((resolve) => { finishExpiredScan = resolve; });
      return Promise.resolve({ candidates: [candidate("fresh")] });
    },
  });

  const first = harness.run({ silent: true });
  assert.equal(harness.isBusy(), true);
  const timedOutReport = await settleWithin(first);
  assert.match(timedOutReport, /timeout|timed out|deadline/i);
  assert.equal(harness.isBusy(), false);
  assert.equal(harness.readSignals[0].aborted, true);
  assert.equal(harness.executions.length, 0);
  assert.equal(harness.decisions.at(-1).type, "hybrid_error");
  assert.equal(harness.health.at(-1).status, "error");

  const recoveredReport = await settleWithin(harness.run({ silent: true }));
  assert.equal(recoveredReport, "Spot entry confirmed.");
  assert.equal(harness.isBusy(), false);
  assert.equal(scans, 2);
  assert.deepEqual(harness.executions, [{ name: "open_spot_position", args: { pool_address: "fresh" } }]);

  finishExpiredScan({ candidates: [candidate("expired")] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.executions.length, 1, "the old successful response cannot submit after its read deadline");
  assert.equal(harness.decisions.length, 2, "late read completion must not append a new selection");
});

test("daemon retains its busy guard during a pending execution beyond the read deadline and rejects concurrent cycles", { timeout: 1_000 }, async () => {
  let finishExecution;
  let signalExecutionStarted;
  const executionWait = new Promise((resolve) => { finishExecution = resolve; });
  const executionStarted = new Promise((resolve) => { signalExecutionStarted = resolve; });
  const harness = cycleHarness({
    executeTool: () => {
      signalExecutionStarted();
      return executionWait;
    },
  });
  let settled = false;
  const observed = harness.run({ silent: true }).then(
    (value) => { settled = true; return { status: "fulfilled", value }; },
    (error) => { settled = true; return { status: "rejected", error }; },
  );

  try {
    await settleWithin(executionStarted);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(settled, false);
    assert.equal(harness.isBusy(), true, "read timeout cannot release a possibly submitted transaction");
    assert.equal(harness.readSignals[0].aborted, false);
    assert.equal(harness.health.some((event) => event.event === "complete"), false);
    assert.equal(await settleWithin(harness.run({ silent: true })), null);
    assert.equal(harness.health.at(-1).event, "skipped");
    assert.match(harness.health.at(-1).reason, /screening is busy/i);
    assert.deepEqual(harness.executions, [{ name: "open_spot_position", args: { pool_address: "qualified" } }]);

    finishExecution({ success: true });
    const outcome = await settleWithin(observed);
    assert.equal(outcome.status, "fulfilled");
    assert.equal(outcome.value, "Spot entry confirmed.");
    assert.equal(harness.isBusy(), false);
    assert.equal(harness.executions.length, 1);
    assert.equal(harness.decisions.at(-1).type, "hybrid_selection");
  } finally {
    finishExecution({ success: false });
  }
});

test("daemon treats an empty position response with an RPC error as unknown exposure and records the entry block", { timeout: 1_000 }, async () => {
  const harness = cycleHarness({
    getMyPositions: async () => ({ error: "RPC unavailable", positions: [], total_positions: 0 }),
    getSpotMomentumCandidates: () => assert.fail("unknown exposure must stop candidate reads"),
    getTopCandidates: () => assert.fail("unknown exposure must stop candidate reads"),
  });

  const report = await settleWithin(harness.run({ silent: true }));
  assert.match(report, /exposure.*cannot be verified/i);
  assert.equal(harness.isBusy(), false);
  assert.equal(harness.executions.length, 0);
  assert.equal(harness.decisions.length, 1);
  assert.equal(harness.decisions[0].type, "hybrid_error");
  assert.match(harness.decisions[0].reason, /exposure.*cannot be verified/i);
  assert.equal(harness.health.at(-1).status, "error", "provider failures must not be counted as successful no-trade scans");
});

test("a verified open LP position is a normal screening block, not a provider failure", async () => {
  const harness = cycleHarness({
    getMyPositions: async () => ({ positions: [{ pool: "existing" }], total_positions: 1 }),
  });
  const report = await settleWithin(harness.run({ silent: true }));
  assert.match(report, /exposure.*present/i);
  assert.equal(harness.executions.length, 0);
  assert.equal(harness.health.at(-1).status, "no_trade");
  assert.equal(harness.decisions[0].type, "hybrid_no_trade");
});
