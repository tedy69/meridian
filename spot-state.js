import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { repoPath } from "./repo-root.js";

const DEFAULT_SPOT_STATE_PATH = process.env.MERIDIAN_SPOT_STATE_FILE || repoPath("spot-state.json");
const MAX_HISTORY = 200;

function emptyState() {
  return { version: 1, position: null, history: [], lastUpdated: null };
}

function statePath(options = {}) {
  return options.statePath || DEFAULT_SPOT_STATE_PATH;
}

function read(options = {}) {
  const file = statePath(options);
  if (!fs.existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("state must be an object");
    if (!Array.isArray(parsed.history)) throw new Error("history must be an array");
    if (parsed.position != null && (typeof parsed.position !== "object" || Array.isArray(parsed.position))) {
      throw new Error("position must be an object or null");
    }
    return { ...emptyState(), ...parsed };
  } catch (error) {
    throw new Error(`Cannot read spot state file ${file}: ${error.message}`);
  }
}

function write(state, options = {}) {
  const file = statePath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...state, lastUpdated: new Date().toISOString() };
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return next;
}

function cleanText(value, maxLength = 120) {
  return String(value || "").replace(/[\r\n\t<>`]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength) || null;
}

export function getSpotState(options = {}) {
  return read(options);
}

export function getSpotPosition(options = {}) {
  return read(options).position;
}

export function beginSpotOpen(data, options = {}) {
  const state = read(options);
  if (state.position) throw new Error(`Spot position ${state.position.id} is already ${state.position.status}.`);
  const id = `spot_${Date.now()}_${randomUUID().slice(0, 8)}`;
  state.position = {
    id,
    status: "opening",
    pool: data.pool,
    poolName: cleanText(data.poolName || data.pool),
    venue: cleanText(data.venue || "meteora"),
    marketSource: cleanText(data.marketSource || "meteora_dlmm"),
    priceSource: data.priceSource === "jupiter_quote" ? "jupiter_quote" : "meteora_active_bin",
    mint: data.mint,
    symbol: cleanText(data.symbol || data.mint, 32),
    entryCostSol: Number(data.entryCostSol),
    solBalanceBefore: Number(data.solBalanceBefore),
    tokenBalanceBefore: Number(data.tokenBalanceBefore || 0),
    tokenRawBalanceBefore: String(data.tokenRawBalanceBefore ?? ""),
    tokenDecimals: Number(data.tokenDecimals),
    signalSnapshot: data.signalSnapshot || null,
    openingStartedAt: new Date().toISOString(),
    openedAt: null,
    peakPnlPct: 0,
    lastPnlPct: null,
    lastValueSol: null,
    lastObservedAt: null,
    buyTx: null,
  };
  write(state, options);
  return { ...state.position };
}

export function markSpotOpeningSubmitted(id, data = {}, options = {}) {
  const state = read(options);
  if (!state.position || state.position.id !== id || !["opening", "open"].includes(state.position.status)) {
    throw new Error(`Pending spot open ${id} was not found.`);
  }
  state.position.buyTx = data.buyTx || state.position.buyTx || null;
  state.position.submissionAttemptedAt = data.submissionAttemptedAt || new Date().toISOString();
  write(state, options);
  return { ...state.position };
}

export function confirmSpotOpen(id, data, options = {}) {
  const state = read(options);
  if (!state.position || state.position.id !== id || !["opening", "open"].includes(state.position.status)) {
    throw new Error(`Pending spot open ${id} was not found.`);
  }
  state.position = {
    ...state.position,
    status: "open",
    entryCostSol: Number.isFinite(Number(data.entryCostSol)) && Number(data.entryCostSol) > 0
      ? Number(data.entryCostSol)
      : state.position.entryCostSol,
    tokenAmount: Number(data.tokenAmount),
    tokenRawAmount: String(data.tokenRawAmount ?? ""),
    tokenDecimals: Number(data.tokenDecimals),
    entryTokenUsd: data.entryTokenUsd != null && Number.isFinite(Number(data.entryTokenUsd))
      ? Number(data.entryTokenUsd)
      : state.position.entryTokenUsd ?? null,
    entrySolUsd: data.entrySolUsd != null && Number.isFinite(Number(data.entrySolUsd))
      ? Number(data.entrySolUsd)
      : state.position.entrySolUsd ?? null,
    openedAt: state.position.openedAt || data.openedAt || new Date().toISOString(),
    buyTx: data.buyTx || state.position.buyTx || null,
  };
  write(state, options);
  return { ...state.position };
}

export function cancelSpotOpen(id, reason, options = {}) {
  const state = read(options);
  if (!state.position || state.position.id !== id || state.position.status !== "opening") return false;
  state.history.unshift({ ...state.position, status: "open_cancelled", closedAt: new Date().toISOString(), reason: cleanText(reason, 280) });
  state.history = state.history.slice(0, MAX_HISTORY);
  state.position = null;
  write(state, options);
  return true;
}

export function updateSpotObservation(id, observation, options = {}) {
  const state = read(options);
  if (!state.position || state.position.id !== id || !["open", "closing"].includes(state.position.status)) {
    throw new Error(`Open spot position ${id} was not found.`);
  }
  const observedPeak = Number(observation.peakPnlPct);
  state.position.peakPnlPct = Number.isFinite(observedPeak)
    ? Math.max(Number(state.position.peakPnlPct || 0), observedPeak)
    : Number(state.position.peakPnlPct || 0);
  state.position.lastPnlPct = Number.isFinite(Number(observation.pnlPct)) ? Number(observation.pnlPct) : null;
  state.position.lastValueSol = Number.isFinite(Number(observation.currentValueSol)) ? Number(observation.currentValueSol) : null;
  state.position.lastObservedAt = observation.observedAt || new Date().toISOString();
  write(state, options);
  return { ...state.position };
}

export function updateSpotTokenBalance(id, balance, options = {}) {
  const state = read(options);
  if (!state.position || state.position.id !== id || !["open", "closing"].includes(state.position.status)) {
    throw new Error(`Active spot position ${id} was not found.`);
  }
  state.position.tokenAmount = Number(balance.amount);
  state.position.tokenRawAmount = String(balance.raw_amount);
  state.position.tokenDecimals = Number(balance.decimals);
  write(state, options);
  return { ...state.position };
}

export function markSpotClosing(id, data = {}, options = {}) {
  const state = read(options);
  if (!state.position || state.position.id !== id || state.position.status !== "open") {
    throw new Error(`Open spot position ${id} was not found.`);
  }
  state.position.status = "closing";
  state.position.closingStartedAt = new Date().toISOString();
  state.position.closeReason = cleanText(data.reason, 280);
  state.position.solBalanceBeforeClose = Number(data.solBalanceBeforeClose);
  state.position.tokenBalanceBeforeClose = Number(data.tokenBalanceBeforeClose);
  write(state, options);
  return { ...state.position };
}

export function restoreSpotOpen(id, error, options = {}) {
  const state = read(options);
  if (!state.position || state.position.id !== id || state.position.status !== "closing") return false;
  state.position.status = "open";
  state.position.lastCloseError = cleanText(error, 280);
  state.position.lastCloseFailedAt = new Date().toISOString();
  delete state.position.closingStartedAt;
  write(state, options);
  return true;
}

export function completeSpotClose(id, data, options = {}) {
  const state = read(options);
  if (!state.position || state.position.id !== id || state.position.status !== "closing") {
    throw new Error(`Closing spot position ${id} was not found.`);
  }
  const closed = {
    ...state.position,
    status: "closed",
    closedAt: data.closedAt || new Date().toISOString(),
    sellTx: data.sellTx || null,
    exitSol: Number(data.exitSol),
    pnlSol: Number(data.pnlSol),
    pnlPct: Number(data.pnlPct),
    closeReason: cleanText(data.reason || state.position.closeReason, 280),
  };
  state.history.unshift(closed);
  state.history = state.history.slice(0, MAX_HISTORY);
  state.position = null;
  write(state, options);
  return closed;
}

export function getSpotHistory(limit = 20, options = {}) {
  return read(options).history.slice(0, Math.max(0, Number(limit) || 0));
}
