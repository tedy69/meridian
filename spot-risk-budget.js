import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { repoPath } from "./repo-root.js";

const DEFAULT_PATH = process.env.MERIDIAN_SPOT_BUDGET_FILE || repoPath("spot-risk-budget.json");

function dateKey(now) {
  return now.toISOString().slice(0, 10);
}

function finiteNonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative finite SOL amount.`);
  return number;
}

function finitePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive finite SOL amount.`);
  return number;
}

function empty(now) {
  return { date: dateKey(now), boughtSol: 0, realizedPnlSol: 0, reservations: {} };
}

function read(file, now) {
  if (!fs.existsSync(file)) return empty(now);
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("budget must be an object");
    if (value.date !== dateKey(now)) return empty(now);
    if (!value.reservations || typeof value.reservations !== "object" || Array.isArray(value.reservations)) throw new Error("reservations are invalid");
    return {
      date: value.date,
      boughtSol: finiteNonNegative(value.boughtSol, "boughtSol"),
      realizedPnlSol: Number.isFinite(Number(value.realizedPnlSol)) ? Number(value.realizedPnlSol) : (() => { throw new Error("realizedPnlSol is invalid"); })(),
      reservations: value.reservations,
    };
  } catch (error) {
    throw new Error(`Cannot read spot risk budget file ${file}: ${error.message}`);
  }
}

function write(file, budget) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(budget, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function reservedSol(budget) {
  return Object.values(budget.reservations).reduce(
    (sum, reservation) => sum + finitePositive(reservation?.amountSol, "reserved amount"),
    0,
  );
}

export function getSpotRiskBudget({ budgetPath = DEFAULT_PATH, now = new Date(), maxDailyBuySol = null, maxDailyLossSol = null } = {}) {
  const budget = read(budgetPath, now);
  return {
    ...budget,
    reservedSol: reservedSol(budget),
    maxDailyBuySol,
    maxDailyLossSol,
  };
}

export function reserveSpotBuy({ amountSol, maxDailyBuySol, maxDailyLossSol, budgetPath = DEFAULT_PATH, now = new Date() } = {}) {
  const amount = finitePositive(amountSol, "Spot buy amount");
  const buyCap = maxDailyBuySol == null ? null : finitePositive(maxDailyBuySol, "maxDailyBuySol");
  const lossCap = finitePositive(maxDailyLossSol, "maxDailyLossSol");
  const budget = read(budgetPath, now);
  if (budget.realizedPnlSol <= -lossCap + Number.EPSILON) {
    throw new Error(`Daily spot loss cap reached: ${budget.realizedPnlSol.toFixed(6)} SOL <= -${lossCap.toFixed(6)} SOL.`);
  }
  const used = budget.boughtSol + reservedSol(budget);
  if (buyCap != null && used + amount > buyCap + 1e-9) {
    throw new Error(`Daily spot buy cap reached: ${used.toFixed(6)} + ${amount.toFixed(6)} SOL exceeds ${buyCap.toFixed(6)} SOL.`);
  }
  const id = randomUUID();
  budget.reservations[id] = { amountSol: amount, reservedAt: now.toISOString() };
  write(budgetPath, budget);
  return { id, amountSol: amount, budgetPath, date: budget.date };
}

export function commitSpotBuy(reservation, { budgetPath = reservation?.budgetPath || DEFAULT_PATH, now = new Date() } = {}) {
  if (!reservation?.id) throw new Error("Spot buy reservation is required.");
  const budget = read(budgetPath, now);
  const held = budget.reservations[reservation.id];
  if (!held) throw new Error("Spot buy reservation was not found.");
  const amount = finitePositive(held.amountSol, "reserved amount");
  delete budget.reservations[reservation.id];
  budget.boughtSol += amount;
  write(budgetPath, budget);
  return { ...budget, reservedSol: reservedSol(budget) };
}

export function releaseSpotBuy(reservation, { budgetPath = reservation?.budgetPath || DEFAULT_PATH, now = new Date() } = {}) {
  if (!reservation?.id) return false;
  const budget = read(budgetPath, now);
  if (!budget.reservations[reservation.id]) return false;
  delete budget.reservations[reservation.id];
  write(budgetPath, budget);
  return true;
}

export function recordSpotRealizedPnl({ pnlSol, budgetPath = DEFAULT_PATH, now = new Date() } = {}) {
  const pnl = Number(pnlSol);
  if (!Number.isFinite(pnl)) throw new Error("Spot realized PnL must be finite.");
  const budget = read(budgetPath, now);
  budget.realizedPnlSol += pnl;
  write(budgetPath, budget);
  return { ...budget, reservedSol: reservedSol(budget) };
}
