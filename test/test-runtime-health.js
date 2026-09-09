import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeHealth, evaluateRuntimeHealth } from "../runtime-health.js";

test("completed scans expose partial provider failure and pending settlement as unready", () => {
  const health = createRuntimeHealth();
  health.start();
  health.complete("degraded", "Spot provider unavailable; LP screening completed");
  const degraded = evaluateRuntimeHealth(health.snapshot());
  assert.equal(degraded.ready, false);
  assert.equal(degraded.status, "degraded");
  assert.match(degraded.reason, /Spot provider/);
  health.complete("blocked", "Pending LP settlement blocks new entries");
  assert.equal(evaluateRuntimeHealth(health.snapshot()).ready, false);
  health.complete("no_trade", "No eligible candidates");
  assert.equal(evaluateRuntimeHealth(health.snapshot()).ready, true);
});

test("a living process with a stale scanner is unhealthy, not silently healthy", () => {
  let now = 1_000;
  const health = createRuntimeHealth({ now: () => now });
  health.start({ monitorScanner: true, maxScanAgeMs: 60_000 });
  health.stage("reading", "pool discovery");
  now += 61_000;
  health.heartbeat();
  const result = evaluateRuntimeHealth(health.snapshot(), now);
  assert.equal(result.healthy, false);
  assert.match(result.reason, /scanner|screening/i);
});

test("completed no-trade scans are healthy and skipped busy ticks cannot mask a hang", () => {
  let now = 1_000;
  const health = createRuntimeHealth({ now: () => now });
  health.start({ monitorScanner: true, maxScanAgeMs: 60_000 });
  health.stage("reading", "wallet");
  now += 5_000;
  health.complete("no_trade", "No eligible candidate");
  assert.equal(evaluateRuntimeHealth(health.snapshot(), now).healthy, true);
  now += 61_000;
  health.skipped("scanner busy");
  health.heartbeat();
  assert.equal(evaluateRuntimeHealth(health.snapshot(), now).healthy, false);
});

test("stale heartbeat, repeated read errors and unresolved execution are visible without unlocking transactions", () => {
  let now = 1_000;
  const health = createRuntimeHealth({ now: () => now });
  health.start({ monitorScanner: true });
  now += 31_000;
  assert.equal(evaluateRuntimeHealth(health.snapshot(), now).healthy, false);
  for (let i = 0; i < 3; i++) health.complete("error", "Read timeout");
  health.heartbeat();
  assert.match(evaluateRuntimeHealth(health.snapshot(), now).reason, /fail|error/i);
  health.complete("no_trade", "recovered");
  assert.equal(evaluateRuntimeHealth(health.snapshot(), now).healthy, true);
  health.stage("executing", "lp");
  now += 181_000;
  health.heartbeat();
  assert.match(evaluateRuntimeHealth(health.snapshot(), now).reason, /execution|reconciliation/i);
  assert.equal(health.snapshot().scanner.phase, "executing");
});

test("explicitly paused scans are distinguished from failure but still need a fresh process heartbeat", () => {
  let now = 1_000;
  const health = createRuntimeHealth({ now: () => now });
  health.start({ monitorScanner: true });
  health.pause();
  now += 90_000;
  health.heartbeat();
  assert.equal(evaluateRuntimeHealth(health.snapshot(), now).healthy, true);
  now += 31_000;
  assert.equal(evaluateRuntimeHealth(health.snapshot(), now).healthy, false);
});
