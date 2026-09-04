import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("runtime node-fetch fallback is declared directly", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(manifest.dependencies?.["node-fetch"] || "", /^\^?2\./);
});

test("syntax test script propagates parse failures", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(manifest.scripts?.["test:syntax"] || "", /xargs -0 -n 1 node --check/);
});

test("Docker builds exclude live spot state and hybrid admission/risk ledgers", () => {
  const ignored = fs.readFileSync(new URL("../.dockerignore", import.meta.url), "utf8").split(/\r?\n/);
  for (const file of ["spot-state.json", "spot-risk-budget.json", "hybrid-entry-lock.json", "hybrid-risk-budget.json"]) {
    assert.ok(ignored.includes(file), `${file} must remain runtime-only`);
  }
});

test("the runtime dependency volume is mounted at a node_modules path", () => {
  const compose = fs.readFileSync(new URL("../compose.yaml", import.meta.url), "utf8");
  const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

  assert.match(compose, /target:\s*\/runtime\/node_modules/);
  assert.match(dockerfile, /\/runtime\/node_modules/);
});

test("new configurations default to a three percent take-profit target", () => {
  const source = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");

  assert.match(
    source,
    /takeProfitPct:\s*u\.takeProfitPct\s*\?\?\s*u\.takeProfitFeePct\s*\?\?\s*3,/,
  );
});

test("spot screening trusts finalized RPC SOL instead of the indexed wallet API", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const start = source.indexOf("async function runSpotScreeningCycle");
  const end = source.indexOf("\nexport async function runManagementCycle", start);
  const cycle = source.slice(start, end > start ? end : undefined);

  assert.match(cycle, /getTokenBalanceByMint\(SOL_MINT\)/);
  assert.doesNotMatch(cycle, /getWalletBalances\(\)/);
});

test("automatic spot entry keeps the LLM out of the latency-critical transaction path", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const start = source.indexOf("async function runSpotScreeningCycle");
  const end = source.indexOf("\nexport async function runManagementCycle", start);
  const cycle = source.slice(start, end > start ? end : undefined);

  assert.match(cycle, /selectSpotEntryCandidate\(candidates\)/);
  assert.doesNotMatch(cycle, /agentLoop\s*\(/);
  assert.match(cycle, /executeTool\("open_spot_position"/);
});
