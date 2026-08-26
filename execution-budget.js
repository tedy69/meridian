import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { repoPath } from "./repo-root.js";

const DEFAULT_BUDGET_PATH = repoPath("execution-budget.json");

function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function asPositiveFinite(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`${label} must be a positive finite SOL amount.`);
  }
  return numeric;
}

function asNonNegativeFinite(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`${label} must be a non-negative finite SOL amount.`);
  }
  return numeric;
}

function emptyBudget(date) {
  return { date, deployedSol: 0, reservations: {} };
}

function readBudget(budgetPath, now) {
  const date = dayKey(now);
  if (!fs.existsSync(budgetPath)) return emptyBudget(date);

  try {
    const parsed = JSON.parse(fs.readFileSync(budgetPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("budget is not an object");
    }
    if (parsed?.date !== date) return emptyBudget(date);
    if (!parsed.reservations || typeof parsed.reservations !== "object" || Array.isArray(parsed.reservations)) {
      throw new Error("budget reservations are invalid");
    }
    return {
      date,
      deployedSol: asNonNegativeFinite(parsed.deployedSol, "deployedSol"),
      reservations: parsed.reservations,
    };
  } catch {
    // An unreadable guard file must not make the agent assume that no capital
    // has been deployed. Refuse the write path until an operator reviews it.
    throw new Error(`Cannot read execution budget file: ${budgetPath}`);
  }
}

function writeBudget(budgetPath, budget) {
  const directory = path.dirname(budgetPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${budgetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(budget, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, budgetPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function reservedSol(budget) {
  return Object.values(budget.reservations)
    .reduce((total, reservation) => total + asPositiveFinite(reservation?.amountSol, "Reserved deploy amount"), 0);
}

function snapshot(budget, maxDailyDeploySol) {
  const reserved = reservedSol(budget);
  return {
    date: budget.date,
    deployedSol: budget.deployedSol,
    reservedSol: reserved,
    usedSol: budget.deployedSol + reserved,
    maxDailyDeploySol: maxDailyDeploySol == null ? null : Number(maxDailyDeploySol),
  };
}

export function getDailyDeployBudget({
  budgetPath = DEFAULT_BUDGET_PATH,
  maxDailyDeploySol = null,
  now = new Date(),
} = {}) {
  return snapshot(readBudget(budgetPath, now), maxDailyDeploySol);
}

/**
 * Reserve budget synchronously before handing control to a transaction path.
 * A reservation remains counted if a process dies or a transaction result is
 * uncertain; this deliberately favors a conservative fail-closed outcome.
 */
export function reserveDailyDeploy({
  amountSol,
  maxDailyDeploySol,
  budgetPath = DEFAULT_BUDGET_PATH,
  now = new Date(),
} = {}) {
  const amount = asPositiveFinite(amountSol, "Deploy amount");
  const cap = asPositiveFinite(maxDailyDeploySol, "maxDailyDeploySol");
  const budget = readBudget(budgetPath, now);
  const used = budget.deployedSol + reservedSol(budget);

  if (used + amount > cap + 1e-9) {
    throw new Error(
      `Daily deploy cap reached: ${used.toFixed(6)} SOL used/reserved + ${amount.toFixed(6)} SOL requested exceeds ${cap.toFixed(6)} SOL.`,
    );
  }

  const id = randomUUID();
  budget.reservations[id] = {
    amountSol: amount,
    reservedAt: now.toISOString(),
  };
  writeBudget(budgetPath, budget);

  return {
    id,
    amountSol: amount,
    date: budget.date,
    budgetPath,
    ...snapshot(budget, cap),
  };
}

export function commitDailyDeployReservation(reservation, {
  budgetPath = reservation?.budgetPath ?? DEFAULT_BUDGET_PATH,
  now = new Date(),
} = {}) {
  if (!reservation?.id) throw new Error("A deploy budget reservation is required.");

  const budget = readBudget(budgetPath, now);
  const held = budget.reservations[reservation.id];
  const amount = asPositiveFinite(held?.amountSol ?? reservation.amountSol, "Reserved deploy amount");
  delete budget.reservations[reservation.id];
  budget.deployedSol += amount;
  writeBudget(budgetPath, budget);

  return snapshot(budget, reservation.maxDailyDeploySol);
}
