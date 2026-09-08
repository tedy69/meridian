import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createAccountRealtimeMonitor, getRealtimeMonitorTelemetry } from "../account-realtime.js";
import { onRuntimeChange, publishRuntimeChange, updateEntryWatchlist, getEntryWatchAccounts } from "../runtime-events.js";

const POOL = "11111111111111111111111111111111";
const POSITION = "So11111111111111111111111111111111111111112";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("realtime probe timed out");
    await wait(2);
  }
}
class FakeConnection {
  next = 0;
  accounts = new Map();
  logs = new Map();
  onAccountChange(address, callback) {
    const id = ++this.next;
    this.accounts.set(id, { address: address.toBase58(), callback });
    return id;
  }
  onLogs(address, callback) {
    const id = ++this.next;
    this.logs.set(id, { address: address.toBase58(), callback });
    return id;
  }
  async removeAccountChangeListener(id) { this.accounts.delete(id); }
  async removeOnLogsListener(id) { this.logs.delete(id); }
}

test("LP pool and position events coalesce, and retired callbacks cannot wake a reused pool", async (t) => {
  const connection = new FakeConnection();
  let targets = [POOL, POSITION, POOL];
  const refreshes = [];
  const monitor = createAccountRealtimeMonitor({ connection, getAccountAddresses: () => targets,
    onRefresh: (metadata) => { refreshes.push(metadata); }, logger: () => {} });
  t.after(() => monitor.stop());
  await monitor.start();
  await until(() => refreshes.length === 1);
  assert.equal(connection.accounts.size, 2);
  const oldCallback = [...connection.accounts.values()][0].callback;
  oldCallback({}, { slot: 12 });
  [...connection.accounts.values()][1].callback({}, { slot: 11 });
  await until(() => refreshes.length === 2);
  assert.equal(refreshes[1].eventSlot, 12);
  targets = [POSITION];
  await monitor.syncNow();
  targets = [POOL, POSITION];
  await monitor.syncNow();
  const before = monitor.getTelemetry().websocket_events;
  oldCallback({}, { slot: 13 });
  assert.equal(monitor.getTelemetry().websocket_events, before);
});

test("successful swap logs trigger a quote even when the AMM pool account never changes", async (t) => {
  const connection = new FakeConnection();
  const refreshes = [];
  const monitor = createAccountRealtimeMonitor({ connection, getAccountAddresses: () => [POOL], watchLogs: true,
    monitorName: "test-logs", onRefresh: (metadata) => { refreshes.push(metadata); }, logger: () => {} });
  t.after(() => monitor.stop());
  await monitor.start();
  await until(() => refreshes.length === 1);
  const callback = [...connection.logs.values()][0].callback;
  callback({ err: { InstructionError: [0, "failed"] } }, { slot: 100 });
  assert.equal(monitor.getTelemetry().websocket_log_events, 0);
  callback({ err: null }, { slot: 101 });
  await until(() => refreshes.length === 2);
  assert.equal(refreshes[1].reason, "transaction_log");
  assert.equal(monitor.getTelemetry().websocket_log_events, 1);
  assert.equal(getRealtimeMonitorTelemetry()["test-logs"].websocket_log_events, 1);
  await monitor.stop();
  assert.equal(connection.accounts.size, 0);
  assert.equal(connection.logs.size, 0);
});

test("stopping during a pending subscription removes late listeners and schedules no work", async () => {
  const connection = new FakeConnection();
  let finishSubscription;
  const original = connection.onLogs.bind(connection);
  connection.onLogs = (...args) => new Promise((resolve) => {
    finishSubscription = () => resolve(original(...args));
  });
  let refreshes = 0;
  const monitor = createAccountRealtimeMonitor({ connection, getAccountAddresses: () => [POOL], watchLogs: true,
    onRefresh: () => { refreshes += 1; }, logger: () => {} });
  const starting = monitor.start();
  await until(() => finishSubscription != null);
  await monitor.stop();
  finishSubscription();
  await starting;
  assert.equal(connection.accounts.size, 0);
  assert.equal(connection.logs.size, 0);
  assert.equal(refreshes, 0);
  assert.equal(monitor.getTelemetry().running, false);
});

test("a temporary state-read outage retains subscriptions and fallback risk checks", async (t) => {
  const connection = new FakeConnection();
  let unavailable = false;
  let refreshes = 0;
  const monitor = createAccountRealtimeMonitor({ connection, fallbackIntervalMs: 100,
    getAccountAddresses: () => { if (unavailable) throw new Error("disk busy"); return [POOL]; },
    onRefresh: () => { refreshes += 1; }, logger: () => {} });
  t.after(() => monitor.stop());
  await monitor.start();
  await until(() => refreshes === 1);
  unavailable = true;
  await until(() => refreshes >= 2);
  assert.equal(connection.accounts.size, 1);
  assert.ok(monitor.getTelemetry().subscription_errors > 0);
});

test("lifecycle notifications are deduplicated and candidate targets expire", (t) => {
  const changes = [];
  const unsubscribe = onRuntimeChange((kind) => changes.push(kind));
  t.after(unsubscribe);
  publishRuntimeChange("test-position", "open:1");
  publishRuntimeChange("test-position", "open:1");
  publishRuntimeChange("test-position", "closed:1");
  assert.deepEqual(changes, ["test-position", "test-position"]);
  updateEntryWatchlist("test", [{ pool: POOL }, { pool: "invalid" }, { pool: POSITION }], 1_000);
  assert.deepEqual(getEntryWatchAccounts(1_001), [POOL, POSITION]);
  assert.deepEqual(getEntryWatchAccounts(61_001), []);
});

test("the production spot watchdog observes stop-loss during screening and defers only submission", async () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const begin = source.indexOf("async function runSpotManagementCycle(");
  const end = source.indexOf("async function runSpotScreeningCycle(", begin);
  let reads = 0;
  let submissions = 0;
  const dependencies = {
    telegramEnabled: () => false, log: () => {}, resetSpotExitConfirmation: () => {},
    wakeRealtimeExits: () => {}, confirmSpotExit: () => ({ fire: true }),
    getSpotPositionSnapshot: async () => {
      reads += 1;
      return { position: { id: "spot", mint: "mint" }, status: "open", priceable: true,
        pnl_pct: -3, exit: { action: "STOP_LOSS", reason: "fresh executable loss" } };
    },
    executeTool: async () => { submissions += 1; return { success: true, trade_status: "closed", pnl_pct: -3 }; },
  };
  const harness = new Function(...Object.keys(dependencies), `
    let _managementBusy = false, _claimAllBusy = false, _screeningBusy = true;
    let _spotPollBusy = false, _spotExitPending = false;
    const timers = {};
    ${source.slice(begin, end)}
    return { run: runSpotManagementCycle, release: () => { _screeningBusy = false; }, pending: () => _spotExitPending };
  `)(...Object.values(dependencies));
  await harness.run({ silent: true });
  assert.equal(reads, 1);
  assert.equal(submissions, 0);
  assert.equal(harness.pending(), true);
  harness.release();
  await harness.run({ silent: true });
  assert.equal(submissions, 1);
  assert.equal(harness.pending(), false);
});
