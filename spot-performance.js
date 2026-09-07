import { evaluateSpotExit } from "./spot-momentum.js";

const number = (value) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

/** Realized, closed trades only. pnlSol already includes measured wallet debit/credit. */
export function summarizeSpotPerformance(history = []) {
  const closed = history.filter((trade) => trade.status === "closed");
  const valid = closed.filter((trade) => number(trade.pnlSol) != null);
  const pnls = valid.map((trade) => Number(trade.pnlSol));
  const wins = pnls.filter((pnl) => pnl > 0);
  const losses = pnls.filter((pnl) => pnl < 0);
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const averageWinSol = wins.length ? sum(wins) / wins.length : null;
  const averageLossSol = losses.length ? -sum(losses) / losses.length : null;
  const realizedNetSol = sum(pnls);
  return {
    closedTrades: valid.length, invalidClosedTrades: closed.length - valid.length,
    wins: wins.length, losses: losses.length, breakEvenTrades: pnls.filter((pnl) => pnl === 0).length,
    winRatePct: valid.length ? wins.length / valid.length * 100 : null,
    realizedNetSol, averageWinSol, averageLossSol,
    expectancySol: valid.length ? realizedNetSol / valid.length : null,
    breakEvenWinRatePct: averageWinSol != null && averageLossSol != null
      ? averageLossSol / (averageWinSol + averageLossSol) * 100 : null,
    profitFactor: losses.length ? sum(wins) / -sum(losses) : null,
    profitableSample: valid.length > 0 && realizedNetSol > 0,
    warning: "Historical sample only; not evidence of future profitability. No risk settings are changed.",
  };
}

/** Offline exit replay. Quotes must be tracked-size minimum outputs AFTER slippage.
 * entryCostSol includes entry fees/rent. Exit fee must be supplied, never assumed zero.
 * This is a decision replay, not a simulation of successful landing/finality or MEV.
 */
export function replaySpotExits({ entryCostSol, openedAt, quotes = [], policy = {} } = {}) {
  const entry = number(entryCostSol);
  const start = Date.parse(openedAt);
  if (entry == null || entry <= 0 || !Number.isFinite(start)) throw new Error("Valid measured entry cost and opening time are required");
  const position = { entryCostSol: entry, openedAt, peakPnlPct: 0 };
  let previousAt = start;
  let lastNetPnlPct = null;
  for (const quote of quotes) {
    const at = Date.parse(quote.at);
    if (!Number.isFinite(at) || at < previousAt) throw new Error("Quote times must be ordered after the opening time");
    previousAt = at;
    const minimum = number(quote.minimumOutSol);
    const fees = number(quote.exitFeeSol);
    if (minimum == null || minimum < 0 || fees == null || fees < 0) throw new Error("Minimum output and explicit exit fees are required");
    const netValueSol = minimum - fees;
    // The production exit rule prices the asset at no less than zero. Report
    // actual net cash flow separately: fees paid from SOL can exceed proceeds.
    const exit = evaluateSpotExit({ position, currentValueSol: Math.max(0, netValueSol), now: new Date(at), policy });
    position.peakPnlPct = exit.peakPnlPct;
    lastNetPnlPct = (netValueSol - entry) / entry * 100;
    const protectedProfit = ["TAKE_PROFIT", "TRAILING_TAKE_PROFIT"].includes(exit.action);
    if (exit.action === "HOLD" || (protectedProfit && exit.pnlPct < (policy.minProfitExitPct ?? 0.1))) continue;
    return { action: exit.action, at: quote.at, netPnlSol: netValueSol - entry, lastNetPnlPct,
      reason: netValueSol < 0 ? `${exit.reason}; exit fees exceed sale proceeds` : exit.reason,
      executed: false, basis: "tracked-size minimum output less exit fee, against measured entry cost" };
  }
  return { action: "HOLD", lastNetPnlPct, executed: false, reason: "No executable exit in the supplied observations" };
}
