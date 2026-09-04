import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildTradingConfig } from "../config.js";
import { createHybridEntryGuard, evaluateHybridBudget, assertHybridSimulationBalance, markHybridSubmissionAttempted } from "../hybrid-risk.js";

const policy = { maxPositionSol: 0.5, reserveSol: 0.1, maxDailyLossSol: 0.05, lpCostBufferSol: 0.02, spotCostBufferSol: 0.005 };
test("hybrid is explicit and retains legacy default", () => {
  assert.equal(buildTradingConfig({ tradingMode: "hybrid" }).mode, "hybrid");
  assert.equal(buildTradingConfig({}).mode, "dlmm_lp");
});
test("both strategies share capital, fee buffer, reserve and a loss cap", () => {
  assert.equal(evaluateHybridBudget({ strategy: "spot", amountSol: 0.5, walletSol: 0.604, lossSol: 0, policy }).pass, false);
  assert.equal(evaluateHybridBudget({ strategy: "lp", amountSol: 0.5, walletSol: 0.619, lossSol: 0, policy }).pass, false);
  assert.equal(evaluateHybridBudget({ strategy: "lp", amountSol: 0.3, walletSol: 0.62, lossSol: 0.05, policy }).pass, false);
  assert.equal(evaluateHybridBudget({ strategy: "spot", amountSol: 0.51, walletSol: 2, lossSol: 0, policy }).pass, false);
  assert.equal(evaluateHybridBudget({ strategy: "spot", amountSol: 0.5, walletSol: 0.62, lossSol: 0, policy }).pass, true);
});

async function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-hybrid-"));
  let wallet = 0.65;
  let position = null;
  let lp = { total_positions: 0, positions: [] };
  let pending = [];
  const guard = createHybridEntryGuard({ directory, policy, now: () => new Date("2026-09-04T12:00:00Z"),
    getSpotPosition: () => position, getTrackedPositions: () => [], getPendingSettlements: () => pending,
    getLpPositions: async () => lp, getWalletSol: async () => wallet, getPriorLossSol: () => 0 });
  try { await run({ guard, setWallet: (v) => wallet = v, setPosition: (v) => position = v,
    setLp: (v) => lp = v, setPending: (v) => pending = v }); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("concurrent spot/LP admissions cannot both execute", async () => fixture(async ({ guard }) => {
  let release;
  const hold = new Promise((resolve) => release = resolve);
  const first = guard.run({ strategy: "spot", amountSol: 0.5 }, async () => { await hold; return { success: true, position: { id: "spot1" } }; });
  await assert.rejects(guard.run({ strategy: "lp", amountSol: 0.5 }, async () => assert.fail("must not execute")), /entry.*lock|pending.*entry/i);
  release();
  await first;
}));

test("missing LP snapshot, active exposure and pending settlement fail closed", async () => fixture(async ({ guard, setLp, setPosition, setPending }) => {
  setLp(null);
  await assert.rejects(guard.run({ strategy: "spot", amountSol: 0.5 }, async () => assert.fail()), /snapshot/i);
  setLp({ total_positions: 0, positions: [] });
  setPosition({ status: "opening" });
  await assert.rejects(guard.run({ strategy: "lp", amountSol: 0.5 }, async () => assert.fail()), /position|exposure/i);
  setPosition(null); setPending([{}]);
  await assert.rejects(guard.run({ strategy: "spot", amountSol: 0.5 }, async () => assert.fail()), /settlement/i);
}));

test("uncertain execution keeps durable lock; no timed unlock", async () => fixture(async ({ guard }) => {
  await guard.run({ strategy: "lp", amountSol: 0.5 }, async () => ({ success: true, position: null }));
  await assert.rejects(guard.run({ strategy: "spot", amountSol: 0.5 }, async () => assert.fail()), /entry.*lock|pending.*entry/i);
}));

test("a swallowed LP submission failure cannot release the entry lock", async () => fixture(async ({ guard }) => {
  const result = await guard.run({ strategy: "lp", amountSol: 0.5 }, async () => {
    markHybridSubmissionAttempted();
    return { success: false, error: "confirmation timeout" };
  });
  assert.equal(result.pending, true);
  await assert.rejects(guard.run({ strategy: "spot", amountSol: 0.5 }, async () => assert.fail()), /entry.*lock|pending.*entry/i);
}));

test("flat-wallet losses aggregate across strategies and profits never erase them", async () => fixture(async ({ guard, setWallet }) => {
  const done = async () => ({ success: true, position: "known" });
  await guard.run({ strategy: "lp", amountSol: 0.2 }, done);
  setWallet(0.62); await guard.run({ strategy: "spot", amountSol: 0.2 }, done);
  setWallet(0.66); await guard.run({ strategy: "lp", amountSol: 0.2 }, done);
  setWallet(0.63);
  await assert.rejects(guard.run({ strategy: "spot", amountSol: 0.2 }, done), /loss cap/i);
}));

test("LP simulation cannot consume reserve or exceed reserved total debit", async () => fixture(async ({ guard }) => {
  await guard.run({ strategy: "lp", amountSol: 0.3 }, async () => {
    assert.throws(() => assertHybridSimulationBalance(0.09), /reserve/i);
    assert.throws(() => assertHybridSimulationBalance(0.32), /debit/i);
    assert.doesNotThrow(() => assertHybridSimulationBalance(0.33));
    return { success: true, position: "known" };
  });
}));
