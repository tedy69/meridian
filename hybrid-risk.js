import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config.js";
import { repoPath } from "./repo-root.js";
import { isDryRun, SOL_MINT } from "./execution-guard.js";

const execution = new AsyncLocalStorage();
export const isSpotEnabled = (mode = config.trading.mode) => ["spot_momentum", "hybrid"].includes(mode);
export const isLpEnabled = (mode = config.trading.mode) => ["dlmm_lp", "hybrid"].includes(mode);

export function evaluateHybridBudget({ strategy, amountSol, walletSol, lossSol, policy }) {
  const cost = strategy === "lp" ? policy.lpCostBufferSol : policy.spotCostBufferSol;
  if (!["lp", "spot"].includes(strategy) || ![amountSol, walletSol, lossSol, cost].every(Number.isFinite)
      || amountSol <= 0 || lossSol < 0) return { pass: false, reason: "Hybrid budget inputs are invalid" };
  if (amountSol > policy.maxPositionSol + 1e-9) return { pass: false, reason: "Shared per-position capital cap exceeded" };
  if (lossSol >= policy.maxDailyLossSol - 1e-9) return { pass: false, reason: "Shared daily loss cap reached" };
  if (walletSol + 1e-9 < amountSol + cost + policy.reserveSol) return { pass: false, reason: "Shared reserve plus transaction-cost buffer is not funded" };
  return { pass: true, costBufferSol: cost };
}

export function assertHybridSimulationBalance(postBalanceSol) {
  const held = execution.getStore();
  if (!held) return;
  if (!Number.isFinite(postBalanceSol)) throw new Error("Hybrid simulation wallet balance is missing");
  if (postBalanceSol < held.reserveSol - 1e-9) throw new Error("Hybrid simulation would consume the SOL reserve");
  if (held.walletSol - postBalanceSol > held.maximumDebitSol + 1e-9) throw new Error("Hybrid simulation exceeds reserved total SOL debit");
}
export const isHybridEntryExecuting = () => Boolean(execution.getStore());

function loadLedger(file, date, walletSol, priorLossSol) {
  const initial = { date, lastFlatBalanceSol: walletSol, lossSol: priorLossSol };
  if (!fs.existsSync(file)) return initial;
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || !Number.isFinite(value.lastFlatBalanceSol) || !Number.isFinite(value.lossSol) || value.lossSol < 0) {
    throw new Error("Shared risk ledger is invalid; reconciliation required");
  }
  // If a position spanned midnight, conservatively charge its entire loss to
  // the first flat-wallet observation after closing. Never drop an uncertain entry.
  const lossSol = value.date === date ? value.lossSol : priorLossSol;
  return { date, lastFlatBalanceSol: walletSol, lossSol: lossSol + Math.max(0, value.lastFlatBalanceSol - walletSol) };
}

export function createHybridEntryGuard({ directory, policy, getSpotPosition, getTrackedPositions,
  getPendingSettlements, getLpPositions, getWalletSol, getPriorLossSol, now = () => new Date() }) {
  const lock = path.join(directory, "hybrid-entry-lock.json");
  const ledgerFile = path.join(directory, "hybrid-risk-budget.json");
  return {
    async run({ strategy, amountSol }, execute) {
      fs.mkdirSync(directory, { recursive: true });
      const id = randomUUID();
      try {
        fs.writeFileSync(lock, JSON.stringify({ id, strategy, amountSol, startedAt: now().toISOString() }), { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code === "EEXIST") throw new Error("Pending hybrid entry lock exists; reconcile it before another entry (no timed unlock)");
        throw error;
      }
      let retainLock = false;
      try {
        if (getSpotPosition() || getTrackedPositions().length) throw new Error("Existing or unresolved position exposure blocks hybrid entry");
        if (getPendingSettlements().length) throw new Error("Pending LP settlement blocks hybrid entry");
        const lp = await getLpPositions();
        if (!lp || !Array.isArray(lp.positions) || !Number.isInteger(lp.total_positions)
          || lp.total_positions !== lp.positions.length) throw new Error("Fresh LP snapshot is unavailable or inconsistent");
        if (lp.total_positions > 0) throw new Error("Existing LP position blocks hybrid entry");
        const walletSol = await getWalletSol();
        if (!Number.isFinite(walletSol) || walletSol < 0) throw new Error("Finalized wallet balance is unavailable");
        const date = now().toISOString().slice(0, 10);
        const priorLoss = await getPriorLossSol(date);
        if (!Number.isFinite(priorLoss) || priorLoss < 0) throw new Error("Prior daily loss evidence is invalid");
        const ledger = loadLedger(ledgerFile, date, walletSol, priorLoss);
        const temporary = `${ledgerFile}.${id}.tmp`;
        try {
          fs.writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600 });
          fs.renameSync(temporary, ledgerFile);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        const budget = evaluateHybridBudget({ strategy, amountSol, walletSol, lossSol: Math.max(ledger.lossSol, priorLoss), policy });
        if (!budget.pass) throw new Error(budget.reason);
        // From this point an exception could mean a submitted/partially landed
        // transaction. Keep the cross-process lock until operator reconciliation.
        retainLock = true;
        const result = await execution.run({ walletSol, reserveSol: policy.reserveSol,
          maximumDebitSol: amountSol + budget.costBufferSol }, execute);
        const unresolved = result?.pending === true || (result?.submission_attempted === true && result?.success !== true)
          || (result?.success === true && !result?.position);
        retainLock = unresolved;
        return result;
      } finally {
        if (!retainLock) fs.unlinkSync(lock);
      }
    },
  };
}

let runtimeGuard;
export async function withHybridEntry({ strategy, amountSol }, execute) {
  if (config.trading.mode !== "hybrid" || isDryRun()) return execute();
  if (!runtimeGuard) {
    const [spot, state, wallet, dlmm, budget, lessons] = await Promise.all([
      import("./spot-state.js"), import("./state.js"), import("./tools/wallet.js"), import("./tools/dlmm.js"),
      import("./spot-risk-budget.js"), import("./lessons.js"),
    ]);
    runtimeGuard = createHybridEntryGuard({ directory: repoPath("."), policy: config.hybrid,
      getSpotPosition: spot.getSpotPosition, getTrackedPositions: () => state.getTrackedPositions(true),
      getPendingSettlements: state.getPendingAutoSwaps,
      getLpPositions: () => dlmm.getMyPositions({ force: true, silent: true }),
      getWalletSol: async () => (await wallet.getTokenBalanceByMint(SOL_MINT)).amount,
      getPriorLossSol: (date) => {
        const spotLoss = Math.max(0, -budget.getSpotRiskBudget().realizedPnlSol);
        // Bootstrap existing LP history conservatively; subsequent observations
        // use actual flat-wallet SOL drawdown, not LP fees or indicative USD value.
        const lpLoss = lessons.getAllPerformanceRecords().filter((p) => String(p.recorded_at || "").slice(0, 10) === date)
          .reduce((sum, p) => {
            if (!Number.isFinite(Number(p.pnl_pct)) || !Number.isFinite(Number(p.amount_sol))) throw new Error("LP loss history lacks cost evidence");
            return sum + Math.max(0, -Number(p.pnl_pct)) * Number(p.amount_sol) / 100;
          }, 0);
        return spotLoss + lpLoss;
      },
    });
  }
  return runtimeGuard.run({ strategy, amountSol }, execute);
}
