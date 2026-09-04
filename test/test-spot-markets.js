import assert from "node:assert/strict";
import test from "node:test";
import { SOL_MINT } from "../execution-guard.js";
import { createSpotMarketProvider, normalizeSpotMarket } from "../tools/spot-markets.js";

const now = Date.parse("2026-09-04T12:00:00Z");
const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const pool = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const token = () => ({ id: mint, symbol: "TEST", organicScore: 85, holderCount: 900, mcap: 900000, liquidity: 100000,
  firstPool: { createdAt: "2026-09-04T08:00:00Z" }, updatedAt: new Date(now).toISOString(),
  stats5m: { priceChange: 4, volumeChange: 50, buyVolume: 7000, sellVolume: 3000 } });
const pair = (dexId = "raydium") => ({ chainId: "solana", dexId, pairAddress: pool,
  baseToken: { address: mint, symbol: "TEST" }, quoteToken: { address: SOL_MINT, symbol: "SOL" },
  liquidity: { usd: 100000 }, volume: { m5: 10000 }, priceChange: { m5: 4 }, marketCap: 900000 });

test("spot markets normalize Raydium, Orca and PumpSwap without pretending to be DLMM", () => {
  for (const dex of ["raydium", "orca", "pumpswap", "meteora"]) {
    const market = normalizeSpotMarket(pair(dex), token(), now);
    assert.equal(market.venue, dex);
    assert.equal(market.price_source, "jupiter_quote");
    assert.equal(market.pool, pool);
    assert.equal(market.base.mint, mint);
    assert.equal(market.volume_window, 10000);
    assert.equal(market.token_age_hours, 4);
  }
});

test("cross-DEX normalization rejects wrong chain, mint, quote and stale token stats", () => {
  for (const bad of [{ ...pair(), chainId: "ethereum" }, { ...pair(), baseToken: { address: SOL_MINT } },
    { ...pair(), quoteToken: { address: mint } }]) {
    assert.throws(() => normalizeSpotMarket(bad, token(), now));
  }
  assert.throws(() => normalizeSpotMarket(pair(), { ...token(), updatedAt: new Date(now - 120000).toISOString() }, now), /stale/i);
  assert.throws(() => normalizeSpotMarket(pair(), { ...token(), audit: { isSus: true } }, now), /suspicious/i);
  assert.throws(() => normalizeSpotMarket(pair(), { ...token(), updatedAt: null }, now), /timestamp/i);
});

test("feeds deduplicate by mint and select deepest SOL pair across DEXs", async () => {
  let pairCalls = 0;
  const provider = createSpotMarketProvider({ now: () => now, requestJson: async (url) => {
    if (url.includes("tokens/v2")) return [token(), token()];
    pairCalls++;
    return [{ ...pair("orca"), liquidity: { usd: 50000 } }, pair()];
  } });
  const result = await provider.discover();
  assert.equal(pairCalls, 1);
  assert.equal(result.pools.length, 1);
  assert.equal(result.pools[0].venue, "raydium");
  assert.equal(result.unique_mints, 1);
});

test("pair discovery batches multiple mints into one bounded API request", async () => {
  const other = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  let pairCalls = 0;
  const provider = createSpotMarketProvider({ now: () => now, requestJson: async (url) => {
    if (url.includes("tokens/v2")) return [token(), { ...token(), id: other }];
    pairCalls++;
    return [pair(), { ...pair("orca"), baseToken: { address: other, symbol: "OTHER" } }];
  } });
  const result = await provider.discover();
  assert.equal(pairCalls, 1);
  assert.equal(result.pools.length, 2);
});

test("one failed discovery source is visible, not treated as healthy empty discovery", async () => {
  const provider = createSpotMarketProvider({ now: () => now, requestJson: async (url) => {
    if (url.includes("toptrending")) throw new Error("HTTP 429");
    if (url.includes("tokens/v2")) return [token()];
    return [pair()];
  } });
  const result = await provider.discover();
  assert.equal(result.pools.length, 1);
  assert.equal(result.source_errors.length, 1);
});

test("entry resolution binds exact pair and re-fetches token stats without cached discovery", async () => {
  const calls = [];
  const provider = createSpotMarketProvider({ now: () => now, requestJson: async (url, opts) => {
    calls.push({ url, opts });
    return url.includes("tokens/v2") ? [token()] : { pairs: [pair()] };
  } });
  const result = await provider.resolve({ pool_address: pool });
  assert.equal(result.base.mint, mint);
  assert.ok(calls.every(({ opts }) => opts.ttlMs === 0));
  await assert.rejects(provider.resolve({ pool_address: SOL_MINT }), /match/i);
});
