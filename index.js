import "./envcrypt.js";
import cron from "node-cron";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { Connection } from "@solana/web3.js";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, getActiveBin } from "./tools/dlmm.js";
import { getTokenBalanceByMint, getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates, degenScore } from "./tools/screening.js";
import {
  config,
  reloadScreeningThresholds,
  computeDeployAmount,
  formatSolAmount,
  getAutoDeploySizing,
  getCircuitAdjustedDeploySizing,
} from "./config.js";
import { evolveThresholds, getAllPerformanceRecords, getPerformanceSummary } from "./lessons.js";
import { drainPendingAutoSwaps, executeTool, registerCronRestarter } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  notifyOutOfRange,
  isEnabled as telegramEnabled,
  createLiveMessage,
} from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, getTrackedPositions, setPositionInstruction, updatePnlAndCheckExits, confirmPeak, registerExitSignal } from "./state.js";
import { getSpotPosition as readSpotPosition } from "./spot-state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { stageSignals } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./hivemind.js";
import { appendDecision } from "./decision-log.js";
import { assertMainnetRpc, SOL_MINT } from "./execution-guard.js";
import { executeClaimAll, formatClaimAllOutcome, formatClaimAllPreflight, prepareClaimAll } from "./claim-all.js";
import { revalidateTrailingProfitFloor } from "./trailing-safety.js";
import { revalidateStopLossExecution, selectExitConfirmationTicks } from "./stop-loss-safety.js";
import { getPnlWatchdogGate } from "./pnl-watchdog-safety.js";
import { formatNetPnlPercent } from "./position-performance.js";
import { buildRiskIntelligenceBrief, evaluateLossCircuitBreaker, evaluateTokenAuditRisk } from "./risk-intelligence.js";
import { getSpotMomentumCandidates, getSpotPositionSnapshot, getSpotStatus } from "./tools/spot.js";
import { createSpotRealtimeMonitor } from "./spot-realtime.js";
import { selectSpotEntryCandidate } from "./spot-momentum.js";
import { isSpotEnabled, isLpEnabled, getHybridRiskStatus } from "./hybrid-risk.js";
import { scanHybridCandidates } from "./hybrid-strategy.js";
import { createMarketDataCache } from "./market-data-cache.js";
import { getTradingStatus, formatTradingStatus } from "./tools/trading-status.js";
const hybridLpCache = createMarketDataCache({ maxEntries: 2 });
import {
  createSpotConfirmationStore,
  formatConfirmedSpotOpenResult,
  formatSpotConfirmationResolution,
  groundSpotAgentOutcome,
} from "./telegram-spot-confirmation.js";

import { REPO_ROOT, repoPath } from "./repo-root.js";

const entrypointPath = process.env.pm_exec_path || process.argv[1];
const indexPath = fileURLToPath(import.meta.url);
const isMain = process.env.pm_id != null
  || (entrypointPath ? path.resolve(entrypointPath) === indexPath : false);

let runtimeRpcVerified = true;
if (isMain) {
  log("startup", `Meridian ${config.trading.mode} Agent starting...`);
  log("startup", `Repo: ${REPO_ROOT} | cwd: ${process.cwd()}${process.env.pm_id ? ` | PM2 id: ${process.env.pm_id}` : ""}`);
  if (path.resolve(process.cwd()) !== path.resolve(REPO_ROOT)) {
    log("startup_warn", `process.cwd() differs from repo root — use "npm run pm2:start" (not "pm2 start index.js" from another directory)`);
  }
  const dryRun = process.env.DRY_RUN === "true";
  const liveTradingEnabled = !dryRun && process.env.LIVE_TRADING_ENABLED === "true";
  log("startup", `Mode: ${dryRun ? "DRY RUN" : liveTradingEnabled ? "LIVE" : "LIVE CONFIGURATION — EXECUTION LOCKED"}`);
  log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
  try {
    await assertMainnetRpc(new Connection(process.env.RPC_URL, "confirmed"), "runtime startup");
    if (isHiveMindEnabled()) ensureAgentId();
    bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
    startHiveMindBackgroundSync();
  } catch (error) {
    runtimeRpcVerified = false;
    log("startup_error", error.message);
  }
}

const TP_PCT = config.management.takeProfitPct;
const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatPositionNetPnlValue(position, currency) {
  if (position?.net_pnl_status === "UNKNOWN" || position?.pnl_pct_suspicious) return "N/A";
  // pnl_usd follows the configured display currency (USD or SOL mode), while
  // net_pnl_usd is always USD and must not be rendered with a SOL symbol.
  const value = Number(position?.pnl_usd);
  if (!Number.isFinite(value)) return "N/A";
  return `${value >= 0 ? "+" : "-"}${currency}${Math.abs(value)}`;
}

function buildPrompt() {
  if (isSpotEnabled()) {
    const management = config.spot.realtimeEnabled
      ? `realtime/${config.spot.managementPollIntervalSec}s fallback`
      : `${config.spot.managementPollIntervalSec}s`;
    return `[${config.trading.mode} | spot manage: ${management} | scan: ${config.spot.scanIntervalSec}s]\n> `;
  }
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _claimAllBusy = false;   // prevents claim-all from racing another transaction loop
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
let _spotExitKey = null;
let _spotExitCount = 0;
let _spotRealtimeMonitor = null;
const spotConfirmationStore = createSpotConfirmationStore();
// Exit/peak confirmation is now done by consecutive-tick counting in state.js
// (registerExitSignal / confirmPeak), driven by the 3s RPC poller — no setTimeout rechecks.

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      const sent = await sendHTML(briefing);
      if (!sent?.ok) throw new Error("Telegram rejected the briefing delivery");
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  if (_cronTasks._opportunityPollInterval) clearInterval(_cronTasks._opportunityPollInterval);
  if (_cronTasks._spotManagementPollInterval) clearInterval(_cronTasks._spotManagementPollInterval);
  if (_cronTasks._spotScanInterval) clearInterval(_cronTasks._spotScanInterval);
  if (_spotRealtimeMonitor) {
    const monitor = _spotRealtimeMonitor;
    _spotRealtimeMonitor = null;
    monitor.stop().catch((error) => log("spot_realtime_warn", `Stop failed: ${error.message}`));
  }
  _cronTasks = [];
}

/**
 * Execute the actions decided by the deterministic rules. CLOSE/CLAIM run directly
 * via executeTool (no LLM) — preserving all post-effects (notify, auto-swap,
 * recordPerformance, decision-log, HiveMind). Only INSTRUCTION positions, whose
 * free-text condition JS can't parse, are handed to the MANAGER LLM. Returns a
 * one-line-per-position result string.
 */
async function executeManagementActions(actionPositions, actionMap, { liveMessage = null, cur = "$" } = {}) {
  const lines = [];
  const instructionPositions = [];

  const mechanical = actionPositions.filter(p => actionMap.get(p.position).action !== "INSTRUCTION");
  if (mechanical.length) {
    log("cron", `Management: executing ${mechanical.length} mechanical action(s) — no LLM`);
  }

  for (const p of actionPositions) {
    const act = actionMap.get(p.position);
    if (act.action === "INSTRUCTION") { instructionPositions.push(p); continue; }

    if (act.action === "CLOSE") {
      let reason = act.reason || (act.rule ? `Rule ${act.rule}` : "rule close");
      if (act.exitAction === "STOP_LOSS") {
        const fresh = await revalidateStopLossExecution({
          positionAddress: p.position,
          triggerPnlPct: config.management.stopLossTriggerPct,
          maximumPnlPct: config.management.stopLossPct,
          fetchPositions: () => getMyPositions({ force: true, silent: true }),
        });
        if (!fresh.allowed) {
          const observed = fresh.currentPnlPct == null ? "unavailable" : `${fresh.currentPnlPct.toFixed(2)}%`;
          const skipped = `stop-loss close skipped — ${fresh.reason} (fresh PnL ${observed}; trigger ${fresh.triggerPnlPct ?? "?"}%; target max ${fresh.maximumPnlPct ?? "?"}%)`;
          log("state", `${p.pair}: ${skipped}`);
          await liveMessage?.note(`${p.pair}: ${skipped}`);
          lines.push(`${p.pair}: ${skipped}`);
          continue;
        }
        if (fresh.atOrBeyondMaximum) {
          const emergency = `fresh PnL ${fresh.currentPnlPct.toFixed(2)}% is at/beyond target max ${fresh.maximumPnlPct.toFixed(2)}% — submitting stop-loss close immediately`;
          log("state", `${p.pair}: ${emergency}`);
          await liveMessage?.note(`${p.pair}: ${emergency}`);
        }
        reason = `${reason} | fresh PnL ${fresh.currentPnlPct.toFixed(2)}%`;
      } else if (act.exitAction === "TRAILING_TP") {
        const fresh = await revalidateTrailingProfitFloor({
          positionAddress: p.position,
          minimumPnlPct: config.management.trailingMinClosePnlPct,
          fetchPositions: () => getMyPositions({ force: true, silent: true }),
        });
        if (!fresh.allowed) {
          const observed = fresh.currentPnlPct == null ? "unavailable" : `${fresh.currentPnlPct.toFixed(2)}%`;
          const skipped = `trailing close skipped — ${fresh.reason} (fresh PnL ${observed}; floor ${fresh.minimumPnlPct.toFixed(2)}%)`;
          log("state", `${p.pair}: ${skipped}`);
          await liveMessage?.note(`${p.pair}: ${skipped}`);
          lines.push(`${p.pair}: ${skipped}`);
          continue;
        }
      }
      await liveMessage?.toolStart("close_position");
      const res = await executeTool("close_position", { position_address: p.position, reason }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("close_position", res, ok);
      const settlement = res?.settlement_status === "pending_auto_swap"
        ? " — close confirmed, base→SOL swap pending"
        : res?.settlement_status === "requires_manual_review"
        ? " — close confirmed, settlement requires manual review"
        : res?.settlement_status === "settled_to_sol"
        ? " — closed and settled to SOL"
        : "";
      lines.push(`${p.pair}: ${ok ? `closed (${reason})${settlement}` : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    } else if (act.action === "CLAIM") {
      await liveMessage?.toolStart("claim_fees");
      const res = await executeTool("claim_fees", { position_address: p.position }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("claim_fees", res, ok);
      lines.push(`${p.pair}: ${ok ? "fees claimed" : `claim FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    }
  }

  // INSTRUCTION positions need the LLM to evaluate the free-text condition.
  if (instructionPositions.length > 0) {
    log("cron", `Management: ${instructionPositions.length} instruction position(s) — invoking LLM [model: ${config.llm.managementModel}]`);
    const actionBlocks = instructionPositions.map((p) => [
      `POSITION: ${p.pair} (${p.position})`,
      `  pool: ${p.pool}`,
      `  NET PnL: ${formatPositionNetPnlValue(p, cur)} (${formatNetPnlPercent(p)}; ${p.net_pnl_status ?? "UNKNOWN"}) | value: ${cur}${p.total_value_usd}`,
      `  capital PnL excl. fees (USD): $${p.capital_pnl_usd ?? "?"} | fee contribution (USD): $${p.fee_contribution_usd ?? "?"} | unclaimed fees: ${cur}${p.unclaimed_fees_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
      `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
      `  instruction: "${p.instruction}"`,
    ].join("\n")).join("\n\n");

    const { content } = await agentLoop(`
INSTRUCTION EVALUATION — ${instructionPositions.length} position(s)

${actionBlocks}

For each position, evaluate the instruction condition against the live data:
- If the condition is MET → call close_position (it claims fees internally; do NOT call claim_fees first).
- If NOT met → HOLD, do nothing.

After evaluating, write a brief one-line result per position.
    `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    if (content) lines.push(content);
  }

  return lines.join("\n");
}

function resetSpotExitConfirmation() {
  _spotExitKey = null;
  _spotExitCount = 0;
}

function confirmSpotExit(positionId, action) {
  if (!positionId || !action || action === "HOLD") {
    resetSpotExitConfirmation();
    return { count: 0, required: 0, fire: false };
  }
  const key = `${positionId}:${action}`;
  if (_spotExitKey === key) _spotExitCount += 1;
  else {
    _spotExitKey = key;
    _spotExitCount = 1;
  }
  const required = action === "STOP_LOSS"
    ? 1
    : Math.max(1, Number(config.spot.exitConfirmTicks ?? 2));
  return { count: _spotExitCount, required, fire: _spotExitCount >= required };
}

async function runSpotManagementCycle({ silent = false } = {}) {
  if (_managementBusy || _claimAllBusy || _screeningBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  let report = null;
  let liveMessage = null;
  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("⚡ Spot Management", "Refreshing finalized balance and price...");
    }
    const snapshot = await getSpotPositionSnapshot();
    if (!snapshot.position) {
      resetSpotExitConfirmation();
      report = "No spot position is open.";
      return report;
    }
    if (snapshot.status !== "open") {
      resetSpotExitConfirmation();
      report = `Spot position ${snapshot.position.symbol || snapshot.position.mint} is ${snapshot.status}; new actions are blocked pending reconciliation.`;
      return report;
    }
    if (!snapshot.priceable) {
      resetSpotExitConfirmation();
      report = `Spot position ${snapshot.position.symbol || snapshot.position.mint} is unpriceable — HOLD (${snapshot.reason}).`;
      return report;
    }

    const exit = snapshot.exit || { action: "HOLD", reason: "No exit signal." };
    const pnlText = Number.isFinite(snapshot.pnl_pct)
      ? `${snapshot.pnl_pct >= 0 ? "+" : ""}${snapshot.pnl_pct.toFixed(2)}%`
      : "N/A";
    if (exit.action === "HOLD") {
      resetSpotExitConfirmation();
      report = `${snapshot.position.symbol || snapshot.position.mint}: HOLD | PnL ${pnlText} | value ${snapshot.current_value_sol.toFixed(6)} SOL.`;
      return report;
    }

    const confirmation = confirmSpotExit(snapshot.position.id, exit.action);
    if (!confirmation.fire) {
      report = `${snapshot.position.symbol || snapshot.position.mint}: ${exit.action} awaiting confirmation ${confirmation.count}/${confirmation.required} | PnL ${pnlText}.`;
      return report;
    }

    log("spot", `${exit.action} confirmed for ${snapshot.position.symbol || snapshot.position.mint}: ${exit.reason}`);
    await liveMessage?.toolStart("close_spot_position");
    const result = await executeTool("close_spot_position", {
      reason: `${exit.action}: ${exit.reason}`,
    }).catch((error) => ({ error: error.message }));
    const success = result?.success !== false && !result?.error && !result?.blocked;
    await liveMessage?.toolFinish("close_spot_position", result, success);
    if (result?.trade_status === "closed") {
      resetSpotExitConfirmation();
      const realized = Number(result.pnl_pct);
      report = `${snapshot.position.symbol || snapshot.position.mint}: CLOSED ${Number.isFinite(realized) ? `${realized >= 0 ? "+" : ""}${realized.toFixed(2)}%` : ""} — ${exit.reason}.`;
    } else if (result?.pending) {
      report = `${snapshot.position.symbol || snapshot.position.mint}: close outcome pending reconciliation — ${result.reason || result.error || "unknown status"}.`;
    } else if (result?.dry_run) {
      resetSpotExitConfirmation();
      report = `${snapshot.position.symbol || snapshot.position.mint}: DRY RUN would close — ${exit.reason}.`;
    } else {
      report = `${snapshot.position.symbol || snapshot.position.mint}: close blocked — ${result?.reason || result?.error || "unknown error"}.`;
    }
  } catch (error) {
    log("cron_error", `Spot management failed: ${error.message}`);
    if (silent) throw error;
    report = `Spot management failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled() && report) {
      if (liveMessage) await liveMessage.finalize(stripThink(report)).catch(() => {});
      else sendMessage(`⚡ Spot Management\n\n${stripThink(report)}`).catch(() => {});
    }
  }
  return report;
}

async function runSpotScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy || _claimAllBusy || _managementBusy) {
    log("cron", "Spot screening skipped — transaction lane is busy");
    return null;
  }
  _screeningBusy = true;
  _screeningLastTriggered = Date.now();
  timers.screeningLastRun = Date.now();
  let report = null;
  let liveMessage = null;
  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔎 Spot Momentum Scan", "Applying deterministic momentum and token-safety gates...");
    }
    const status = getSpotStatus();
    if (status.position) {
      report = `Spot scan skipped — position ${status.position.symbol || status.position.mint} is ${status.position.status}.`;
      return report;
    }
    if (status.risk_budget?.blocked) {
      report = `Spot scan skipped — ${status.risk_budget.reason}.`;
      appendDecision({ type: "spot_no_trade", actor: "SCREENER", summary: "Daily spot risk budget blocked entry", reason: status.risk_budget.reason });
      return report;
    }

    const [legacyPositions, balance] = await Promise.all([
      getMyPositions({ force: true, silent: true }),
      process.env.DRY_RUN === "true"
        ? Promise.resolve(null)
        : getTokenBalanceByMint(SOL_MINT),
    ]);
    if ((legacyPositions?.total_positions ?? legacyPositions?.positions?.length ?? 0) > 0) {
      report = "Spot scan skipped — an LP position is still open; mixed exposure is blocked.";
      return report;
    }
    if (process.env.DRY_RUN !== "true" && Number(balance?.amount) < config.spot.minWalletSol) {
      report = `Spot scan skipped — ${Number(balance?.amount || 0).toFixed(6)} finalized SOL available; ${config.spot.minWalletSol} SOL required.`;
      return report;
    }

    const screened = await getSpotMomentumCandidates({ limit: 10 });
    const candidates = screened?.candidates || [];
    if (candidates.length === 0) {
      const examples = (screened?.filtered_examples || [])
        .slice(0, 3)
        .map((entry) => `- ${sanitizeUntrustedPromptText(entry.name, 80) || '"unknown"'}: ${entry.reason}`)
        .join("\n");
      report = examples
        ? `⛔ NO TRADE\nNo candidate passed every entry gate.\n${examples}`
        : `⛔ NO TRADE\nNo candidate passed every entry gate${screened?.reason ? `: ${screened.reason}` : "."}`;
      appendDecision({
        type: "spot_no_trade",
        actor: "SCREENER",
        summary: "No spot candidate passed deterministic gates",
        reason: examples || screened?.reason || "No qualifying candidate",
      });
      return report;
    }

    const selected = selectSpotEntryCandidate(candidates);
    if (!selected) {
      report = "⛔ NO TRADE\nCandidates lacked a trustworthy executable round-trip quote.";
      appendDecision({
        type: "spot_no_trade",
        actor: "SCREENER",
        summary: "No spot candidate had executable edge",
        reason: stripThink(report).slice(0, 500),
      });
      return report;
    }

    log(
      "spot",
      `Selected ${selected.name || selected.pool} deterministically at expected round-trip cost ${Number(selected.round_trip_quote.expectedLossPct).toFixed(2)}%`,
    );
    await liveMessage?.toolStart("open_spot_position");
    const spotOpenResult = await executeTool("open_spot_position", {
      pool_address: selected.pool,
    }).catch((error) => ({ success: false, error: error.message }));
    const groundedResult = formatConfirmedSpotOpenResult(spotOpenResult, config.spot.tradeAmountSol);
    const openSucceeded = groundedResult.kind === "open_confirmed" || groundedResult.kind === "open_dry_run";
    const openUncertain = groundedResult.kind === "open_uncertain";
    await liveMessage?.toolFinish("open_spot_position", spotOpenResult, openSucceeded);
    report = groundedResult.text;
    if (!openSucceeded && !openUncertain) {
      appendDecision({
        type: "spot_no_trade",
        actor: "SCREENER",
        summary: "Spot entry attempt did not pass fresh preflight",
        reason: stripThink(report).slice(0, 500),
      });
    }
  } catch (error) {
    log("cron_error", `Spot screening failed: ${error.message}`);
    report = `Spot screening failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled() && report) {
      if (liveMessage) await liveMessage.finalize(stripThink(report)).catch(() => {});
      else sendMessage(`🔎 Spot Momentum Scan\n\n${stripThink(report)}`).catch(() => {});
    }
  }
  return report;
}

async function runHybridScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy || _managementBusy || _claimAllBusy) return null;
  _screeningBusy = true;
  _screeningLastTriggered = Date.now();
  timers.screeningLastRun = Date.now();
  let report;
  try {
    const shared = getHybridRiskStatus();
    if (shared.entry_pending) return report = "Hybrid scan blocked — previous entry requires reconciliation; no timed unlock.";
    if (shared.ledger?.date === new Date().toISOString().slice(0, 10)
      && Number(shared.ledger.lossSol) >= config.hybrid.maxDailyLossSol) {
      return report = "Hybrid scan blocked — shared daily loss cap reached.";
    }
    if (readSpotPosition() || getTrackedPositions(true).length) return "Hybrid scan skipped — one active or unresolved position already exists.";
    const positions = await getMyPositions({ force: true, silent: true });
    if (!positions || !Array.isArray(positions.positions) || positions.total_positions !== 0 || positions.positions.length !== 0) {
      return "Hybrid scan skipped — LP exposure is present or cannot be verified.";
    }
    const budget = getSpotStatus().risk_budget;
    if (budget?.blocked) return `Hybrid scan skipped — ${budget.reason}`;
    const wallet = await getTokenBalanceByMint(SOL_MINT);
    const circuit = evaluateLossCircuitBreaker({ performance: getAllPerformanceRecords(), policy: config.risk });
    if (!circuit.pass) return `Hybrid scan skipped — ${circuit.reason}`;
    const sizing = getCircuitAdjustedDeploySizing(wallet.amount, circuit);
    const spotFunded = wallet.amount >= config.spot.tradeAmountSol + config.hybrid.reserveSol + config.hybrid.spotCostBufferSol;
    if (!spotFunded && !sizing.funded) return "Hybrid scan skipped — reserve plus entry-cost buffer is not funded.";
    const screened = await scanHybridCandidates({
      scanSpot: () => spotFunded ? getSpotMomentumCandidates({ limit: 5 }) : Promise.resolve({ candidates: [], reason: "Spot capital plus reserve/cost buffer is not funded" }),
      scanLp: () => sizing.funded
        ? hybridLpCache.get("lp-candidates", () => getTopCandidates({ limit: 3 }), { ttlMs: 30000, rateLimitKey: "lp-screener" })
        : Promise.resolve({ candidates: [], reason: "LP reserve/rent buffer is not funded" }),
    });
    const selection = screened.selected;
    if (!selection) {
      const describe = (result) => result?.error || result?.reason
        || result?.source_errors?.map((e) => e.reason).join("; ")
        || result?.filtered_examples?.slice(0, 2).map((e) => e.reason).join("; ") || "no eligible candidates";
      report = `NO TRADE\nSpot: ${describe(screened.spot)}\nLP: ${describe(screened.lp)}`;
      appendDecision({ type: "hybrid_no_trade", actor: "SCREENER", summary: "Neither strategy qualified", reason: report });
      return report;
    }
    const candidate = selection.candidate;
    if (selection.strategy === "spot") {
      const result = await executeTool("open_spot_position", { pool_address: candidate.pool });
      report = formatConfirmedSpotOpenResult(result, config.spot.tradeAmountSol).text;
    } else {
      const result = await executeTool("deploy_position", {
        pool_address: candidate.pool, amount_y: sizing.amount, amount_x: 0,
        strategy: config.strategy.strategy, bins_below: computeBinsBelow(candidate.volatility), bins_above: 0,
        pool_name: candidate.name, bin_step: candidate.bin_step, volatility: candidate.volatility,
      });
      report = result?.dry_run ? "DRY RUN — hybrid LP candidate passed; no transaction sent."
        : result?.success === true && result?.position ? `LP entry confirmed: ${result.position} (${sizing.amount} SOL).`
        : `LP entry not confirmed: ${result?.reason || result?.error || "unresolved result"}`;
    }
    appendDecision({ type: "hybrid_selection", actor: "SCREENER", pool: candidate.pool,
      summary: `${selection.strategy} selected after independent screening`, reason: report });
    return report;
  } catch (error) {
    report = `Hybrid scan blocked: ${error.message}`;
    log("hybrid_error", report);
    return report;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled() && report) sendMessage(report).catch(() => {});
  }
}

export async function runManagementCycle({ silent = false } = {}) {
  if (isSpotEnabled() && readSpotPosition()) return runSpotManagementCycle({ silent });
  if (config.trading.mode === "spot_momentum") return runSpotManagementCycle({ silent });
  if (_managementBusy || _claimAllBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const settlement = await drainPendingAutoSwaps();
    if (settlement.pending > 0) {
      const pendingMessage = `⚠️ ${settlement.pending} close settlement(s) remain pending. New deployments are blocked until the base tokens are confirmed as SOL.`;
      log("cron", pendingMessage);
      mgmtReport = pendingMessage;
      await liveMessage?.note(pendingMessage);
      return mgmtReport;
    }
    if (settlement.processed > 0) {
      await liveMessage?.note(`Settled ${settlement.settled}/${settlement.processed} pending base→SOL conversion(s).`);
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS exit checks. Management is the slow cron backstop: raise peak immediately
    // (confirmTicks=1) and act on detected exits directly. Real-time 2-tick
    // confirmation lives in the fast 3s poller below.
    const exitMap = new Map();
    for (const p of positionData) {
      confirmPeak(p.position, p.pnl_pct, 1);
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        exitMap.set(p.position, exit);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        const exit = exitMap.get(p.position);
        actionMap.set(p.position, {
          action: "CLOSE",
          rule: "exit",
          reason: exit.reason,
          exitAction: exit.action,
        });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const closeRule = getDeterministicCloseRule(p, config.management);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${p.total_value_usd ?? "?"}` : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = config.management.solMode ? `◎${p.unclaimed_fees_usd ?? "?"}` : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | Net PnL: ${formatNetPnlPercent(p)} (${p.net_pnl_status ?? "UNKNOWN"}) | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") {
        const exitLabel = act.exitAction === "STOP_LOSS" ? "Stop loss" : "Trailing TP";
        line += `\n⚡ ${exitLabel}: ${act.reason}`;
      }
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      const execReport = await executeManagementActions(actionPositions, actionMap, { liveMessage, cur });
      if (execReport) mgmtReport += `\n\n${execReport}`;
    } else {
      log("cron", "Management: all positions STAY — skipping");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => { });
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (config.trading.mode === "hybrid") return runHybridScreeningCycle({ silent });
  if (config.trading.mode === "spot_momentum") return runSpotScreeningCycle({ silent });
  if (_screeningBusy || _claimAllBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  let performanceHistory;
  try {
    performanceHistory = getAllPerformanceRecords();
  } catch (error) {
    const reason = `Cannot verify realized-loss circuit breaker: ${error.message}`;
    log("risk", `Screening skipped — ${reason}`);
    appendDecision({
      type: "skip",
      actor: "SCREENER",
      summary: "Screening paused because risk history is unreadable",
      reason,
    });
    _screeningBusy = false;
    return `Screening skipped — ${reason}`;
  }
  const lossCircuit = evaluateLossCircuitBreaker({
    performance: performanceHistory,
    policy: config.risk,
  });
  const riskIntelligenceBrief = buildRiskIntelligenceBrief({
    performance: performanceHistory,
    policy: config.risk,
    maxVolatility: config.screening.maxVolatility,
  });
  if (!lossCircuit.pass) {
    const reason = `Realized-loss circuit breaker: ${lossCircuit.reason}`;
    log("risk", `Screening skipped — ${reason}`);
    appendDecision({
      type: "skip",
      actor: "SCREENER",
      summary: "Screening paused by loss circuit breaker",
      reason,
    });
    _screeningBusy = false;
    return `Screening skipped — ${reason}`;
  }

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance, preDeploySizing;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
    preDeploySizing = getCircuitAdjustedDeploySizing(preBalance.sol, lossCircuit);
    if (preDeploySizing.recoveryMode) {
      log(
        "risk",
        `Recovery sizing active — deploy capped at ${formatSolAmount(preDeploySizing.amount)} SOL (${(preDeploySizing.recoverySizePct * 100).toFixed(0)}% of normal ${formatSolAmount(preDeploySizing.normalAmount)} SOL).`,
      );
    }
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && !preDeploySizing.funded) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} leaves less than 0.01 SOL after ${preDeploySizing.reserve} gas reserve)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} leaves less than 0.01 SOL after ${preDeploySizing.reserve} gas reserve).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL after ${preDeploySizing.reserve} gas reserve`,
      });
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = preDeploySizing.amount;
    log("cron", `Computed deploy amount: ${formatSolAmount(deployAmount)} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const deployStrategy = config.strategy.strategy;
    const strategyBlock = `DEPLOY STRATEGY: ${deployStrategy} (from config) | bins_above: 0 (FIXED — never change) | deposit: SOL only (amount_y, amount_x=0)`
      + (activeStrategy ? `\nSTRATEGY CONTEXT: ${activeStrategy.name} — entry: ${activeStrategy.entry?.condition || "n/a"} | exit: ${activeStrategy.exit?.notes || "n/a"} | best for: ${activeStrategy.best_for}` : "");

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Hard token-audit filters after recon. Missing audit data fails closed, and
    // the LLM never gets to override global-fee or holder-concentration limits.
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      const auditRisk = evaluateTokenAuditRisk(ti, config.screening, {
        expectedMint: pool.base?.mint ?? null,
      });
      if (!auditRisk.pass) {
        log("screening", `Token-audit filter: dropped ${pool.name} — ${auditRisk.reason}`);
        filteredOut.push({ name: pool.name, reason: auditRisk.reason });
        return false;
      }
      return true;
    });

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 3)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      screenReport = combinedExamples
        ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
        : `No candidates available (all filtered by deterministic risk and token-audit rules).`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    if (passing.length === 1) {
      const skipReason = getLoneCandidateSkipReason(passing[0]);
      if (skipReason) {
        const candidateName = passing[0].pool?.name || "unknown";
        screenReport = [
          "⛔ NO DEPLOY",
          "",
          "Cycle finished with no valid entry.",
          "",
          "BEST LOOKING CANDIDATE",
          candidateName,
          "",
          "WHY SKIPPED",
          `Only one candidate survived filtering, but it was not worth deploying: ${skipReason}.`,
          "",
          "REJECTED",
          `- ${candidateName}: ${skipReason}`,
        ].join("\n");
        appendDecision({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Single candidate skipped",
          reason: skipReason,
          pool: passing[0].pool?.pool,
          pool_name: candidateName,
        });
        return screenReport;
      }
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Build compact candidate blocks
    const candidateBlocks = passing.map(({ pool, sw, n, ti, mem }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;
      const momentum = pool.indicator_confirmation;
      const momentumIntervals = Array.isArray(momentum?.intervals)
        ? momentum.intervals
          .filter((entry) => entry?.ok)
          .map((entry) => {
            const signal = entry.signal || {};
            const direction = signal.supertrendDirection || "unknown";
            const candleMove = Number.isFinite(signal.close) && Number.isFinite(signal.previousClose)
              ? (signal.close > signal.previousClose ? "rising" : "not-rising")
              : "unknown";
            return `${entry.interval}:${direction},RSI=${signal.rsi ?? "?"},${candleMove}`;
          })
          .join(" | ")
        : "";

      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;

      const block = [
        `POOL: ${pool.name} (${pool.pool})`,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
        pvpLine,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
        momentum?.confirmed
          ? `  momentum: CONFIRMED${momentumIntervals ? ` — ${momentumIntervals}` : ""}`
          : null,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
        mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
      ].filter(Boolean).join("\n");

      // Stage signals for Darwinian weighting — captured before LLM decides
      if (config.darwin?.enabled) {
        const baseMint = pool.base?.mint || pool.base_mint || ti?.mint || null;
        stageSignals(pool.pool, {
          base_mint:             baseMint,
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
        });
      }

      return block;
    });

    const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;

    let deployAttempted = false;
    let deploySucceeded = false;
    const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

${riskIntelligenceBrief}

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Decide if any candidate is actually worth deploying. One surviving candidate is not automatically good enough.
2. Pick the best candidate based on realized risk context, confirmed 5m+15m momentum, narrative quality, smart wallets, and pool metrics. Prefer positive expectancy over headline win rate and avoid profiles resembling the high-volatility loss tail. Do not chase an overbought or non-rising candle; the backend will re-fetch and reject stale or incomplete momentum.
3. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   bins_below = round(${config.strategy.minBinsBelow} + (candidate volatility/5)*(${config.strategy.maxBinsBelow - config.strategy.minBinsBelow})) clamped to [${config.strategy.minBinsBelow},${config.strategy.maxBinsBelow}].
   pass deploy_position.volatility = the candidate volatility value.
   For single-side SOL deploys, do not invent upside:
   set amount_y only, keep amount_x = 0, keep bins_above = 0, and let the upper bin stay at the active bin.
4. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Range cover: <downside %> downside | <upside %> upside | <total width %> total

   IMPORTANT:
   - Do NOT calculate the range percentages yourself.
   - Use the actual deploy_position tool result:
     range_coverage.downside_pct
     range_coverage.upside_pct
     range_coverage.width_pct

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
5. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Keep the whole report compact and highly scannable for Telegram.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => {
          if (name === "deploy_position") deployAttempted = true;
          await liveMessage?.toolStart(name);
        },
        onToolFinish: async ({ name, result, success }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
          }
          await liveMessage?.toolFinish(name, result, success);
        },
      });
    screenReport = content;
    if (/⛔\s*NO DEPLOY/i.test(content)) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
      });
    } else if (!deploySucceeded) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: deployAttempted ? "Deploy attempt did not succeed" : "No successful deploy in screening cycle",
        reason: stripThink(content).slice(0, 500),
      });
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        else sendMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => { });
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy || _claimAllBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy || _claimAllBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Settlement is independent from open-position management. Retry every minute
  // so a process restart or transient Jupiter/RPC failure cannot strand the
  // base token until the next (potentially much slower) management cycle.
  const settlementTask = cron.schedule(`* * * * *`, async () => {
    if (_claimAllBusy) return;
    try {
      const settlement = await drainPendingAutoSwaps();
      if (settlement.processed > 0) {
        log("cron", `Settlement retry: ${settlement.settled}/${settlement.processed} resolved, ${settlement.pending} still pending`);
      }
    } catch (error) {
      log("cron_error", `Settlement retry failed: ${error.message}`);
    }
  });

  // Fast PnL poller — the real-time exit path between management cycles, no LLM.
  // Runs on public infra (RPC + Jupiter + Meteora deposits) so it can poll aggressively.
  // Exits require `confirmTicks` consecutive confirming polls (registerExitSignal) so a
  // single noisy tick can't close a position; confirmed exits close DIRECTLY here (no
  // management-interval cooldown gate that used to swallow rule hits).
  const pnlPollMs = Math.max(1, Number(config.pnl.pollIntervalSec ?? 3)) * 1000;
  const confirmTicks = Math.max(1, Number(config.pnl.confirmTicks ?? 2));
  let _pnlPollBusy = false;
  let pnlPollInterval = null;
  if (isLpEnabled()) pnlPollInterval = setInterval(async () => {
    const pollGate = getPnlWatchdogGate({
      pnlPollBusy: _pnlPollBusy,
      managementBusy: _managementBusy,
      screeningBusy: _screeningBusy,
      claimAllBusy: _claimAllBusy,
    });
    if (!pollGate.shouldPoll) return;
    if (getTrackedPositions(true).length === 0) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        confirmPeak(p.position, p.pnl_pct, confirmTicks);

        // Detect an exit signal this tick (rule-based exits, then deterministic close rules).
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        const closeRule = exit ? null : getDeterministicCloseRule(p, config.management);
        let signal = null, reason = null, rule = "exit", exitAction = null;
        if (exit) {
          signal = exit.action;
          reason = exit.reason;
          exitAction = exit.action;
        } else if (closeRule) {
          signal = closeRule.exitAction ?? `RULE_${closeRule.rule}`;
          reason = closeRule.reason;
          rule = closeRule.rule;
          exitAction = closeRule.exitAction ?? signal;
        }

        // Require N consecutive confirming ticks before acting.
        const requiredConfirmTicks = selectExitConfirmationTicks({
          exitAction,
          defaultConfirmTicks: confirmTicks,
          stopLossConfirmTicks: config.management.stopLossConfirmTicks,
        });
        const { fire } = registerExitSignal(p.position, signal, requiredConfirmTicks);
        if (!signal || !fire) continue;

        // Keep sampling during a slow workflow, but never submit a close that
        // races its transaction. The next 3s tick retries as soon as the lane
        // is free; a stop loss needs only one confirming tick.
        const executionGate = getPnlWatchdogGate({
          managementBusy: _managementBusy,
          screeningBusy: _screeningBusy,
          claimAllBusy: _claimAllBusy,
        });
        if (!executionGate.canExecuteExit) {
          if (signal === "STOP_LOSS") {
            log("state", `[PnL poll] STOP_LOSS for ${p.pair} deferred while ${executionGate.executionBlocker} owns the transaction lane`);
          }
          continue;
        }

        const nextStep = signal === "TRAILING_TP" || signal === "STOP_LOSS"
          ? "revalidating fresh PnL before close"
          : "closing directly";
        log("state", `[PnL poll] ${signal} confirmed (${requiredConfirmTicks} ticks): ${p.pair} — ${reason} — ${nextStep}`);
        // Hold the management lock so the cron cycle can't double-act on this position.
        _managementBusy = true;
        try {
          const actMap = new Map([[p.position, {
            action: "CLOSE",
            rule,
            reason,
            exitAction,
          }]]);
          const rpt = await executeManagementActions([p], actMap, {});
          log("state", `[PnL poll] ${p.pair}: ${rpt || "closed"}`);
        } catch (e) {
          log("cron_error", `Poll-triggered close failed: ${e.message}`);
        } finally {
          _managementBusy = false;
        }
        break; // one action per tick
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, pnlPollMs);

  // Opportunity poller — catches strong pools between the (slow) screening cycles.
  // Reuses the getTopCandidates pipeline (discovery + holder audit + filters + score);
  // when the best candidate clears the score pre-gate it triggers the existing screening
  // deploy decision (runScreeningCycle), which re-checks guards and forces the deploy LLM.
  let opportunityPollInterval = null;
  if (config.trading.mode === "dlmm_lp" && config.opportunity.enabled) {
    const oppMs = Math.max(15, Number(config.opportunity.pollIntervalSec ?? 45)) * 1000;
    const decisionMinIntervalMs = Math.max(
      15,
      Number(config.opportunity.decisionMinIntervalSec ?? 90),
    ) * 1000;
    let _opportunityPollBusy = false;
    opportunityPollInterval = setInterval(async () => {
      if (_screeningBusy || _managementBusy || _claimAllBusy || _opportunityPollBusy) return;
      if (Date.now() - _screeningLastTriggered < decisionMinIntervalMs) return;
      _opportunityPollBusy = true;
      try {
        const [positions, balance] = await Promise.all([
          getMyPositions({ force: true, silent: true }).catch(() => null),
          getWalletBalances().catch(() => null),
        ]);
        if (!positions || (positions.total_positions ?? 0) >= config.risk.maxPositions) return;
        const sizing = balance ? getAutoDeploySizing(balance.sol) : null;
        if (process.env.DRY_RUN !== "true" && (!sizing || !sizing.funded)) return;

        const top = await getTopCandidates({ limit: config.opportunity.limit }).catch(() => null);
        const candidates = (top?.candidates || []).slice().sort((a, b) => degenScore(b, config.opportunity) - degenScore(a, config.opportunity));
        if (!candidates.length) return;

        const minScore = config.opportunity.minScore;
        const bonus = Number(config.opportunity.smartWalletScoreBonus ?? 0);
        const floor = minScore - bonus; // lowest degen that could qualify, only WITH a smart wallet

        // A pool qualifies if degen >= minScore, OR it's borderline (floor..minScore) AND a
        // tracked smart wallet sits on it (checkSmartWalletsOnPool, on-chain positions of our
        // tracked KOL list). The smart-wallet lookup runs only for borderline pools to keep
        // the 45s poll cheap.
        let trigger = null;
        for (const c of candidates) {
          const s = degenScore(c, config.opportunity);
          if (s < floor) break; // sorted desc — nothing below can qualify either
          if (s >= minScore) { trigger = { c, s, smart: [] }; break; }
          if (bonus <= 0) continue; // borderline but smart-wallet rescue disabled
          const smart = (await checkSmartWalletsOnPool({ pool_address: c.pool }).catch(() => null))?.in_pool || [];
          if (smart.length > 0) { trigger = { c, s, smart }; break; }
        }
        if (!trigger) return;

        const smartTag = trigger.smart.length
          ? ` + smart wallet [${trigger.smart.map((w) => w.name || w.address?.slice(0, 4)).join(", ")}] (bar lowered ${minScore}→${floor})`
          : "";
        log("cron", `[Opportunity] ${trigger.c.name} degen ${trigger.s.toFixed(1)} >= ${trigger.smart.length ? floor : minScore}${smartTag} — triggering screening deploy decision`);
        runScreeningCycle({ silent: true }).catch((e) => log("cron_error", `Opportunity-triggered screening failed: ${e.message}`));
      } catch (e) {
        log("cron_error", `Opportunity poll failed: ${e.message}`);
      } finally {
        _opportunityPollBusy = false;
      }
    }, oppMs);
  }

  let spotManagementPollInterval = null;
  let spotScanInterval = null;
  if (isSpotEnabled()) {
    const managementMs = Math.max(1, Number(config.spot.managementPollIntervalSec ?? 1)) * 1000;
    const scanMs = Math.max(5, Number(config.spot.scanIntervalSec ?? 30)) * 1000;
    if (config.spot.realtimeEnabled) {
      _spotRealtimeMonitor = createSpotRealtimeMonitor({
        getPosition: readSpotPosition,
        onRefresh: () => runSpotManagementCycle({ silent: true }),
        commitment: config.spot.realtimeCommitment,
        eventDebounceMs: config.spot.realtimeEventDebounceMs,
        minRefreshMs: config.spot.realtimeMinRefreshMs,
        fallbackIntervalMs: managementMs,
      });
      _spotRealtimeMonitor.start().catch((error) => log("spot_realtime_error", `Start failed: ${error.message}`));
    } else {
      spotManagementPollInterval = setInterval(() => {
        runSpotManagementCycle({ silent: true }).catch((error) => log("cron_error", `Spot poll failed: ${error.message}`));
      }, managementMs);
      runSpotManagementCycle({ silent: true }).catch((error) => log("cron_error", `Initial spot status failed: ${error.message}`));
    }
    spotScanInterval = setInterval(() => {
      runScreeningCycle({ silent: true }).catch((error) => log("cron_error", `Spot scan failed: ${error.message}`));
    }, scanMs);
  }

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog, settlementTask];
  // Store interval refs so stopCronJobs can clear them
  _cronTasks._pnlPollInterval = pnlPollInterval;
  _cronTasks._opportunityPollInterval = opportunityPollInterval;
  _cronTasks._spotManagementPollInterval = spotManagementPollInterval;
  _cronTasks._spotScanInterval = spotScanInterval;
  drainPendingAutoSwaps().catch((error) => log("cron_error", `Startup settlement retry failed: ${error.message}`));
  const strategySchedule = isSpotEnabled()
    ? `${config.spot.realtimeEnabled ? `spot management via ${config.spot.realtimeCommitment} WebSocket with ${config.spot.managementPollIntervalSec}s fallback` : `spot management every ${config.spot.managementPollIntervalSec}s`}, momentum scan every ${config.spot.scanIntervalSec}s`
    : `management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m${config.opportunity.enabled ? `, opportunity poll every ${config.opportunity.pollIntervalSec}s` : ""}`;
  log("cron", `Cycles started — ${strategySchedule}, settlement retry every 1m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
let _shuttingDown = false;

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function shutdown(signal) {
  if (_shuttingDown) {
    log("shutdown", `Received ${signal} while shutdown is already in progress.`);
    return;
  }
  _shuttingDown = true;

  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  stopCronJobs();

  const positions = await withTimeout(
    getMyPositions({ force: true, silent: true }).catch((error) => {
      log("shutdown", `Position snapshot failed during shutdown: ${error.message}`);
      return null;
    }),
    5000
  );
  if (positions) {
    log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  } else {
    log("shutdown", "Open position snapshot skipped during shutdown timeout");
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    // Couldn't-price-this-tick flag (e.g. Jupiter outage) — never act on PnL rules.
    if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  const stopLossTriggerPct = managementConfig.stopLossTriggerPct ?? managementConfig.stopLossPct;
  if (!pnlSuspect && position.pnl_pct != null && stopLossTriggerPct != null && position.pnl_pct <= stopLossTriggerPct) {
    return {
      action: "CLOSE",
      rule: 1,
      exitAction: "STOP_LOSS",
      reason: `stop loss: PnL ${position.pnl_pct.toFixed(2)}% <= trigger ${stopLossTriggerPct}% (target max ${managementConfig.stopLossPct}%)`,
    };
  }
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;
let _latestCandidates = [];
let _latestCandidatesAt = null;

function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) return "No cached candidates yet. Run /screen first.";
  const lines = _latestCandidates.slice(0, limit).map((pool, i) => {
    if (pool.trading_strategy === "spot") {
      return `${i + 1}. [SPOT/${pool.venue || "cross-DEX"}] ${sanitizeUntrustedPromptText(pool.name, 80)} | expected round-trip cost ${Number(pool.round_trip_quote?.expectedLossPct).toFixed(2)}% | score ${pool.spot_score}`;
    }
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. [LP/Meteora] ${sanitizeUntrustedPromptText(pool.name, 80)} | fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age = _latestCandidatesAt ? new Date(_latestCandidatesAt).toLocaleString("en-US", { hour12: false }) : "unknown";
  return `Latest candidates (${_latestCandidates.length}) — updated ${age}\n\n${lines.join("\n")}`;
}

function formatWalletStatus(wallet, positions) {
  const deployAmount = computeDeployAmount(wallet.sol);
  const hive = isHiveMindEnabled() ? "on" : "off";
  return [
    `Wallet: ${wallet.sol} SOL ($${wallet.sol_usd})`,
    `SOL price: $${wallet.sol_price}`,
    `Open LP positions: ${positions.total_positions}/${config.risk.maxPositions} | spot: ${readSpotPosition()?.status || "none"}`,
    `Next deploy amount: ${formatSolAmount(deployAmount)} SOL`,
    `Dry run: ${process.env.DRY_RUN === "true" ? "yes" : "no"}`,
    `Mainnet execution: ${process.env.DRY_RUN !== "true" && process.env.LIVE_TRADING_ENABLED === "true" ? "enabled" : "locked"}`,
    `HiveMind: ${hive}`,
  ].join("\n");
}

function formatConfigSnapshot() {
  const lossCooldowns = [
    config.risk.lossCircuitStreakCooldownHours,
    config.risk.lossCircuitRollingCooldownHours,
    config.risk.lossCircuitSingleCooldownHours,
  ];
  const lossResponse = !config.risk.lossCircuitBreakerEnabled
    ? "off"
    : lossCooldowns.every((hours) => Number(hours) === 0)
      ? "immediate quality-gated re-entry, no timed pause"
      : `timed pause ${lossCooldowns.join("/")}h`;
  return [
    "Config snapshot",
    "",
    `Trading mode: ${config.trading.mode} | spot discovery: cross-DEX SOL pairs | LP execution: Meteora DLMM`,
    ...(config.trading.mode === "hybrid" ? [`Shared max capital: ${config.hybrid.maxPositionSol} SOL | reserve: ${config.hybrid.reserveSol} SOL | max one combined position`,
      `Cost buffers: spot ${config.hybrid.spotCostBufferSol} SOL; LP ${config.hybrid.lpCostBufferSol} SOL (rent included)`] : []),
    `Strategy: ${config.strategy.strategy} | binsBelow: ${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow} | default ${config.strategy.defaultBinsBelow}`,
    `Deploy target: ${config.management.deployAmountSol} SOL | max: ${config.risk.maxDeployAmount ?? "uncapped"} SOL | gasReserve: ${config.management.gasReserve} | maxPositions: ${config.risk.maxPositions}`,
    `Stop loss: trigger ${config.management.stopLossTriggerPct}% → target max ${config.management.stopLossPct}% | confirmation ${config.management.stopLossConfirmTicks} tick | re-entry cooldown ${config.management.stopLossCooldownHours}h`,
    `Take profit: ${config.management.takeProfitPct}%`,
    `Trailing: ${config.management.trailingTakeProfit ? "on" : "off"} | trigger ${config.management.trailingTriggerPct}% | drop ${config.management.trailingDropPct}%`,
    `OOR: ${config.management.outOfRangeWaitMinutes}m | cooldown ${config.management.oorCooldownTriggerCount}x / ${config.management.oorCooldownHours}h`,
    `Repeat deploy cooldown: ${config.management.repeatDeployCooldownEnabled ? "on" : "off"} | ${config.management.repeatDeployCooldownTriggerCount}x / ${config.management.repeatDeployCooldownHours}h | min fee earned ${config.management.repeatDeployCooldownMinFeeEarnedPct}% | ${config.management.repeatDeployCooldownScope}`,
    `Yield floor: ${config.management.minFeePerTvl24h}% | min age ${config.management.minAgeBeforeYieldCheck}m`,
    `Screening: ${config.screening.category} / ${config.screening.timeframe} | TVL ${config.screening.minTvl}-${config.screening.maxTvl} | max volatility ${config.screening.maxVolatility}`,
    `Entry quality: organic ≥ ${config.screening.minOrganic} | fee/active-TVL ≥ ${config.screening.minFeeActiveTvlRatio}% | volume/active-TVL ≥ ${config.screening.minVolumeActiveTvlRatio}`,
    `Token audit: ${config.screening.requireTokenAudit ? "required" : "optional"} | fees ≥ ${config.screening.minTokenFeesSol} SOL | top10 ≤ ${config.screening.maxTop10Pct}% | bots ≤ ${config.screening.maxBotHoldersPct}%`,
    `Loss response: ${lossResponse} | ${config.risk.maxConsecutiveLosses} losses / rolling ${config.risk.maxRollingLossPct}% / single ${config.risk.maxSingleLossPct}% | recovery size ${(config.risk.lossCircuitRecoverySizePct * 100).toFixed(0)}%`,
    `Momentum: ${config.indicators.enabled ? "required" : "off"} | ${config.indicators.entryPreset} | ${config.indicators.intervals.join("+")} | RSI ${config.indicators.entryRsiMin}-${config.indicators.entryRsiMax} | fail closed ${config.indicators.entryFailClosed ? "on" : "off"}`,
    `Intervals: manage ${config.schedule.managementIntervalMin}m | screen ${config.schedule.screeningIntervalMin}m | opportunity ${config.opportunity.pollIntervalSec}s / decision ${config.opportunity.decisionMinIntervalSec}s`,
    `HiveMind: ${isHiveMindEnabled() ? "enabled" : "disabled"}${config.hiveMind.agentId ? ` | ${config.hiveMind.agentId}` : ""}`,
  ].join("\n");
}

function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    defaultBinsBelow: config.strategy.defaultBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    lossCircuitStreakCooldownHours: config.risk.lossCircuitStreakCooldownHours,
    lossCircuitRollingCooldownHours: config.risk.lossCircuitRollingCooldownHours,
    lossCircuitSingleCooldownHours: config.risk.lossCircuitSingleCooldownHours,
    lossCircuitRecoverySizePct: config.risk.lossCircuitRecoverySizePct,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    stopLossTriggerPct: config.management.stopLossTriggerPct,
    stopLossConfirmTicks: config.management.stopLossConfirmTicks,
    stopLossCooldownHours: config.management.stopLossCooldownHours,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
    entryFailClosed: config.indicators.entryFailClosed,
    entryRsiMin: config.indicators.entryRsiMin,
    entryRsiMax: config.indicators.entryRsiMax,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key, label, step, { digits = 2 } = {}) {
  const value = Number(settingValue(key));
  const shown = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function renderSettingsMenu(page = "main") {
  const title = page === "main" ? "Settings menu" : `Settings: ${page}`;
  const summary = [
    title,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Relay: ${config.api.lpAgentRelayEnabled ? "on" : "off"}`,
    `Strategy: ${config.strategy.strategy} | bins ${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow} | deploy ${config.management.deployAmountSol} SOL`,
    `TP/SL: ${config.management.takeProfitPct}% / trigger ${config.management.stopLossTriggerPct}% → max ${config.management.stopLossPct}% | cooldown ${config.management.stopLossCooldownHours}h | trailing ${config.management.trailingTakeProfit ? "on" : "off"}`,
    `Indicators: ${config.indicators.enabled ? "on" : "off"} | entry ${config.indicators.entryPreset} | ${fmtSettingValue(config.indicators.intervals)}`,
  ].join("\n");

  const nav = [
    [
      settingButton("Main", "cfg:page:main"),
      settingButton("Risk", "cfg:page:risk"),
      settingButton("Screen", "cfg:page:screen"),
      settingButton("Indicators", "cfg:page:indicators"),
    ],
  ];

  const footer = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Close", "cfg:close"),
    ],
  ];

  let rows;
  if (page === "risk") {
    rows = [
      stepButtons("deployAmountSol", "Deploy", 0.1),
      stepButtons("gasReserve", "Gas", 0.05),
      stepButtons("maxPositions", "Max pos", 1, { digits: 0 }),
      stepButtons("maxDeployAmount", "Max SOL", 0.05, { digits: 2 }),
      stepButtons("takeProfitPct", "TP %", 1, { digits: 0 }),
      stepButtons("stopLossTriggerPct", "SL trigger", 1, { digits: 0 }),
      stepButtons("stopLossPct", "SL max", 1, { digits: 0 }),
      stepButtons("stopLossCooldownHours", "SL cooldown hrs", 1, { digits: 0 }),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      stepButtons("trailingTriggerPct", "Trail trigger", 0.5, { digits: 1 }),
      stepButtons("trailingDropPct", "Trail drop", 0.5, { digits: 1 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      stepButtons("repeatDeployCooldownTriggerCount", "Repeat count", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownHours", "Repeat hrs", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownMinFeeEarnedPct", "Fee earned %", 0.1, { digits: 1 }),
    ];
  } else if (page === "screen") {
    rows = [
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP hard block")],
      [
        settingButton(`Strategy: spot`, "cfg:set:strategy:spot"),
        settingButton(`Strategy: bid_ask`, "cfg:set:strategy:bid_ask"),
      ],
      stepButtons("minBinsBelow", "Min bins", 1, { digits: 0 }),
      stepButtons("maxBinsBelow", "Max bins", 1, { digits: 0 }),
      stepButtons("defaultBinsBelow", "Default bins", 1, { digits: 0 }),
      stepButtons("managementIntervalMin", "Manage min", 1, { digits: 0 }),
      stepButtons("screeningIntervalMin", "Screen min", 5, { digits: 0 }),
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [toggleButton("entryFailClosed", "Entry fail closed")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: Momentum", "cfg:set:indicatorEntryPreset:momentum_quality"),
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      stepButtons("rsiLength", "RSI len", 1, { digits: 0 }),
      stepButtons("entryRsiMin", "Entry RSI min", 1, { digits: 0 }),
      stepButtons("entryRsiMax", "Entry RSI max", 1, { digits: 0 }),
    ];
  } else {
    rows = [
      [toggleButton("solMode", "SOL mode"), toggleButton("lpAgentRelayEnabled", "LPAgent relay")],
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Indicators", "cfg:page:indicators"),
        settingButton("Show config", "cfg:show"),
      ],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}

async function showSettingsMenu({ messageId = null, page = "main" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  let page = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid setting");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
    if (key === "stopLossCooldownHours") value = Math.max(0, Math.round(value));
    if (["minBinsBelow", "maxBinsBelow", "defaultBinsBelow"].includes(key)) value = Math.max(35, Math.round(value));
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Unknown action");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, "Config update failed");
    return;
  }
  page = key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals" || key === "entryFailClosed" || key.startsWith("entryRsi")
    ? "indicators"
    : ["useDiscordSignals", "blockPvpSymbols", "strategy", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow", "managementIntervalMin", "screeningIntervalMin"].includes(key)
      ? "screen"
      : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}

function formatHelpText() {
  return [
    "Telegram commands",
    "",
    "/help — show commands",
    "/status — wallet + positions snapshot",
    "/wallet — wallet, deploy amount, HiveMind status",
    "/positions — list open positions",
    "/pool <n> — detailed info for one open position",
    "/close <n> — close one position by index",
    "/close spot — close the tracked spot position",
    "/closeall — close all open positions",
    "/claimall — preview all reported unclaimed fees",
    "/claimall confirm — claim every eligible position",
    "/set <n> <note> — set note/instruction on position",
    "/config — show important runtime config",
    "/settings — button menu for common config",
    "/setcfg <key> <value> — update persisted config",
    "/screen — refresh deterministic candidate list",
    "/candidates — show latest cached candidates",
    "/deploy <n> — deploy candidate by cached index",
    "/briefing — morning briefing",
    "/hive — HiveMind sync status",
    "/hive pull — manual HiveMind pull now",
    "/confirm — confirm one pending spot entry",
    "/cancel — cancel a pending spot entry",
    "/pause — stop cron cycles",
    "/resume — start cron cycles again",
    "/stop — shut down agent",
  ].join("\n");
}

async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol} | organic ${pool.organic_score ?? "?"}`;
    });
    return `Top candidates (${candidates.length})\n\n${lines.join("\n")}`;
  }
  const examples = (top?.filtered_examples || []).slice(0, 3)
    .map((entry) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? `No candidates available.\nFiltered examples:\n${examples}`
    : "No candidates available right now.";
}

async function deployLatestCandidate(index) {
  const candidate = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  if (_latestCandidates.length === 1) {
    const mint = candidate.base?.mint || candidate.base_mint || null;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: candidate.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);
    const context = {
      pool: candidate,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
    };
    const skipReason = getLoneCandidateSkipReason(context);
    if (skipReason) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Single cached candidate skipped",
        reason: skipReason,
        pool: candidate.pool,
        pool_name: candidate.name,
      });
      throw new Error(`NO DEPLOY: only cached candidate ${candidate.name} is not worth deploying — ${skipReason}`);
    }
  }
  const deployAmount = computeDeployAmount((await getWalletBalances()).sol);
  const binsBelow = computeBinsBelow(candidate.volatility);
  const result = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.tvl ?? candidate.active_tvl ?? null,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }
  if (_managementBusy || _screeningBusy || _claimAllBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  if (isSpotEnabled()) {
    const confirmationReply = spotConfirmationStore.resolveReply(text);
    if (confirmationReply.handled) {
      if (confirmationReply.status !== "confirmed") {
        await sendMessage(formatSpotConfirmationResolution(confirmationReply)).catch(() => {});
        return;
      }

      busy = true;
      _screeningBusy = true;
      let liveMessage = null;
      let executionStarted = false;
      const confirmation = confirmationReply.confirmation;
      try {
        log("spot_confirmation", `Accepted ${confirmation.id} for ${confirmation.pool.slice(0, 8)}...`);
        liveMessage = await createLiveMessage(
          "Spot Entry Confirmation",
          `Fresh preflight untuk ${confirmation.name} sedang dijalankan.`,
        );
        await liveMessage?.toolStart("open_spot_position");
        executionStarted = true;
        const result = await executeTool("open_spot_position", {
          pool_address: confirmation.pool,
        });
        const grounded = formatConfirmedSpotOpenResult(result, config.spot.tradeAmountSol);
        await liveMessage?.toolFinish(
          "open_spot_position",
          result,
          grounded.kind === "open_confirmed" || grounded.kind === "open_dry_run",
        );
        appendHistory(text, grounded.text);
        if (liveMessage) await liveMessage.finalize(grounded.text);
        else await sendMessage(grounded.text);
      } catch (error) {
        const detail = String(error?.message || error || "unknown error")
          .replace(/[\r\n\t]+/g, " ")
          .slice(0, 300);
        const message = executionStarted
          ? `STATUS TRANSAKSI BELUM PASTI\n\nExecution flow ended without an authoritative result: ${detail}\nJANGAN kirim ulang konfirmasi. Cek status posisi dan chain terlebih dahulu.`
          : `Konfirmasi gagal sebelum tool eksekusi dimulai: ${detail}\nTidak ada transaksi yang dikirim.`;
        log("spot_confirmation_error", detail);
        if (liveMessage) await liveMessage.fail(message).catch(() => {});
        else await sendMessage(message).catch(() => {});
      } finally {
        busy = false;
        _screeningBusy = false;
        refreshPrompt();
        drainTelegramQueue().catch(() => {});
      }
      return;
    }
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      const sent = await sendHTML(briefing);
      if (!sent?.ok) throw new Error("Telegram rejected the briefing delivery");
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/help") {
    await sendMessage(formatHelpText()).catch(() => {});
    return;
  }

  if (text === "/status" || text === "/positions") {
    await sendMessage(formatTradingStatus(await getTradingStatus())).catch(() => {});
    return;
  }

  if (text === "/close spot") {
    try {
      const result = await executeTool("close_spot_position", { reason: "manual Telegram spot close" });
      await sendMessage(result?.trade_status === "closed" ? `Spot closed. Realized PnL: ${result.pnl_sol} SOL.`
        : result?.dry_run ? "DRY RUN — no spot sell sent." : `Spot close not confirmed: ${result?.reason || result?.error || "unknown"}`).catch(() => {});
    } catch (error) { await sendMessage(`Spot close not confirmed: ${error.message}`).catch(() => {}); }
    return;
  }

  if (text === "/wallet") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix = text === "/status" && positions.total_positions
        ? `\n\nUse /positions for the numbered list.`
        : "";
      await sendMessage(`${formatWalletStatus(wallet, positions)}${suffix}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    await sendMessage(formatConfigSnapshot()).catch(() => {});
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage([
        `${idx + 1}. ${pos.pair}`,
        `Pool: ${pos.pool}`,
        `Position: ${pos.position}`,
        `Range: ${pos.lower_bin} → ${pos.upper_bin} | active ${pos.active_bin}`,
        `Net PnL: ${formatNetPnlPercent(pos)} (${pos.net_pnl_status ?? "UNKNOWN"}) | fees: ${config.management.solMode ? "◎" : "$"}${pos.unclaimed_fees_usd ?? "?"}`,
        `Capital PnL excl. fees: $${pos.capital_pnl_usd ?? "?"} | Fee contribution: $${pos.fee_contribution_usd ?? "?"}`,
        `Value: ${config.management.solMode ? "◎" : "$"}${pos.total_value_usd ?? "?"}`,
        `Age: ${pos.age_minutes ?? "?"}m | ${pos.in_range ? "IN RANGE" : `OOR ${pos.minutes_out_of_range ?? 0}m`}`,
        pos.instruction ? `Note: ${pos.instruction}` : null,
      ].filter(Boolean).join("\n"));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await executeTool("close_position", {
        position_address: pos.position,
        reason: "manual Telegram close",
      });
      if (result.success) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nClaim txs: ${result.claim_txs.join(", ")}` : "";
        const settlementNote = result.settlement_status === "settled_to_sol"
          ? "\nSettlement: ✅ base token swapped to SOL (finalized)."
          : result.settlement_status === "settled_no_base_token" || result.settlement_status === "settled_in_sol"
          ? "\nSettlement: ✅ no base-token swap remains."
          : result.settlement_status === "manual_hold"
          ? "\nSettlement: ℹ️ base token intentionally kept."
          : "\nSettlement: ⚠️ token is NOT yet confirmed as SOL; persistent auto-swap retry is pending.";
        await sendMessage(`✅ Close confirmed on-chain: ${pos.pair}\nPnL: ${config.management.solMode ? "◎" : "$"}${result.pnl_usd ?? "?"} | close txs: ${closeTxs?.join(", ") || "n/a"}${claimNote}${settlementNote}`);
      } else {
        const verificationNote = result.close_status === "pending_verification"
          ? "\n⚠️ The close transaction may have been sent, but the position is NOT confirmed closed on-chain yet."
          : "";
        await sendMessage(`❌ Close not confirmed: ${result.error || result.reason || JSON.stringify(result)}${verificationNote}`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      if (readSpotPosition()) {
        const spotResult = await executeTool("close_spot_position", { reason: "manual Telegram close-all" });
        await sendMessage(spotResult?.trade_status === "closed" ? "Spot close confirmed."
          : spotResult?.dry_run ? "DRY RUN — spot close not submitted." : `Spot close unresolved: ${spotResult?.reason || spotResult?.error || "unknown"}`);
        if (spotResult?.trade_status !== "closed" && !spotResult?.dry_run) return;
      }
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("No open LP positions."); return; }
      await sendMessage(`Closing ${positions.length} position(s)...`);
      const results = [];
      for (const pos of positions) {
        try {
          const result = await executeTool("close_position", {
            position_address: pos.position,
            reason: "manual Telegram close-all",
          });
          const settlement = result.settlement_status === "settled_to_sol"
            ? " + SOL settled"
            : result.settlement_status === "settled_no_base_token" || result.settlement_status === "settled_in_sol"
            ? " + settled"
            : result.success
            ? " + swap pending"
            : "";
          results.push(`${pos.pair}: ${result.success ? `closed on-chain${settlement}` : `not confirmed (${result.error || "unknown"})`}`);
        } catch (error) {
          results.push(`${pos.pair}: failed (${error.message})`);
        }
      }
      await sendMessage(`Close-all finished.\n\n${results.join("\n")}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/claimall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      const plan = prepareClaimAll(positions);
      await sendMessage(formatClaimAllPreflight(plan, {
        solMode: config.management.solMode,
        autoSwapAfterClaim: config.management.autoSwapAfterClaim,
      })).catch(() => {});
    } catch (error) {
      await sendMessage(`Error: ${error.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/claimall confirm") {
    _claimAllBusy = true;
    busy = true;
    try {
      const { positions } = await getMyPositions({ force: true });
      const plan = prepareClaimAll(positions);
      if (plan.claimable.length === 0) {
        await sendMessage(formatClaimAllPreflight(plan, {
          solMode: config.management.solMode,
          autoSwapAfterClaim: config.management.autoSwapAfterClaim,
        })).catch(() => {});
        return;
      }

      log("telegram", `Claim-all confirmed for ${plan.claimable.length} position(s)`);
      await sendMessage(`Claiming fees from ${plan.claimable.length} position(s). Execution stops after the first unsuccessful claim.`).catch(() => {});
      const outcome = await executeClaimAll(plan.claimable, ({ position_address }) => (
        executeTool("claim_fees", { position_address })
      ));
      await sendMessage(formatClaimAllOutcome(outcome, {
        solMode: config.management.solMode,
        autoSwapAfterClaim: config.management.autoSwapAfterClaim,
      })).catch(() => {});
    } catch (error) {
      await sendMessage(`Error: ${error.message}`).catch(() => {});
    } finally {
      _claimAllBusy = false;
      busy = false;
      drainTelegramQueue().catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key = setCfgMatch[1];
      const value = parseConfigValue(setCfgMatch[2]);
      const result = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendMessage(`Config update failed.\nUnknown: ${(result?.unknown || []).join(", ") || "none"}`).catch(() => {});
        return;
      }
      await sendMessage(`✅ Updated ${key} = ${JSON.stringify(value)}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      if (isSpotEnabled()) {
        const scanned = config.trading.mode === "hybrid"
          ? await scanHybridCandidates({ scanSpot: () => getSpotMomentumCandidates({ limit: 5 }), scanLp: () => getTopCandidates({ limit: 5 }) })
          : { spot: await getSpotMomentumCandidates({ limit: 5 }), lp: { candidates: [] } };
        setLatestCandidates([...(scanned.spot?.candidates || []).map((p) => ({ ...p, trading_strategy: "spot" })),
          ...(scanned.lp?.candidates || []).map((p) => ({ ...p, trading_strategy: "lp" }))]);
        const details = [scanned.spot?.error, scanned.spot?.reason, ...(scanned.spot?.source_errors || []).map((e) => e.reason),
          scanned.lp?.pending ? "LP scanner still running; run /screen again for its completed shortlist." : scanned.lp?.error,
          ...(scanned.spot?.filtered_examples || []).slice(0, 2).map((e) => e.reason)].filter(Boolean).join("\n");
        await sendMessage(`${describeLatestCandidates(10)}${details ? `\n${details}` : ""}\nScreening only; no trade submitted.`).catch(() => {});
        return;
      }
      await sendMessage(await runDeterministicScreen(5)).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    await sendMessage(describeLatestCandidates(5)).catch(() => {});
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      if (_latestCandidates[idx]?.trading_strategy === "spot") {
        const result = await executeTool("open_spot_position", { pool_address: _latestCandidates[idx].pool });
        await sendMessage(formatConfirmedSpotOpenResult(result, config.spot.tradeAmountSol).text).catch(() => {});
        return;
      }
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deployed ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    stopCronJobs();
    cronStarted = false;
    await sendMessage("⏸ Paused autonomous cycles. Telegram control still works. Use /resume to start again.").catch(() => {});
    return;
  }

  if (text === "/resume") {
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      await sendMessage("▶️ Autonomous cycles resumed.").catch(() => {});
    } else {
      await sendMessage("Autonomous cycles are already running.").catch(() => {});
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendMessage(`HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch(() => {});
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendMessage([
        "HiveMind: enabled",
        `Agent ID: ${agentId}`,
        `URL: ${config.hiveMind.url}`,
        `Pull mode: ${pullMode}`,
        `Register: ${registerResult ? "ok" : "warn"}`,
        `Shared lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
        `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
        isManualPull ? "Manual pull: completed" : null,
      ].join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`HiveMind error: ${e.message}`).catch(() => {});
    }
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    let spotCandidateResult = null;
    let spotOpenResult = null;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => {
        if (name === "get_spot_momentum_candidates") spotCandidateResult = result;
        if (name === "open_spot_position") {
          if (spotOpenResult == null) spotOpenResult = result;
          const groundedResult = formatConfirmedSpotOpenResult(result, config.spot.tradeAmountSol);
          success = groundedResult.kind === "open_confirmed" || groundedResult.kind === "open_dry_run";
        }
        await liveMessage?.toolFinish(name, result, success);
      },
    });
    const strippedContent = stripThink(content);
    const grounded = isSpotEnabled() && (config.trading.mode === "spot_momentum" || spotCandidateResult != null || spotOpenResult != null)
      ? groundSpotAgentOutcome({
          assistantText: strippedContent,
          candidateResult: spotCandidateResult,
          openResult: spotOpenResult,
          confirmationStore: spotConfirmationStore,
          amountSol: config.spot.tradeAmountSol,
        })
      : { kind: "assistant_text", text: strippedContent };
    if (grounded.kind === "confirmation_armed") {
      log("spot_confirmation", `Armed ${grounded.confirmation.id} for ${grounded.confirmation.pool.slice(0, 8)}...`);
    } else if (grounded.kind === "ungrounded_claim") {
      log("spot_confirmation_warn", "Suppressed an ungrounded spot execution claim from the model");
    }
    appendHistory(text, grounded.text);
    if (liveMessage) await liveMessage.finalize(grounded.text);
    else await sendMessage(grounded.text);
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

function getLoneCandidateSkipReason({ pool, sw, n, ti } = {}) {
  if (!pool) return "missing candidate data";
  const tokenInfo = ti || {};
  const hasNarrative = !!n?.narrative;
  // Degen Score is the conviction signal for a solo deploy. Smart wallet is NO LONGER a
  // gate here — it's a confidence boost surfaced to the LLM, not a requirement.
  const degen = degenScore(pool, config.opportunity);
  const degenStrong = degen >= (config.screening.loneCandidateMinDegen ?? 50);
  const globalFeesSol = Number(tokenInfo.global_fees_sol ?? pool.gmgn_total_fee_sol);
  const top10Pct = Number(tokenInfo.audit?.top_holders_pct ?? pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct);
  const botPct = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);

  // Hard fundamental gates — no override.
  if (Number.isFinite(globalFeesSol) && globalFeesSol < config.screening.minTokenFeesSol) {
    return `token fees ${globalFeesSol} SOL below minimum ${config.screening.minTokenFeesSol} SOL`;
  }
  if (Number.isFinite(top10Pct) && top10Pct > config.screening.maxTop10Pct) {
    return `top10 concentration ${top10Pct}% above maximum ${config.screening.maxTop10Pct}%`;
  }
  if (Number.isFinite(botPct) && botPct > config.screening.maxBotHoldersPct) {
    return `bot holders ${botPct}% above maximum ${config.screening.maxBotHoldersPct}%`;
  }

  // PVP conflict needs strong conviction (degen) to deploy solo.
  if (pool.is_pvp && !degenStrong) {
    return `PVP symbol conflict without strong degen conviction (degen ${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  // Conviction: a solo deploy needs a narrative OR a strong degen score.
  if (!hasNarrative && !degenStrong) {
    return `only candidate has no narrative and weak degen score (${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  return null;
}

function computeBinsBelow(volatility) {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isMain && runtimeRpcVerified && isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    const latest = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool = latest[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates and deploy only if a candidate is clearly worth it. If there is only one weak candidate, report NO DEPLOY. For a valid deploy, use amount_y=${DEPLOY}, amount_x=0, bins_above=0, and bins_below from positive volatility. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  maxVolatility:        ${s.maxVolatility}`);
      console.log(`  requireTokenAudit:    ${s.requireTokenAudit}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync(repoPath("lessons.json"), "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (isMain && runtimeRpcVerified) {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      await runScreeningCycle({ silent: false });
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
} else if (isMain) {
  log("startup_error", "Autonomous cycles and Telegram polling are disabled until a Solana mainnet RPC is verified.");
}
