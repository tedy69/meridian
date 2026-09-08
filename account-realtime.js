import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "./logger.js";

const MAX_LATENCY_SAMPLES = 200;
const ACCOUNT_READ_FAILED = Symbol("account_read_failed");
const namedTelemetry = new Map();

export function getRealtimeMonitorTelemetry() {
  return Object.fromEntries([...namedTelemetry].map(([name, snapshot]) => [name, structuredClone(snapshot)]));
}

export function blankRealtimeTelemetry() {
  return {
    enabled: false,
    running: false,
    mode: "websocket_with_fallback",
    commitment: null,
    subscribed_pool: null,
    subscribed_accounts: [],
    subscription_id: null,
    websocket_events: 0,
    websocket_log_events: 0,
    refresh_triggers: 0,
    refresh_runs: 0,
    coalesced_triggers: 0,
    refresh_errors: 0,
    consecutive_refresh_errors: 0,
    subscription_errors: 0,
    last_event_at: null,
    last_event_slot: null,
    last_refresh_at: null,
    last_refresh_reason: null,
    last_error: null,
    backoff_until: null,
    event_debounce_ms: null,
    min_refresh_ms: null,
    fallback_interval_ms: null,
    latency_ms: {
      event_to_refresh: { p50: null, p95: null, p99: null, max: null, samples: 0 },
      refresh_duration: { p50: null, p95: null, p99: null, max: null, samples: 0 },
    },
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function latencyStats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? sorted[sorted.length - 1] : null,
    samples: sorted.length,
  };
}

function cloneTelemetry(telemetry) {
  return JSON.parse(JSON.stringify(telemetry));
}

function cleanError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

export function createAccountRealtimeMonitor({
  rpcUrl = process.env.RPC_URL,
  wsUrl = process.env.SOLANA_WS_URL || null,
  connection: injectedConnection = null,
  getAccountAddresses,
  onTelemetry = () => {},
  monitorName = null,
  watchLogs = false,
  onRefresh,
  commitment = "processed",
  eventDebounceMs = 0,
  minRefreshMs = 0,
  fallbackIntervalMs = 1_000,
  errorBackoffBaseMs = 1_000,
  errorBackoffMaxMs = 30_000,
  now = () => Date.now(),
  logger = log,
} = {}) {
  if (typeof getAccountAddresses !== "function") throw new Error("Realtime monitor requires getAccountAddresses");
  if (typeof onRefresh !== "function") throw new Error("Realtime monitor requires onRefresh");
  if (!injectedConnection && !rpcUrl) throw new Error("Realtime monitor requires RPC_URL");

  const connection = injectedConnection || new Connection(rpcUrl, {
    commitment,
    ...(wsUrl ? { wsEndpoint: wsUrl } : {}),
  });
  const debounceMs = Math.max(0, Number(eventDebounceMs) || 0);
  const refreshFloorMs = Math.max(0, Number(minRefreshMs) || 0);
  const heartbeatMs = Math.max(100, Number(fallbackIntervalMs) || 1_000);
  const backoffBaseMs = Math.max(100, Number(errorBackoffBaseMs) || 1_000);
  const backoffMaxMs = Math.max(backoffBaseMs, Number(errorBackoffMaxMs) || 30_000);
  const eventLatencies = [];
  const refreshDurations = [];
  const telemetry = {
    ...blankRealtimeTelemetry(),
    enabled: true,
    commitment,
    event_debounce_ms: debounceMs,
    min_refresh_ms: refreshFloorMs,
    fallback_interval_ms: heartbeatMs,
  };
  if (monitorName) namedTelemetry.set(monitorName, telemetry);

  let running = false;
  const subscriptions = new Map();
  let generation = 0;
  let fallbackTimer = null;
  let scheduledTimer = null;
  let scheduledFor = null;
  let refreshInFlight = false;
  let lastRefreshStartedAt = -Infinity;
  let refreshBackoffUntil = -Infinity;
  let pendingReason = null;
  let pendingEventAt = null;
  let pendingEventSlot = null;
  let syncPromise = null;
  let syncAgain = false;

  function publish() {
    telemetry.running = running;
    telemetry.subscribed_accounts = [...subscriptions.keys()];
    telemetry.subscribed_pool = telemetry.subscribed_accounts[0] ?? null;
    telemetry.subscription_id = subscriptions.values().next().value?.id ?? null;
    telemetry.latency_ms.event_to_refresh = latencyStats(eventLatencies);
    telemetry.latency_ms.refresh_duration = latencyStats(refreshDurations);
    onTelemetry(cloneTelemetry(telemetry));
  }

  function recordSample(samples, value) {
    if (!Number.isFinite(value) || value < 0) return;
    samples.push(Math.round(value));
    if (samples.length > MAX_LATENCY_SAMPLES) samples.shift();
  }

  function rememberPending(reason, eventAt = null, eventSlot = null) {
    const priority = { startup: 1, fallback: 2, position_change: 3, account_change: 4, transaction_log: 4, lane_available: 5 };
    if (!pendingReason || (priority[reason] || 0) >= (priority[pendingReason] || 0)) pendingReason = reason;
    if (Number.isFinite(eventAt)) {
      pendingEventAt = pendingEventAt == null ? eventAt : Math.min(pendingEventAt, eventAt);
    }
    if (Number.isFinite(eventSlot)) pendingEventSlot = Math.max(pendingEventSlot ?? eventSlot, eventSlot);
  }

  function scheduleRefresh(reason, { eventAt = null, eventSlot = null } = {}) {
    if (!running) return;
    telemetry.refresh_triggers += 1;
    rememberPending(reason, eventAt, eventSlot);

    if (refreshInFlight) {
      telemetry.coalesced_triggers += 1;
      publish();
      return;
    }

    const current = now();
    const debounceDue = ["account_change", "transaction_log"].includes(reason) ? current + debounceMs : current;
    const due = Math.max(debounceDue, lastRefreshStartedAt + refreshFloorMs, refreshBackoffUntil);
    if (scheduledTimer) {
      telemetry.coalesced_triggers += 1;
      if (scheduledFor != null && due >= scheduledFor) {
        publish();
        return;
      }
      clearTimeout(scheduledTimer);
    }
    scheduledFor = due;
    scheduledTimer = setTimeout(runRefresh, Math.max(0, due - current));
    scheduledTimer.unref?.();
    publish();
  }

  async function readAddresses() {
    try {
      const addresses = await getAccountAddresses();
      if (!Array.isArray(addresses)) throw new Error("Account targets must be an array");
      // Validate all targets before changing any existing subscription.
      return [...new Set(addresses.filter(Boolean).map((address) => new PublicKey(address).toBase58()))];
    } catch (error) {
      telemetry.last_error = `account targets: ${cleanError(error)}`;
      telemetry.subscription_errors += 1;
      publish();
      logger("realtime_error", telemetry.last_error);
      return ACCOUNT_READ_FAILED;
    }
  }

  async function removeListener(address) {
    const subscription = subscriptions.get(address);
    subscriptions.delete(address);
    publish();
    await Promise.all([
      subscription?.id != null ? () => connection.removeAccountChangeListener(subscription.id) : null,
      subscription?.logId != null ? () => connection.removeOnLogsListener(subscription.logId) : null,
    ].filter(Boolean).map(async (remove) => {
      try { await remove(); }
      catch (error) {
        telemetry.subscription_errors += 1;
        telemetry.last_error = `unsubscribe: ${cleanError(error)}`;
        publish();
        logger("realtime_warn", telemetry.last_error);
      }
    }));
  }

  async function performSubscriptionSync() {
    const currentGeneration = generation;
    const addresses = await readAddresses();
    if (addresses === ACCOUNT_READ_FAILED) return addresses;
    if (!running || currentGeneration !== generation) return addresses;
    const desired = new Set(addresses);
    for (const address of subscriptions.keys()) {
      if (!desired.has(address)) await removeListener(address);
    }
    for (const address of addresses) {
      if (!running || currentGeneration !== generation) break;
      if (subscriptions.has(address)) continue;
      const subscription = { id: null, logId: null };
      subscriptions.set(address, subscription);
      try {
        const id = await Promise.resolve(connection.onAccountChange(
          new PublicKey(address),
          (_accountInfo, context = {}) => {
            if (!running || currentGeneration !== generation || subscriptions.get(address) !== subscription) return;
            const eventAt = now();
            const eventSlot = Number.isFinite(Number(context.slot)) ? Number(context.slot) : null;
            telemetry.websocket_events += 1;
            telemetry.last_event_at = new Date(eventAt).toISOString();
            telemetry.last_event_slot = Math.max(telemetry.last_event_slot ?? 0, eventSlot ?? 0) || null;
            publish();
            scheduleRefresh("account_change", { eventAt, eventSlot });
          },
          commitment,
        ));
        if (!running || currentGeneration !== generation || subscriptions.get(address) !== subscription) {
          await connection.removeAccountChangeListener(id).catch(() => {});
          continue;
        }
        subscription.id = id;
        // Some AMMs update vault balances without changing the pool account.
        // Logs mentioning the pool still wake a fresh executable quote.
        if (watchLogs && typeof connection.onLogs === "function") {
          const logId = await Promise.resolve(connection.onLogs(new PublicKey(address), (result, context = {}) => {
            if (result.err != null || !running || currentGeneration !== generation
              || subscriptions.get(address) !== subscription) return;
            const eventAt = now();
            const eventSlot = Number.isFinite(Number(context.slot)) ? Number(context.slot) : null;
            telemetry.websocket_events += 1;
            telemetry.websocket_log_events += 1;
            telemetry.last_event_at = new Date(eventAt).toISOString();
            telemetry.last_event_slot = Math.max(telemetry.last_event_slot ?? 0, eventSlot ?? 0) || null;
            scheduleRefresh("transaction_log", { eventAt, eventSlot });
          }, commitment));
          if (!running || currentGeneration !== generation || subscriptions.get(address) !== subscription) {
            await connection.removeOnLogsListener(logId).catch(() => {});
            continue;
          }
          subscription.logId = logId;
        }
        telemetry.last_error = null;
        publish();
      } catch (error) {
        if (subscriptions.get(address) === subscription) await removeListener(address);
        telemetry.subscription_errors += 1;
        telemetry.last_error = `subscribe: ${cleanError(error)}`;
        publish();
        logger("realtime_error", telemetry.last_error);
      }
    }
    return addresses;
  }

  function syncSubscription() {
    if (syncPromise) {
      syncAgain = true;
      return syncPromise;
    }
    syncPromise = (async () => {
      let addresses = [];
      do {
        syncAgain = false;
        addresses = await performSubscriptionSync();
      } while (running && syncAgain);
      return addresses;
    })().finally(() => {
      syncPromise = null;
    });
    return syncPromise;
  }

  async function runRefresh() {
    scheduledTimer = null;
    scheduledFor = null;
    if (!running || refreshInFlight || !pendingReason) return;

    const reason = pendingReason;
    const eventAt = pendingEventAt;
    const eventSlot = pendingEventSlot;
    pendingReason = null;
    pendingEventAt = null;
    pendingEventSlot = null;
    refreshInFlight = true;
    const currentGeneration = generation;
    const startedAt = now();
    lastRefreshStartedAt = startedAt;
    telemetry.refresh_runs += 1;
    telemetry.last_refresh_at = new Date(startedAt).toISOString();
    telemetry.last_refresh_reason = reason;
    if (eventAt != null) recordSample(eventLatencies, startedAt - eventAt);
    publish();

    try {
      await onRefresh({ reason, eventAt, eventSlot, startedAt });
      if (currentGeneration !== generation) return;
      telemetry.consecutive_refresh_errors = 0;
      telemetry.backoff_until = null;
      refreshBackoffUntil = -Infinity;
      telemetry.last_error = null;
    } catch (error) {
      if (currentGeneration !== generation) return;
      telemetry.refresh_errors += 1;
      telemetry.consecutive_refresh_errors += 1;
      const backoffMs = Math.min(
        backoffMaxMs,
        backoffBaseMs * (2 ** Math.max(0, telemetry.consecutive_refresh_errors - 1)),
      );
      refreshBackoffUntil = now() + backoffMs;
      telemetry.backoff_until = new Date(refreshBackoffUntil).toISOString();
      telemetry.last_error = `refresh: ${cleanError(error)}`;
      logger("realtime_error", telemetry.last_error);
    } finally {
      recordSample(refreshDurations, now() - startedAt);
      refreshInFlight = false;
      publish();
      if (running && currentGeneration === generation) await syncSubscription();
      if (running && currentGeneration === generation && pendingReason) scheduleRefresh(pendingReason, {
        eventAt: pendingEventAt,
        eventSlot: pendingEventSlot,
      });
    }
  }

  async function heartbeat() {
    if (!running) return;
    const addresses = await syncSubscription();
    if (addresses === ACCOUNT_READ_FAILED ? subscriptions.size > 0 : addresses.length > 0) scheduleRefresh("fallback");
  }

  async function start() {
    if (running) return cloneTelemetry(telemetry);
    running = true;
    const currentGeneration = ++generation;
    publish();
    const addresses = await syncSubscription();
    if (!running || currentGeneration !== generation) return cloneTelemetry(telemetry);
    fallbackTimer = setInterval(() => {
      heartbeat().catch((error) => logger("realtime_error", cleanError(error)));
    }, heartbeatMs);
    fallbackTimer.unref?.();
    if (Array.isArray(addresses) && addresses.length > 0) scheduleRefresh("startup");
    return cloneTelemetry(telemetry);
  }

  async function stop() {
    running = false;
    generation += 1;
    if (fallbackTimer) clearInterval(fallbackTimer);
    fallbackTimer = null;
    if (scheduledTimer) clearTimeout(scheduledTimer);
    scheduledTimer = null;
    scheduledFor = null;
    pendingReason = null;
    pendingEventAt = null;
    pendingEventSlot = null;
    await Promise.all([...subscriptions.keys()].map(removeListener));
    publish();
    return cloneTelemetry(telemetry);
  }

  return {
    start,
    stop,
    syncNow: syncSubscription,
    triggerRefresh: scheduleRefresh,
    getTelemetry: () => cloneTelemetry(telemetry),
  };
}
