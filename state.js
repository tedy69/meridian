/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { evaluateTrailingProfitFloor } from "./trailing-safety.js";

const STATE_FILE = process.env.MERIDIAN_STATE_FILE || repoPath("state.json");

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function emptyState() {
  return { positions: {}, recentEvents: [], pendingAutoSwaps: {}, lastUpdated: null };
}

function normalizeState(state) {
  const normalized = state && typeof state === "object" ? state : emptyState();
  if (!normalized.positions || typeof normalized.positions !== "object") normalized.positions = {};
  if (!Array.isArray(normalized.recentEvents)) normalized.recentEvents = [];
  if (!normalized.pendingAutoSwaps || typeof normalized.pendingAutoSwaps !== "object" || Array.isArray(normalized.pendingAutoSwaps)) {
    normalized.pendingAutoSwaps = {};
  }
  return normalized;
}

function load() {
  if (!fs.existsSync(STATE_FILE)) {
    return emptyState();
  }
  try {
    return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return emptyState();
  }
}

function save(state) {
  try {
    normalizeState(state);
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  entry_mcap = null,
  entry_tvl = null,
  entry_volume = null,
  entry_holders = null,
}) {
  const state = load();
  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_confirm_count: 0,
    pending_peak_started_at: null,
    pending_exit_action: null,
    pending_exit_count: 0,
    pending_exit_started_at: null,
    trailing_active: false,
    last_missing_observation_at: null,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool });
  save(state);
  log("state", `Tracked new position: ${position} in pool ${pool}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Recover a historical false-close only when the caller has separately proven
 * that the position account still exists at finalized commitment.
 */
export function reopenPositionFromOnChain(position_address, reason = "position account exists at finalized commitment") {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.closed) return false;
  const now = new Date().toISOString();
  pos.closed = false;
  pos.closed_at = null;
  if (!Array.isArray(pos.notes)) pos.notes = [];
  pos.notes.push(`Reopened at ${now}: ${sanitizeStoredText(reason)}`);
  pushEvent(state, { action: "reopen", position: position_address, pool_name: pos.pool_name || pos.pool, reason: sanitizeStoredText(reason) });
  save(state);
  log("state", `Position ${position_address} restored to open: ${reason}`);
  return true;
}

// ─── Pending Auto-swap Registry ────────────────────────────────

function pendingAutoSwapKey(position_address, base_mint) {
  return `${position_address}:${base_mint}`;
}

/**
 * Persist settlement work before attempting a swap. A process restart, RPC
 * outage, or Jupiter route failure must not make an unsold token disappear
 * from the agent's responsibilities.
 */
export function queuePendingAutoSwap({ position_address, base_mint, close_txs = [] }) {
  if (!position_address || !base_mint) {
    throw new Error("position_address and base_mint are required to queue an auto-swap");
  }
  const state = load();
  const key = pendingAutoSwapKey(position_address, base_mint);
  const now = new Date().toISOString();
  const existing = state.pendingAutoSwaps[key] || {};
  const wasAlreadyPending = existing.status === "pending_auto_swap";
  const entry = {
    ...existing,
    key,
    position_address,
    base_mint,
    close_txs: [...new Set([...(existing.close_txs || []), ...close_txs].filter(Boolean))],
    status: "pending_auto_swap",
    created_at: existing.created_at || now,
    updated_at: now,
    attempt_count: Number.isFinite(existing.attempt_count) ? existing.attempt_count : 0,
    last_error: existing.last_error || null,
    last_attempt_at: existing.last_attempt_at || null,
    last_observed_amount: existing.last_observed_amount ?? null,
  };
  state.pendingAutoSwaps[key] = entry;
  if (!wasAlreadyPending) {
    pushEvent(state, { action: "auto_swap_queued", position: position_address, base_mint });
  }
  save(state);
  log("state", `Queued base→SOL settlement for ${position_address} (${base_mint})`);
  return entry;
}

export function getPendingAutoSwaps() {
  const state = load();
  return Object.values(state.pendingAutoSwaps)
    .filter((entry) => entry?.status === "pending_auto_swap")
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

export function recordPendingAutoSwapAttempt(key, { error = null, observed_amount = null } = {}) {
  const state = load();
  const entry = state.pendingAutoSwaps[key];
  if (!entry) return null;
  entry.attempt_count = (Number.isFinite(entry.attempt_count) ? entry.attempt_count : 0) + 1;
  entry.last_attempt_at = new Date().toISOString();
  entry.updated_at = entry.last_attempt_at;
  entry.last_error = error ? sanitizeStoredText(error) : null;
  entry.last_observed_amount = Number.isFinite(observed_amount) ? observed_amount : null;
  save(state);
  return entry;
}

export function completePendingAutoSwap(key, {
  settlement_status = "settled_to_sol",
  tx = null,
  observed_amount = null,
} = {}) {
  const state = load();
  const entry = state.pendingAutoSwaps[key];
  if (!entry) return null;
  const now = new Date().toISOString();
  entry.status = settlement_status;
  entry.settled_at = now;
  entry.updated_at = now;
  entry.tx = tx || entry.tx || null;
  entry.last_error = null;
  entry.last_observed_amount = Number.isFinite(observed_amount) ? observed_amount : entry.last_observed_amount ?? null;
  pushEvent(state, {
    action: "auto_swap_settled",
    position: entry.position_address,
    base_mint: entry.base_mint,
    settlement_status,
    tx: entry.tx,
  });
  save(state);
  log("state", `Settled pending base→SOL swap for ${entry.position_address}: ${settlement_status}`);
  return entry;
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

/**
 * Raise the confirmed peak PnL only after `confirmTicks` consecutive polls where the
 * candidate stays above the current peak. With the 3s RPC poller this confirms a real
 * high in ~3-6s and prevents a single noisy tick from inflating the peak (which would
 * otherwise arm a false trailing-drop). Replaces the old 15s setTimeout recheck.
 * Returns true when the peak was raised this call.
 */
export function confirmPeak(position_address, candidatePnlPct, confirmTicks = 2) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  // No new high — drop any pending peak candidate.
  if (candidatePnlPct <= currentPeak) {
    if (pos.pending_peak_pnl_pct != null) {
      pos.pending_peak_pnl_pct = null;
      pos.pending_peak_confirm_count = 0;
      save(state);
    }
    return false;
  }

  // Same-or-higher candidate as the pending one → another confirming tick.
  if (pos.pending_peak_pnl_pct != null && candidatePnlPct >= pos.pending_peak_pnl_pct) {
    pos.pending_peak_confirm_count = (pos.pending_peak_confirm_count ?? 1) + 1;
    pos.pending_peak_pnl_pct = candidatePnlPct;
  } else {
    // New / lower-than-pending candidate → start a fresh confirmation streak.
    pos.pending_peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_confirm_count = 1;
    pos.pending_peak_started_at = new Date().toISOString();
  }

  if (pos.pending_peak_confirm_count >= confirmTicks) {
    pos.peak_pnl_pct = Math.max(currentPeak, pos.pending_peak_pnl_pct);
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_confirm_count = 0;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% (${confirmTicks} ticks)`);
    return true;
  }

  save(state);
  return false;
}

/**
 * Consecutive-tick confirmation for an exit signal. The fast poller calls this every
 * tick with the exit action string detected this poll (or null when no exit). An exit
 * only fires after `confirmTicks` consecutive polls report the SAME action — so a single
 * noisy tick can't close a position. Streak resets whenever the signal clears or changes.
 * Returns { fire, action, count }.
 */
export function registerExitSignal(position_address, signal, confirmTicks = 2) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return { fire: false, action: null, count: 0 };

  if (!signal) {
    if (pos.pending_exit_action != null) {
      pos.pending_exit_action = null;
      pos.pending_exit_count = 0;
      save(state);
    }
    return { fire: false, action: null, count: 0 };
  }

  if (pos.pending_exit_action === signal) {
    pos.pending_exit_count = (pos.pending_exit_count ?? 1) + 1;
  } else {
    pos.pending_exit_action = signal;
    pos.pending_exit_count = 1;
    pos.pending_exit_started_at = new Date().toISOString();
  }

  const count = pos.pending_exit_count;
  const fire = count >= confirmTicks;
  if (fire) {
    pos.pending_exit_action = null;
    pos.pending_exit_count = 0;
    pos.pending_exit_started_at = null;
  }
  save(state);
  if (fire) log("state", `Position ${position_address} exit signal "${signal}" confirmed (${confirmTicks} ticks)`);
  return { fire, action: signal, count };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const pendingAutoSwaps = Object.values(state.pendingAutoSwaps)
    .filter((entry) => entry?.status === "pending_auto_swap")
    .map((entry) => ({
      position: entry.position_address,
      base_mint: entry.base_mint,
      attempts: entry.attempt_count || 0,
      last_error: entry.last_error || null,
      last_observed_amount: entry.last_observed_amount ?? null,
    }));
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    pending_auto_swaps: pendingAutoSwaps,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  let changed = false;

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= mgmtConfig.trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    changed = true;
    log("state", `Position ${position_address} marked out of range`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  }

  if (changed) save(state);

  // ── Stop loss ──────────────────────────────────────────────────
  if (!pnl_pct_suspicious && currentPnlPct != null && mgmtConfig.stopLossPct != null && currentPnlPct <= mgmtConfig.stopLossPct) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${mgmtConfig.stopLossPct}%`,
    };
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && pos.trailing_active && currentPnlPct != null) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    const profitFloor = evaluateTrailingProfitFloor({
      currentPnlPct,
      minimumPnlPct: mgmtConfig.trailingMinClosePnlPct,
    });
    if (dropFromPeak >= mgmtConfig.trailingDropPct && profitFloor.allowed) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP: peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (dropped ${dropFromPeak.toFixed(2)}% >= ${mgmtConfig.trailingDropPct}%, profit floor ${profitFloor.minimumPnlPct.toFixed(2)}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  if (pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    if (minutesOOR >= mgmtConfig.outOfRangeWaitMinutes) {
      return {
        action: "OUT_OF_RANGE",
        reason: `Out of range for ${minutesOOR}m (limit: ${mgmtConfig.outOfRangeWaitMinutes}m)`,
      };
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with an observed open-position feed.
 *
 * The feed may be stale, incomplete, or unavailable. Its absence therefore only
 * records a reconciliation warning; it can never close a tracked position.
 * `recordClose` is reserved for direct finalized on-chain verification.
 */
export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses || []);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed) continue;
    if (activeSet.has(posId)) {
      if (pos.last_missing_observation_at) {
        pos.last_missing_observation_at = null;
        changed = true;
        log("state", `Position ${posId} is visible in the observed feed again`);
      }
      continue;
    }

    if (!pos.last_missing_observation_at) {
      pos.last_missing_observation_at = new Date().toISOString();
      if (!Array.isArray(pos.notes)) pos.notes = [];
      pos.notes.push("Missing from observed open-position feed; awaiting direct on-chain close verification");
      pushEvent(state, { action: "position_missing_observation", position: posId });
      changed = true;
      log("state", `Position ${posId} missing from observed feed; keeping it open pending direct verification`);
    }
  }

  if (changed) save(state);
}
