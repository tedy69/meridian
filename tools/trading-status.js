import { config } from "../config.js";
import { getHybridRiskStatus } from "../hybrid-risk.js";
import { getMyPositions } from "./dlmm.js";
import { getSpotPositionSnapshot } from "./spot.js";
import { readRuntimeHealth } from "../runtime-health.js";
import { repoPath } from "../repo-root.js";
import { withReadDeadline } from "../read-deadline.js";
import { getRealtimeMonitorTelemetry } from "../account-realtime.js";

export async function getTradingStatus(_args = {}, { getLp = () => getMyPositions({ force: true, silent: true }),
  getSpot = getSpotPositionSnapshot, getRisk = getHybridRiskStatus,
  getHealth = () => readRuntimeHealth(repoPath("runtime-health.json")) } = {}) {
  const safe = async (read) => { try { return await withReadDeadline(read, { timeoutMs: 10_000, label: "Trading status read" }); } catch (error) { return { error: error.message }; } };
  const [lp, spot, risk, health] = await Promise.all([safe(getLp), safe(getSpot), safe(getRisk), safe(getHealth)]);
  const lpKnown = !lp?.error && Array.isArray(lp?.positions) && Number.isInteger(lp.total_positions) && lp.total_positions === lp.positions.length;
  const spotKnown = !spot?.error && (spot?.position != null || spot?.status === "none");
  return { mode: risk?.mode || config.trading.mode, lp, spot, risk, health,
    realtime: getRealtimeMonitorTelemetry(),
    total_open_positions: lpKnown && spotKnown ? lp.total_positions + (spot.position ? 1 : 0) : null };
}

export function formatTradingStatus({ mode, lp, spot, risk, health, realtime = {} }) {
  const clean = (v) => String(v || "").replace(/[<>`\r\n]/g, " ").slice(0, 140);
  const position = spot?.position;
  const pnl = spot?.priceable && Number.isFinite(spot.pnl_pct) ? `${spot.pnl_pct.toFixed(2)}%` : "unknown";
  const lpKnown = !lp?.error && Array.isArray(lp?.positions) && lp.total_positions === lp.positions.length;
  return [
    `Mode: ${mode}`,
    health ? `Scanner: ${health.healthy === true ? "healthy" : "unhealthy"} — ${clean(health.reason || health.error)}` : null,
    ...Object.entries(realtime).map(([name, monitor]) => `Realtime ${name}: ${monitor.running ? "running" : "stopped"} | ${monitor.subscribed_accounts?.length ?? 0} accounts | event→refresh p95 ${monitor.latency_ms?.event_to_refresh?.p95 ?? "N/A"}ms | refresh p95 ${monitor.latency_ms?.refresh_duration?.p95 ?? "N/A"}ms`),
    position ? `Spot: ${clean(position.symbol || position.mint)} (${clean(position.venue || "meteora")}) | ${position.status} | estimated net exit PnL: ${pnl}`
      : `Spot: ${spot?.error ? `unknown (${clean(spot.error)})` : "none"}`,
    position && !spot.priceable ? `Spot price: unavailable (${clean(spot.reason || spot.status)})` : null,
    `LP: ${lpKnown ? lp.total_positions : `unknown (${clean(lp?.error || "invalid snapshot")})`}`,
    ...(lpKnown ? lp.positions.map((p, index) => `${index + 1}. ${clean(p.pair || p.pool)} | ${p.position} | net PnL: ${p.net_pnl_status === "UNKNOWN" || p.pnl_pct_suspicious || !Number.isFinite(p.pnl_pct) ? "unknown" : `${p.pnl_pct.toFixed(2)}%`}`) : []),
    mode === "hybrid" ? `Shared reserve: ${risk?.policy?.reserveSol ?? "unknown"} SOL | max one position | pending entry: ${risk?.entry_pending ?? "unknown"}` : null,
    risk?.error ? `Risk state unavailable: ${clean(risk.error)}` : null,
    position ? "Use /close spot for the spot position; /close <n> for LP." : null,
  ].filter(Boolean).join("\n");
}
