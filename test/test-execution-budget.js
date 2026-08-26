import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  commitDailyDeployReservation,
  getDailyDeployBudget,
  reserveDailyDeploy,
} from "../execution-budget.js";
import { logDailyDeployReservation } from "../tools/executor.js";

function withBudgetFile(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-budget-"));
  const budgetPath = path.join(directory, "execution-budget.json");
  try {
    return callback(budgetPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("daily deploy budget blocks the amount above its cap", () => {
  withBudgetFile((budgetPath) => {
    const now = new Date("2026-08-26T10:00:00.000Z");
    const reservation = reserveDailyDeploy({
      amountSol: 0.3,
      maxDailyDeploySol: 0.5,
      budgetPath,
      now,
    });

    assert.equal(reservation.amountSol, 0.3);
    assert.throws(
      () => reserveDailyDeploy({
        amountSol: 0.21,
        maxDailyDeploySol: 0.5,
        budgetPath,
        now,
      }),
      /daily deploy cap/i,
    );
  });
});

test("an explicit null daily cap permits deploys without consuming budget", () => {
  withBudgetFile((budgetPath) => {
    const now = new Date("2026-08-26T10:00:00.000Z");

    assert.equal(
      reserveDailyDeploy({
        amountSol: 0.5,
        maxDailyDeploySol: null,
        budgetPath,
        now,
      }),
      null,
    );
    assert.equal(
      reserveDailyDeploy({
        amountSol: 0.5,
        maxDailyDeploySol: null,
        budgetPath,
        now,
      }),
      null,
    );

    const budget = getDailyDeployBudget({ budgetPath, now });
    assert.equal(budget.deployedSol, 0);
    assert.equal(budget.reservedSol, 0);
  });
});

test("a disabled daily cap does not read fields from a missing reservation", () => {
  const entries = [];
  logDailyDeployReservation(null, {
    amountSol: 0.85,
    maxDailyDeploySol: null,
  }, (level, message) => entries.push({ level, message }));

  assert.deepEqual(entries, [{
    level: "budget",
    message: "Daily deploy cap disabled; 0.85 SOL is not reserved.",
  }]);
});

test("a committed deploy remains counted until the next UTC day", () => {
  withBudgetFile((budgetPath) => {
    const dayOne = new Date("2026-08-26T10:00:00.000Z");
    const reservation = reserveDailyDeploy({
      amountSol: 0.5,
      maxDailyDeploySol: 0.5,
      budgetPath,
      now: dayOne,
    });
    const committed = commitDailyDeployReservation(reservation, { budgetPath, now: dayOne });
    assert.equal(committed.deployedSol, 0.5);
    assert.equal(committed.reservedSol, 0);

    assert.throws(
      () => reserveDailyDeploy({
        amountSol: 0.01,
        maxDailyDeploySol: 0.5,
        budgetPath,
        now: dayOne,
      }),
      /daily deploy cap/i,
    );

    const dayTwo = new Date("2026-08-27T00:00:01.000Z");
    const reset = getDailyDeployBudget({ budgetPath, now: dayTwo });
    assert.equal(reset.deployedSol, 0);
    assert.equal(reset.reservedSol, 0);
  });
});

test("an unreadable budget file fails closed", () => {
  withBudgetFile((budgetPath) => {
    fs.writeFileSync(budgetPath, "not-json");
    assert.throws(
      () => reserveDailyDeploy({
        amountSol: 0.1,
        maxDailyDeploySol: 0.5,
        budgetPath,
        now: new Date("2026-08-26T10:00:00.000Z"),
      }),
      /Cannot read execution budget file/,
    );
  });
});

test("a malformed budget amount fails closed", () => {
  withBudgetFile((budgetPath) => {
    fs.writeFileSync(budgetPath, JSON.stringify({
      date: "2026-08-26",
      deployedSol: "unknown",
      reservations: {},
    }));
    assert.throws(
      () => reserveDailyDeploy({
        amountSol: 0.1,
        maxDailyDeploySol: 0.5,
        budgetPath,
        now: new Date("2026-08-26T10:00:00.000Z"),
      }),
      /Cannot read execution budget file/,
    );
  });
});
