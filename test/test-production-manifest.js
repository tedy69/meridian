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
