const DEFAULT_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

function isRateLimited(error) {
  return Number(error?.status) === 429 || /Jupiter\s+HTTP\s*429\b/i.test(String(error?.message || ""));
}

function backoffMs(error, now) {
  const raw = error?.retryAfter;
  const seconds = raw == null || raw === "" ? NaN : Number(raw);
  const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(raw) - now;
  return Math.min(MAX_BACKOFF_MS, Number.isFinite(delay) && delay > 0 ? delay : DEFAULT_BACKOFF_MS);
}

function assertFresh(startedAt, now, ttlMs) {
  if (now < startedAt || (ttlMs > 0 && now - startedAt >= ttlMs)) {
    throw Object.assign(new Error("Market response exceeded its freshness budget; refusing stale data"), { code: "MARKET_DATA_STALE" });
  }
}

/** Short-lived read-only market snapshots. This cache must never wrap submission. */
export function createMarketDataCache({ now = Date.now, maxEntries = 256 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive integer");
  const snapshots = new Map();
  const inFlight = new Map();
  const cooldowns = new Map();
  let generation = 0;

  async function readPending(pending, ttlMs) {
    const snapshot = await pending;
    assertFresh(snapshot.startedAt, now(), ttlMs);
    return structuredClone(snapshot.value);
  }

  async function get(key, loader, { ttlMs = 10_000, rateLimitKey = "default" } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError("ttlMs must be finite and nonnegative");
    const provider = String(rateLimitKey);
    const identity = JSON.stringify([provider, String(key)]);
    const startedAt = now();
    const cached = snapshots.get(identity);
    if (cached && startedAt >= cached.startedAt && startedAt < Math.min(cached.expiresAt, cached.startedAt + ttlMs)) {
      snapshots.delete(identity);
      snapshots.set(identity, cached);
      return structuredClone(cached.value);
    }
    snapshots.delete(identity);
    if (inFlight.has(identity)) return readPending(inFlight.get(identity), ttlMs);
    for (const [name, until] of cooldowns) if (until <= startedAt) cooldowns.delete(name);
    const retryAt = cooldowns.get(provider);
    if (retryAt > startedAt) {
      throw Object.assign(new Error("Market-data provider cooldown after HTTP 429; refusing a new request"), {
        status: 429, code: "MARKET_DATA_RATE_LIMITED", retryAfter: Math.ceil((retryAt - startedAt) / 1_000),
      });
    }
    if (inFlight.size + cooldowns.size >= maxEntries) {
      throw Object.assign(new Error("Market-data request capacity reached"), { code: "MARKET_DATA_CAPACITY" });
    }

    const requestGeneration = generation;
    const pending = Promise.resolve().then(loader).then((value) => {
      assertFresh(startedAt, now(), ttlMs);
      const snapshot = { value: structuredClone(value), startedAt, expiresAt: startedAt + ttlMs };
      if (ttlMs > 0 && generation === requestGeneration) {
        snapshots.set(identity, snapshot);
        while (snapshots.size > maxEntries) snapshots.delete(snapshots.keys().next().value);
      }
      return snapshot;
    }).catch((error) => {
      if (isRateLimited(error) && generation === requestGeneration) {
        cooldowns.set(provider, Math.max(cooldowns.get(provider) || 0, now() + backoffMs(error, now())));
      }
      throw error;
    }).finally(() => {
      if (inFlight.get(identity) === pending) inFlight.delete(identity);
    });
    inFlight.set(identity, pending);
    return readPending(pending, ttlMs);
  }

  return {
    get,
    clear() {
      generation += 1;
      snapshots.clear();
      inFlight.clear();
      cooldowns.clear();
    },
  };
}
