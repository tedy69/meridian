import { Connection, PublicKey } from "@solana/web3.js";
import { log } from "./logger.js";

const ACTIVE_STATUSES = new Set(["opening", "open", "closing"]);
const MAX_LATENCY_SAMPLES = 200;
const POSITION_READ_FAILED = Symbol("position_read_failed");

function blankTelemetry() {
  return {
    enabled: false,
    running: false,
    mode: "websocket_with_fallback",
    commitment: null,
    subscribed_pool: null,
    subscription_id: null,
    websocket_events: 0,
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

let sharedTelemetry = blankTelemetry();

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

function isActivePosition(position) {
  return Boolean(position?.pool && ACTIVE_STATUSES.has(position.status));
}

function cleanError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

export function getSpotRealtimeTelemetry() {
  return cloneTelemetry(sharedTelemetry);
}

export function createSpotRealtimeMonitor({
  rpcUrl = process.env.RPC_URL,
  wsUrl = process.env.SOLANA_WS_URL || null,
  connection: injectedConnection = null,
  getPosition,
  onRefresh,
  commitment = "processed",
  eventDebounceMs = 100,
  minRefreshMs = 1_000,
  fallbackIntervalMs = 1_000,
  errorBackoffBaseMs = 1_000,
  errorBackoffMaxMs = 30_000,
  now = () => Date.now(),
  logger = log,
} = {}) {
  if (typeof getPosition !== "function") throw new Error("Spot realtime monitor requires getPosition");
  if (typeof onRefresh !== "function") throw new Error("Spot realtime monitor requires onRefresh");
  if (!injectedConnection && !rpcUrl) throw new Error("Spot realtime monitor requires RPC_URL");

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
    ...blankTelemetry(),
    enabled: true,
    commitment,
    event_debounce_ms: debounceMs,
    min_refresh_ms: refreshFloorMs,
    fallback_interval_ms: heartbeatMs,
  };
  sharedTelemetry = telemetry;

  let running = false;
  let accountListenerId = null;
  let subscribedPool = null;
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
    telemetry.subscribed_pool = subscribedPool;
    telemetry.subscription_id = accountListenerId;
    telemetry.latency_ms.event_to_refresh = latencyStats(eventLatencies);
    telemetry.latency_ms.refresh_duration = latencyStats(refreshDurations);
    sharedTelemetry = telemetry;
  }

  function recordSample(samples, value) {
    if (!Number.isFinite(value) || value < 0) return;
    samples.push(Math.round(value));
    if (samples.length > MAX_LATENCY_SAMPLES) samples.shift();
  }

  function rememberPending(reason, eventAt = null, eventSlot = null) {
    const priority = { startup: 1, fallback: 2, account_change: 3 };
    if (!pendingReason || (priority[reason] || 0) >= (priority[pendingReason] || 0)) pendingReason = reason;
    if (Number.isFinite(eventAt)) {
      pendingEventAt = pendingEventAt == null ? eventAt : Math.min(pendingEventAt, eventAt);
    }
    if (Number.isFinite(eventSlot)) pendingEventSlot = eventSlot;
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
    const debounceDue = reason === "account_change" ? current + debounceMs : current;
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

  async function readPosition() {
    try {
      return await getPosition();
    } catch (error) {
      telemetry.last_error = `position read: ${cleanError(error)}`;
      telemetry.subscription_errors += 1;
      publish();
      logger("spot_realtime_error", telemetry.last_error);
      return POSITION_READ_FAILED;
    }
  }

  async function removeListener() {
    const listenerId = accountListenerId;
    accountListenerId = null;
    subscribedPool = null;
    publish();
    if (listenerId == null) return;
    try {
      await connection.removeAccountChangeListener(listenerId);
    } catch (error) {
      telemetry.subscription_errors += 1;
      telemetry.last_error = `unsubscribe: ${cleanError(error)}`;
      publish();
      logger("spot_realtime_warn", telemetry.last_error);
    }
  }

  async function performSubscriptionSync() {
    const position = await readPosition();
    if (position === POSITION_READ_FAILED) return position;
    const desiredPool = isActivePosition(position) ? String(position.pool) : null;
    if (!running) return position;
    if (desiredPool === subscribedPool && accountListenerId != null) return position;
    if (accountListenerId != null) await removeListener();
    if (!desiredPool || !running) return position;

    let publicKey;
    try {
      publicKey = new PublicKey(desiredPool);
    } catch (error) {
      telemetry.subscription_errors += 1;
      telemetry.last_error = `invalid pool address: ${cleanError(error)}`;
      publish();
      logger("spot_realtime_error", telemetry.last_error);
      return position;
    }

    try {
      const listenerId = await Promise.resolve(connection.onAccountChange(
        publicKey,
        (_accountInfo, context = {}) => {
          if (!running || subscribedPool !== desiredPool) return;
          const eventAt = now();
          telemetry.websocket_events += 1;
          telemetry.last_event_at = new Date(eventAt).toISOString();
          telemetry.last_event_slot = Number.isFinite(Number(context.slot)) ? Number(context.slot) : null;
          publish();
          scheduleRefresh("account_change", { eventAt, eventSlot: telemetry.last_event_slot });
        },
        commitment,
      ));
      if (!running) {
        await connection.removeAccountChangeListener(listenerId).catch(() => {});
        return position;
      }
      accountListenerId = listenerId;
      subscribedPool = desiredPool;
      telemetry.last_error = null;
      publish();
      logger("spot_realtime", `Listening to pool ${desiredPool.slice(0, 8)}... at ${commitment} commitment`);
    } catch (error) {
      telemetry.subscription_errors += 1;
      telemetry.last_error = `subscribe: ${cleanError(error)}`;
      publish();
      logger("spot_realtime_error", telemetry.last_error);
    }
    return position;
  }

  function syncSubscription() {
    if (syncPromise) {
      syncAgain = true;
      return syncPromise;
    }
    syncPromise = (async () => {
      let position = null;
      do {
        syncAgain = false;
        position = await performSubscriptionSync();
      } while (running && syncAgain);
      return position;
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
    const startedAt = now();
    lastRefreshStartedAt = startedAt;
    telemetry.refresh_runs += 1;
    telemetry.last_refresh_at = new Date(startedAt).toISOString();
    telemetry.last_refresh_reason = reason;
    if (eventAt != null) recordSample(eventLatencies, startedAt - eventAt);
    publish();

    try {
      await onRefresh({ reason, eventAt, eventSlot, startedAt });
      telemetry.consecutive_refresh_errors = 0;
      telemetry.backoff_until = null;
      refreshBackoffUntil = -Infinity;
      telemetry.last_error = null;
    } catch (error) {
      telemetry.refresh_errors += 1;
      telemetry.consecutive_refresh_errors += 1;
      const backoffMs = Math.min(
        backoffMaxMs,
        backoffBaseMs * (2 ** Math.max(0, telemetry.consecutive_refresh_errors - 1)),
      );
      refreshBackoffUntil = now() + backoffMs;
      telemetry.backoff_until = new Date(refreshBackoffUntil).toISOString();
      telemetry.last_error = `refresh: ${cleanError(error)}`;
      logger("spot_realtime_error", telemetry.last_error);
    } finally {
      recordSample(refreshDurations, now() - startedAt);
      refreshInFlight = false;
      publish();
      await syncSubscription();
      if (running && pendingReason) scheduleRefresh(pendingReason, {
        eventAt: pendingEventAt,
        eventSlot: pendingEventSlot,
      });
    }
  }

  async function heartbeat() {
    if (!running) return;
    const position = await syncSubscription();
    if (isActivePosition(position)) scheduleRefresh("fallback");
  }

  async function start() {
    if (running) return cloneTelemetry(telemetry);
    running = true;
    publish();
    const position = await syncSubscription();
    fallbackTimer = setInterval(() => {
      heartbeat().catch((error) => logger("spot_realtime_error", cleanError(error)));
    }, heartbeatMs);
    fallbackTimer.unref?.();
    if (isActivePosition(position)) scheduleRefresh("startup");
    return cloneTelemetry(telemetry);
  }

  async function stop() {
    running = false;
    if (fallbackTimer) clearInterval(fallbackTimer);
    fallbackTimer = null;
    if (scheduledTimer) clearTimeout(scheduledTimer);
    scheduledTimer = null;
    scheduledFor = null;
    pendingReason = null;
    pendingEventAt = null;
    pendingEventSlot = null;
    await removeListener();
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
