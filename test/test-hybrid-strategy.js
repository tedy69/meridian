import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { selectHybridCandidate, scanHybridCandidates } from "../hybrid-strategy.js";

const spot = { pool: "spot", spot_score: 80, round_trip_quote: { expectedLossPct: 0.2, pass: true } };
const lp = { pool: "lp", score: 90, indicator_confirmation: { enabled: true, confirmed: true,
  intervals: [{ ok: true, confirmed: true }] } };

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

test("a hung spot source times out without discarding an independently qualified LP", { timeout: 1_000 }, async () => {
  let spotSignal;
  let lpSignal;
  const result = await settleWithin(scanHybridCandidates({
    timeoutMs: 20,
    scanSpot: (options) => {
      spotSignal = options?.signal;
      return new Promise(() => {});
    },
    scanLp: async (options) => {
      lpSignal = options?.signal;
      return { candidates: [lp] };
    },
  }));

  assert.equal(result.selected.strategy, "lp");
  assert.deepEqual(result.lp.candidates, [lp]);
  assert.deepEqual(result.spot.candidates, []);
  assert.match(result.spot.error, /timeout|timed out|deadline/i);
  assert.ok(spotSignal instanceof AbortSignal);
  assert.equal(spotSignal.aborted, true);
  assert.ok(lpSignal instanceof AbortSignal);
});

test("an empty spot scan and hung LP source finish with an explicit error and no entry", { timeout: 1_000 }, async () => {
  let lpSignal;
  const result = await settleWithin(scanHybridCandidates({
    timeoutMs: 20,
    scanSpot: async () => ({ candidates: [] }),
    scanLp: (options) => {
      lpSignal = options?.signal;
      return new Promise(() => {});
    },
  }));

  assert.equal(result.selected, null);
  assert.deepEqual(result.spot.candidates, []);
  assert.deepEqual(result.lp.candidates, []);
  assert.match(result.lp.error, /timeout|timed out|deadline/i);
  assert.ok(lpSignal instanceof AbortSignal);
  assert.equal(lpSignal.aborted, true);
});

test("a fast spot result returns without waiting for LP and its abandoned source remains bounded", { timeout: 1_000 }, async () => {
  let lpSignal;
  const result = await settleWithin(scanHybridCandidates({
    timeoutMs: 20,
    scanSpot: async () => ({ candidates: [spot] }),
    scanLp: (options) => {
      lpSignal = options?.signal;
      return new Promise(() => {});
    },
  }));

  assert.equal(result.selected.strategy, "spot");
  assert.equal(result.lp.pending, true, "spot need not wait for LP's deadline");
  assert.ok(lpSignal instanceof AbortSignal);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(lpSignal.aborted, true, "an unused LP read cannot remain in flight forever");
  assert.equal(result.selected.strategy, "spot");
});

test("hybrid prefers validated fast momentum, otherwise an independently qualified LP", () => {
  assert.equal(selectHybridCandidate({ spot: [spot], lp: [lp] }).strategy, "spot");
  assert.equal(selectHybridCandidate({ spot: [], lp: [lp] }).strategy, "lp");
  assert.equal(selectHybridCandidate({ spot: [], lp: [] }), null);
  assert.equal(selectHybridCandidate({ spot: [], lp: [{ ...lp, indicator_confirmation: null }] }), null);
});

test("both scanners run, and source errors are distinguishable from zero candidates", async () => {
  let lpCalls = 0;
  const result = await scanHybridCandidates({
    scanSpot: async () => { throw new Error("spot feed 429"); },
    scanLp: async () => { lpCalls++; return { candidates: [lp] }; },
  });
  assert.equal(lpCalls, 1);
  assert.equal(result.spot.error, "spot feed 429");
  assert.equal(result.selected.strategy, "lp");
});

test("a qualified spot entry does not wait for the slower LP scanner", async () => {
  let release;
  const lpWait = new Promise((resolve) => release = resolve);
  const result = await scanHybridCandidates({ scanSpot: async () => ({ candidates: [spot] }), scanLp: () => lpWait });
  assert.equal(result.selected.strategy, "spot");
  assert.equal(result.lp.pending, true);
  release({ candidates: [lp] });
});

test("daemon routes hybrid screening and monitors both spot and LP positions", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(source, /config\.trading\.mode === "hybrid"\) return runHybridScreeningCycle/);
  assert.match(source, /if \(isLpEnabled\(\)\) pnlPollInterval/);
  assert.match(source, /onRefresh: \(\) => runSpotManagementCycle/);
  assert.match(source, /if \(isSpotEnabled\(\) && readSpotPosition\(\)\) return runSpotManagementCycle/);
});

test("direct LP execution and buy submission retain the shared guard", () => {
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  const wallet = fs.readFileSync(new URL("../tools/wallet.js", import.meta.url), "utf8");
  assert.match(dlmm, /withHybridEntry\(\{ strategy: "lp"/);
  assert.match(dlmm, /assertHybridSimulationBalance/);
  assert.match(wallet, /Hybrid spot buy requires shared entry admission/);
});
