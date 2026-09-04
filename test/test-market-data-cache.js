import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../config.js";
import { createMarketDataCache } from "../market-data-cache.js";

test("in-flight market requests deduplicate even when completed caching is disabled", async () => {
  const cache = createMarketDataCache();
  let finish;
  let requests = 0;
  const loader = () => {
    requests += 1;
    return new Promise((resolve) => { finish = resolve; });
  };
  const first = cache.get("mint", loader, { ttlMs: 0 });
  const second = cache.get("mint", loader, { ttlMs: 0 });
  await Promise.resolve();
  finish({ quote: { amount: "100" } });
  const [a, b] = await Promise.all([first, second]);

  assert.equal(requests, 1);
  a.quote.amount = "999";
  assert.equal(b.quote.amount, "100");
  const fresh = await cache.get("mint", async () => ({ quote: { amount: "101" } }), { ttlMs: 0 });
  assert.equal(fresh.quote.amount, "101");
});

test("cached market snapshots are cloned and expire from request start, not completion", async () => {
  let now = 0;
  const cache = createMarketDataCache({ now: () => now });
  const source = { quote: { amount: "100" } };
  const first = await cache.get("mint", async () => {
    now = 4_000;
    return source;
  }, { ttlMs: 5_000 });
  source.quote.amount = "source-mutated";
  first.quote.amount = "caller-mutated";
  now = 4_999;
  const cached = await cache.get("mint", () => assert.fail("snapshot is still fresh"), { ttlMs: 5_000 });
  assert.equal(cached.quote.amount, "100");
  now = 5_000;
  const fresh = await cache.get("mint", async () => ({ quote: { amount: "101" } }), { ttlMs: 5_000 });
  assert.equal(fresh.quote.amount, "101");
});

test("a market response older than its freshness budget is rejected, never confirmed", async () => {
  let now = 0;
  const cache = createMarketDataCache({ now: () => now });
  await assert.rejects(cache.get("mint", async () => {
    now = 5_000;
    return { confirmed: true };
  }, { ttlMs: 5_000 }), /stale|freshness/i);
  const next = await cache.get("mint", async () => ({ confirmed: false }), { ttlMs: 5_000 });
  assert.equal(next.confirmed, false);
});

test("expired market data is never returned as fallback after an API failure", async () => {
  let now = 0;
  const cache = createMarketDataCache({ now: () => now });
  await cache.get("mint", async () => ({ confirmed: true }), { ttlMs: 1_000 });
  now = 1_000;
  await assert.rejects(cache.get("mint", async () => { throw new Error("upstream unavailable"); }, { ttlMs: 1_000 }), /unavailable/);
  assert.deepEqual(await cache.get("mint", async () => ({ confirmed: false }), { ttlMs: 1_000 }), { confirmed: false });
});

test("completed cache capacity evicts the least recently used market, not another provider's identity", async () => {
  const cache = createMarketDataCache({ maxEntries: 2 });
  await cache.get("mint", async () => "a", { rateLimitKey: "provider-a" });
  await cache.get("mint", async () => "b", { rateLimitKey: "provider-b" });
  assert.equal(await cache.get("mint", () => assert.fail("a should remain cached"), { rateLimitKey: "provider-a" }), "a");
  await cache.get("other", async () => "c");
  assert.equal(await cache.get("mint", () => assert.fail("recent a must remain cached"), { rateLimitKey: "provider-a" }), "a");
  assert.equal(await cache.get("mint", async () => "b-refetched", { rateLimitKey: "provider-b" }), "b-refetched");
});

test("provider-wide 429 cooldown honors seconds while allowing only fresh cached answers", async () => {
  let now = 0;
  const cache = createMarketDataCache({ now: () => now });
  await cache.get("cached", async () => "fresh", { ttlMs: 10_000 });
  const rateLimit = Object.assign(new Error("rate limited"), { status: 429, retryAfter: "20" });
  await assert.rejects(cache.get("first", async () => { throw rateLimit; }), /rate limited/);
  assert.equal(await cache.get("cached", () => assert.fail("cached answer needs no fetch")), "fresh");
  await assert.rejects(cache.get("other", () => assert.fail("provider is cooling down")), (error) => error.status === 429 && error.retryAfter === 20);
  assert.equal(await cache.get("other", async () => "unrelated", { rateLimitKey: "another-provider" }), "unrelated");
  now = 10_000;
  await assert.rejects(cache.get("cached", () => assert.fail("expired cache cannot bypass cooldown")), /cooldown/i);
  now = 20_000;
  assert.equal(await cache.get("other", async () => "recovered"), "recovered");
});

test("wrapped Jupiter429, HTTP-date Retry-After, and a bounded default backoff prevent refetch storms", async () => {
  for (const [retryAfter, delay] of [[undefined, 5_000], ["bad-date", 5_000], ["120", 60_000], [new Date(25_000).toUTCString(), 25_000]]) {
    let now = 0;
    const cache = createMarketDataCache({ now: () => now });
    await assert.rejects(cache.get("first", async () => {
      throw Object.assign(new Error("Upstream Jupiter HTTP429"), { status: 502, retryAfter });
    }), /Jupiter/);
    now = delay - 1;
    await assert.rejects(cache.get("second", () => assert.fail("cooldown has not expired")), /cooldown/i);
    now = delay;
    assert.equal(await cache.get("second", async () => "recovered"), "recovered");
  }
});

test("clearing the cache cannot let an older in-flight snapshot replace newer data", async () => {
  const cache = createMarketDataCache();
  let finish;
  const first = cache.get("mint", () => new Promise((resolve) => { finish = resolve; }));
  await Promise.resolve();
  cache.clear();
  await cache.get("mint", async () => "new");
  finish("old");
  assert.equal(await first, "old");
  assert.equal(await cache.get("mint", () => assert.fail("new snapshot is cached")), "new");
});

test("in-flight admission stays bounded and preserves pending deduplication", async () => {
  const cache = createMarketDataCache({ maxEntries: 1 });
  let finish;
  const pending = cache.get("first", () => new Promise((resolve) => { finish = resolve; }));
  await Promise.resolve();
  await assert.rejects(cache.get("second", () => assert.fail("no capacity for a new market")), /capacity/i);
  const duplicate = cache.get("first", () => assert.fail("the existing pending request must be reused"));
  finish("first-result");
  assert.deepEqual(await Promise.all([pending, duplicate]), ["first-result", "first-result"]);
});

test("pending requests cannot overflow bounded provider cooldown state", async () => {
  const cache = createMarketDataCache({ maxEntries: 2 });
  await assert.rejects(cache.get("mint", async () => {
    throw Object.assign(new Error("rate limited"), { status: 429 });
  }, { rateLimitKey: "provider-a" }));
  let finish;
  const pending = cache.get("mint", () => new Promise((resolve) => { finish = resolve; }), { rateLimitKey: "provider-b" });
  await Promise.resolve();
  try {
    await assert.rejects(cache.get("mint", async () => "overflow", { rateLimitKey: "provider-c" }), /capacity/i);
  } finally {
    finish("done");
    await pending;
  }
});

let indicatorModuleId = 0;

async function indicatorHarness(t, fetchImpl) {
  const originalIndicators = config.indicators;
  config.indicators = {
    enabled: true,
    entryPreset: "momentum_quality",
    exitPreset: "supertrend_break",
    candles: 298,
    rsiLength: 7,
    intervals: ["5_MINUTE", "15_MINUTE"],
    entryRsiMin: 45,
    entryRsiMax: 72,
    requireAllIntervals: true,
    entryFailClosed: true,
  };
  t.after(() => { config.indicators = originalIndicators; });
  t.mock.method(globalThis, "fetch", fetchImpl);
  return import(`../tools/chart-indicators.js?market-cache-test=${++indicatorModuleId}`);
}

function bullishPayload() {
  return {
    latest: {
      candle: { close: 11 },
      previousCandle: { close: 10 },
      rsi: { value: 60 },
      supertrend: { direction: "bullish", value: 9 },
    },
  };
}

test("concurrent and immediately repeated refreshes reuse each mint/interval snapshot", async (t) => {
  const requests = [];
  const { confirmIndicatorPreset } = await indicatorHarness(t, async (url) => {
    requests.push(new URL(url));
    return new Response(JSON.stringify(bullishPayload()));
  });
  const args = { mint: "IndicatorMint", side: "entry", refresh: true };

  const results = await Promise.all([
    confirmIndicatorPreset(args),
    confirmIndicatorPreset(args),
  ]);
  results.push(await confirmIndicatorPreset(args));

  assert.equal(results.every((result) => result.confirmed), true);
  assert.equal(requests.length, 2, "duplicate scans must share the two required interval requests");
  assert.deepEqual(new Set(requests.map((url) => url.searchParams.get("interval"))), new Set(["5_MINUTE", "15_MINUTE"]));
  assert.equal(requests.every((url) => url.searchParams.get("refresh") === "1"), true);
});

test("an indicator 429 blocks further provider requests while entry stays fail-closed", async (t) => {
  let requests = 0;
  const { confirmIndicatorPreset } = await indicatorHarness(t, async () => {
    requests += 1;
    return new Response(JSON.stringify({ error: "Jupiter HTTP 429" }), {
      status: 429,
      headers: { "retry-after": "20" },
    });
  });

  const first = await confirmIndicatorPreset({ mint: "RateLimitedMint", side: "entry", refresh: true });
  const second = await confirmIndicatorPreset({ mint: "AnotherMint", side: "entry", refresh: true });

  assert.equal(first.confirmed, false);
  assert.equal(second.confirmed, false);
  assert.equal(requests, 1, "other intervals and mints must observe the provider cooldown");
});

test("all required indicator intervals must still be fresh when final confirmation is returned", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const { confirmIndicatorPreset } = await indicatorHarness(t, async () => {
    now += 4_000;
    return new Response(JSON.stringify(bullishPayload()));
  });

  const result = await confirmIndicatorPreset({ mint: "SlowIntervalsMint", side: "entry", refresh: true });

  assert.equal(result.confirmed, false, "the first interval has expired while waiting for the second");
  assert.equal(result.intervals[0].ok, false);
  assert.match(result.intervals[0].reason, /stale|freshness|expired/i);
});

test("indicator request identity includes RSI length and candle count", async (t) => {
  const requests = [];
  const { confirmIndicatorPreset } = await indicatorHarness(t, async (url) => {
    requests.push(new URL(url));
    return new Response(JSON.stringify(bullishPayload()));
  });
  const args = { mint: "SettingsMint", side: "entry", intervals: ["5_MINUTE"], refresh: true };
  await confirmIndicatorPreset(args);
  config.indicators.rsiLength = 9;
  await confirmIndicatorPreset(args);
  config.indicators.candles = 200;
  await confirmIndicatorPreset(args);

  assert.deepEqual(requests.map((url) => [url.searchParams.get("rsiLength"), url.searchParams.get("candles")]), [["7", "298"], ["9", "298"], ["9", "200"]]);
});

test("an aborted indicator request has a bounded deadline and cannot confirm an entry", async (t) => {
  const deadlines = [];
  t.mock.method(AbortSignal, "timeout", (delay) => {
    deadlines.push(delay);
    return AbortSignal.abort(new DOMException("indicator timeout", "TimeoutError"));
  });
  const { confirmIndicatorPreset } = await indicatorHarness(t, async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    options.signal.throwIfAborted();
    assert.fail("a timed out fetch must not return a snapshot");
  });

  const result = await confirmIndicatorPreset({ mint: "TimedOutMint", side: "entry", refresh: true });

  assert.equal(result.confirmed, false);
  assert.equal(deadlines.length, 2);
  assert.equal(deadlines.every((delay) => delay > 0 && delay <= 4_000), true);
});
