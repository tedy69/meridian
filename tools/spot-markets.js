import { PublicKey } from "@solana/web3.js";
import { config } from "../config.js";
import { SOL_MINT } from "../execution-guard.js";
import { createMarketDataCache } from "../market-data-cache.js";

const JUPITER = "https://api.jup.ag/tokens/v2";
const DEX = "https://api.dexscreener.com";
const cache = createMarketDataCache();
const text = (value) => String(value || "").replace(/[<>`\r\n\t]/g, " ").slice(0, 80);
const numeric = (value) => value == null || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const address = (value) => new PublicKey(value).toBase58();

async function requestJson(url, { ttlMs = 10000 } = {}) {
  const provider = url.startsWith(JUPITER) ? "jupiter-tokens" : "dexscreener";
  return cache.get(url, async () => {
    const response = await fetch(url, {
      headers: provider === "jupiter-tokens" ? { "x-api-key": config.jupiter.apiKey } : {},
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      const error = new Error(`${provider} HTTP ${response.status}`);
      error.status = response.status;
      error.retryAfter = response.headers.get("retry-after");
      throw error;
    }
    return response.json();
  }, { ttlMs, rateLimitKey: provider });
}

// Pair statistics are venue-specific; token audit/activity is mint-specific.
// A price/volume signal from another chain or quote asset is never re-labelled SOL.
export function normalizeSpotMarket(pair, token, now = Date.now()) {
  if (pair?.chainId !== "solana") throw new Error("Spot market is not on Solana");
  const mint = address(token?.id);
  if (pair?.baseToken?.address !== mint || mint === SOL_MINT) throw new Error("Pair and token mint do not match");
  if (pair?.quoteToken?.address !== SOL_MINT) throw new Error("Spot market must be SOL-quoted");
  const updated = Date.parse(token?.updatedAt);
  if (!Number.isFinite(updated)) throw new Error("Token snapshot timestamp is missing");
  if (now - updated > 60000 || updated > now + 5000) throw new Error("Token snapshot is stale or future-dated");
  if (token?.audit?.isSus === true || token?.verification === "banned") throw new Error("Token is suspicious or banned");
  const created = Date.parse(token?.firstPool?.createdAt);
  const liquidity = numeric(pair?.liquidity?.usd);
  const volume = numeric(pair?.volume?.m5);
  if (!pair.dexId || liquidity == null || liquidity <= 0 || volume == null) throw new Error("Pair liquidity/volume/venue is unavailable");
  return {
    pool: address(pair.pairAddress),
    name: `${text(pair.baseToken.symbol)}-SOL`,
    venue: text(pair.dexId),
    market_source: "dexscreener",
    price_source: "jupiter_quote",
    base: { mint, symbol: text(pair.baseToken.symbol), organic: numeric(token.organicScore) },
    quote: { mint: SOL_MINT, symbol: "SOL" },
    tvl: liquidity,
    active_tvl: liquidity,
    volume_window: volume,
    volume_active_tvl_ratio: volume / liquidity,
    organic_score: numeric(token.organicScore),
    holders: numeric(token.holderCount),
    mcap: numeric(token.mcap),
    // Jupiter firstPool is first tradable time, not mint creation time.
    token_age_hours: Number.isFinite(created) && created <= now ? (now - created) / 3600000 : null,
    price_change_pct: numeric(pair?.priceChange?.m5),
    volume_change_pct: numeric(token?.stats5m?.volumeChange),
    token_snapshot_at: token.updatedAt,
    checked_at: new Date(now).toISOString(),
  };
}

export function createSpotMarketProvider({ requestJson: request = requestJson, now = Date.now } = {}) {
  return {
    async discover({ page_size = 50 } = {}) {
      const sourceErrors = [];
      const feeds = await Promise.all(["toptrending", "toptraded"].map(async (category) => {
        try {
          const result = await request(`${JUPITER}/${category}/5m?limit=50`, { ttlMs: 10000 });
          if (!Array.isArray(result)) throw new Error("Invalid token feed response");
          return result;
        } catch (error) {
          sourceErrors.push({ source: category, reason: error.message });
          return [];
        }
      }));
      const tokens = [...new Map(feeds.flat().filter((token) => token?.id && token.id !== SOL_MINT).map((token) => [token.id, token])).values()];
      const policy = config.spotDiscovery;
      // Avoid pair lookups for obviously ineligible assets; entry applies stricter gates later.
      const eligible = tokens.filter((token) => Number(token.liquidity) >= policy.minLiquidityUsd
        && Number(token.organicScore) >= policy.minOrganic && Number(token.holderCount) >= policy.minHolders
        && Number(token.mcap) >= policy.minMarketCapUsd && Number(token.mcap) <= policy.maxMarketCapUsd);
      const pools = [];
      const rejected = [];
      const selected = eligible.slice(0, Math.min(30, Math.max(1, Number(page_size) || 30)));
      let pairs = [];
      if (selected.length) {
        try {
          const mints = selected.map((token) => address(token.id)).sort().join(",");
          pairs = await request(`${DEX}/tokens/v1/solana/${mints}`, { ttlMs: 10000 });
          if (!Array.isArray(pairs)) throw new Error("Invalid pair feed response");
        } catch (error) {
          sourceErrors.push({ source: "dexscreener", reason: error.message });
          pairs = [];
        }
      }
      for (const token of selected) {
        try {
          const markets = [];
          for (const pair of pairs) {
            try { markets.push(normalizeSpotMarket(pair, token, now())); } catch { /* unsupported or stale pair */ }
          }
          markets.sort((a, b) => b.tvl - a.tvl);
          if (markets[0]) pools.push(markets[0]);
          else rejected.push({ name: text(token.symbol), reason: "No fresh, liquid SOL pair with matching mint" });
        } catch (error) {
          rejected.push({ name: text(token.symbol), reason: error.message });
        }
      }
      return { pools, unique_mints: tokens.length, pair_lookups: selected.length,
        source_errors: sourceErrors, filtered_examples: rejected.slice(0, 5),
        coverage: "Jupiter trending/traded tokens + cross-DEX SOL pairs; not every Solana token" };
    },
    async resolve({ pool_address }) {
      const pool = address(pool_address);
      const response = await request(`${DEX}/latest/dex/pairs/solana/${pool}`, { ttlMs: 0 });
      const pair = response?.pairs?.find((entry) => entry?.pairAddress === pool && entry?.chainId === "solana");
      if (!pair) throw new Error("Fresh pair response does not match requested Solana pool");
      const mint = address(pair.baseToken?.address);
      const tokens = await request(`${JUPITER}/search?query=${mint}`, { ttlMs: 0 });
      const token = Array.isArray(tokens) ? tokens.find((entry) => entry?.id === mint) : null;
      if (!token) throw new Error("Fresh token response does not match pair mint");
      return normalizeSpotMarket(pair, token, now());
    },
  };
}

const provider = createSpotMarketProvider();
export const discoverSpotMarkets = (args) => provider.discover(args);
export const getSpotMarket = (args) => provider.resolve(args);
