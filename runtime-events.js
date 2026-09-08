import { PublicKey } from "@solana/web3.js";
import { log } from "./logger.js";

const listeners = new Set();
const identities = new Map();
const watchlists = new Map();
const WATCHLIST_TTL_MS = 60_000;
const MAX_WATCH_POOLS = 10;

export function onRuntimeChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Only lifecycle/target changes wake work. PnL observation writes must not
// recursively start another refresh of their own.
export function publishRuntimeChange(kind, identity) {
  if (identities.get(kind) === identity) return;
  identities.set(kind, identity);
  for (const listener of listeners) {
    try {
      Promise.resolve(listener(kind)).catch((error) => log("realtime_warn", error.message));
    } catch (error) {
      log("realtime_warn", error.message);
    }
  }
}

export function updateEntryWatchlist(strategy, pools, now = Date.now()) {
  const addresses = [];
  for (const pool of pools || []) {
    try {
      const address = new PublicKey(pool.pool).toBase58();
      if (!addresses.includes(address)) addresses.push(address);
    } catch { /* incomplete discovery results cannot become subscriptions */ }
    if (addresses.length >= MAX_WATCH_POOLS) break;
  }
  watchlists.set(strategy, { addresses, expiresAt: now + WATCHLIST_TTL_MS });
  publishRuntimeChange(`watchlist:${strategy}`, addresses.join(","));
}

export function getEntryWatchAccounts(now = Date.now()) {
  return [...new Set([...watchlists.values()]
    .filter((watchlist) => watchlist.expiresAt > now)
    .flatMap((watchlist) => watchlist.addresses))];
}
