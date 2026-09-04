import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { selectHybridCandidate, scanHybridCandidates } from "../hybrid-strategy.js";

const spot = { pool: "spot", spot_score: 80, round_trip_quote: { expectedLossPct: 0.2, pass: true } };
const lp = { pool: "lp", score: 90, indicator_confirmation: { enabled: true, confirmed: true,
  intervals: [{ ok: true, confirmed: true }] } };

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
