import assert from "node:assert/strict";
import test from "node:test";
import { createSpotRealtimeMonitor } from "../spot-realtime.js";

const POOL_A = "11111111111111111111111111111111";
const POOL_B = "So11111111111111111111111111111111111111112";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for realtime monitor state");
    await wait(5);
  }
}

class FakeConnection {
  constructor() {
    this.nextId = 1;
    this.listeners = new Map();
    this.subscriptions = [];
    this.removed = [];
  }

  onAccountChange(publicKey, callback, commitment) {
    const id = this.nextId++;
    this.listeners.set(id, callback);
    this.subscriptions.push({ id, publicKey: publicKey.toBase58(), commitment });
    return id;
  }

  async removeAccountChangeListener(id) {
    this.removed.push(id);
    this.listeners.delete(id);
  }

  emit(id, slot) {
    const callback = this.listeners.get(id);
    if (!callback) throw new Error(`Listener ${id} is not active`);
    callback({}, { slot });
  }
}

test("spot realtime monitor subscribes at processed commitment and coalesces event bursts", async (t) => {
  const connection = new FakeConnection();
  let position = { id: "spot-a", status: "open", pool: POOL_A };
  const refreshes = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const monitor = createSpotRealtimeMonitor({
    connection,
    getPosition: () => position,
    onRefresh: async (metadata) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      refreshes.push(metadata);
      await wait(15);
      concurrent -= 1;
    },
    commitment: "processed",
    eventDebounceMs: 5,
    minRefreshMs: 10,
    fallbackIntervalMs: 1_000,
    logger: () => {},
  });
  t.after(() => monitor.stop());

  await monitor.start();
  await waitFor(() => refreshes.length >= 1 && concurrent === 0);
  assert.deepEqual(connection.subscriptions[0], { id: 1, publicKey: POOL_A, commitment: "processed" });

  const baseline = refreshes.length;
  connection.emit(1, 101);
  connection.emit(1, 102);
  connection.emit(1, 103);
  await waitFor(() => refreshes.length >= baseline + 1 && concurrent === 0);
  await wait(20);

  assert.equal(refreshes.length, baseline + 1);
  assert.equal(refreshes.at(-1).reason, "account_change");
  assert.equal(maxConcurrent, 1);
  const telemetry = monitor.getTelemetry();
  assert.equal(telemetry.websocket_events, 3);
  assert.equal(telemetry.last_event_slot, 103);
  assert.ok(telemetry.coalesced_triggers >= 2);
  assert.equal(telemetry.latency_ms.event_to_refresh.samples, 1);
  assert.ok(telemetry.latency_ms.event_to_refresh.p95 >= 0);

  position = { id: "spot-b", status: "open", pool: POOL_B };
  await monitor.syncNow();
  assert.deepEqual(connection.removed, [1]);
  assert.equal(connection.subscriptions.at(-1).publicKey, POOL_B);

  position = null;
  await monitor.syncNow();
  assert.deepEqual(connection.removed, [1, 2]);
  assert.equal(monitor.getTelemetry().subscribed_pool, null);
});

test("spot realtime fallback refreshes an active position and stops cleanly", async () => {
  const connection = new FakeConnection();
  let refreshCount = 0;
  const monitor = createSpotRealtimeMonitor({
    connection,
    getPosition: () => ({ id: "spot-a", status: "open", pool: POOL_A }),
    onRefresh: async () => { refreshCount += 1; },
    eventDebounceMs: 2,
    minRefreshMs: 5,
    fallbackIntervalMs: 20,
    logger: () => {},
  });

  await monitor.start();
  await waitFor(() => refreshCount >= 3);
  const beforeStop = refreshCount;
  const stopped = await monitor.stop();
  await wait(50);

  assert.equal(refreshCount, beforeStop);
  assert.equal(stopped.running, false);
  assert.equal(stopped.subscribed_pool, null);
  assert.deepEqual(connection.removed, [1]);
});

test("events received during a slow refresh are replayed without overlap", async (t) => {
  const connection = new FakeConnection();
  const reasons = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const monitor = createSpotRealtimeMonitor({
    connection,
    getPosition: () => ({ id: "spot-a", status: "open", pool: POOL_A }),
    onRefresh: async ({ reason }) => {
      reasons.push(reason);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await wait(30);
      concurrent -= 1;
    },
    eventDebounceMs: 2,
    minRefreshMs: 10,
    fallbackIntervalMs: 1_000,
    logger: () => {},
  });
  t.after(() => monitor.stop());

  await monitor.start();
  await waitFor(() => concurrent === 1);
  connection.emit(1, 201);
  connection.emit(1, 202);
  await waitFor(() => reasons.length >= 2 && concurrent === 0);

  assert.deepEqual(reasons.slice(0, 2), ["startup", "account_change"]);
  assert.equal(maxConcurrent, 1);
  assert.ok(monitor.getTelemetry().coalesced_triggers >= 2);
});

test("refresh failures activate bounded backoff and recover after a healthy tick", async (t) => {
  const connection = new FakeConnection();
  let attempts = 0;
  const monitor = createSpotRealtimeMonitor({
    connection,
    getPosition: () => ({ id: "spot-a", status: "open", pool: POOL_A }),
    onRefresh: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("price API rate limited");
    },
    minRefreshMs: 5,
    fallbackIntervalMs: 100,
    errorBackoffBaseMs: 25,
    errorBackoffMaxMs: 50,
    logger: () => {},
  });
  t.after(() => monitor.stop());

  await monitor.start();
  await waitFor(() => monitor.getTelemetry().refresh_errors === 1);
  const failed = monitor.getTelemetry();
  assert.equal(failed.consecutive_refresh_errors, 1);
  assert.ok(failed.backoff_until);

  monitor.triggerRefresh("fallback");
  await waitFor(() => attempts >= 2);
  const recovered = monitor.getTelemetry();
  assert.equal(recovered.consecutive_refresh_errors, 0);
  assert.equal(recovered.backoff_until, null);
});

test("temporary position-state read failures do not drop the active subscription", async (t) => {
  const connection = new FakeConnection();
  let failRead = false;
  const monitor = createSpotRealtimeMonitor({
    connection,
    getPosition: () => {
      if (failRead) throw new Error("temporary disk read failure");
      return { id: "spot-a", status: "open", pool: POOL_A };
    },
    onRefresh: async () => {},
    fallbackIntervalMs: 1_000,
    logger: () => {},
  });
  t.after(() => monitor.stop());

  await monitor.start();
  failRead = true;
  await monitor.syncNow();

  assert.equal(connection.removed.length, 0);
  assert.equal(monitor.getTelemetry().subscribed_pool, POOL_A);
  assert.equal(monitor.getTelemetry().subscription_errors, 1);
});
