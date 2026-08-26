import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateAutoSwapBalance,
  evaluateCloseProof,
} from "../close-settlement.js";

test("a close is confirmed only after finality and direct account absence", () => {
  assert.deepEqual(
    evaluateCloseProof({ transactionFinalized: false, positionAccountPresent: false }),
    { confirmed: false, close_status: "pending_verification", reason: "close_transaction_not_finalized" },
  );
  assert.deepEqual(
    evaluateCloseProof({ transactionFinalized: true, positionAccountPresent: true }),
    { confirmed: false, close_status: "pending_verification", reason: "position_account_still_exists" },
  );
  assert.deepEqual(
    evaluateCloseProof({ transactionFinalized: true, positionAccountPresent: undefined }),
    { confirmed: false, close_status: "pending_verification", reason: "position_account_unverified" },
  );
  assert.deepEqual(
    evaluateCloseProof({ transactionFinalized: true, positionAccountPresent: false }),
    { confirmed: true, close_status: "confirmed_on_chain", reason: "position_account_absent_at_finalized" },
  );
});

test("an unavailable balance source never resolves an autoswap", () => {
  assert.deepEqual(
    evaluateAutoSwapBalance({ balanceReadSucceeded: false }),
    { action: "retry", settlement_status: "pending_auto_swap", reason: "balance_unavailable" },
  );
  assert.deepEqual(
    evaluateAutoSwapBalance({ balanceReadSucceeded: true, amount: 0 }),
    { action: "settled", settlement_status: "settled_no_base_token", reason: "zero_balance_at_finalized" },
  );
  assert.deepEqual(
    evaluateAutoSwapBalance({ balanceReadSucceeded: true, amount: 1.25 }),
    { action: "swap", settlement_status: "pending_auto_swap", reason: "base_token_balance_present" },
  );
});

async function withTemporaryState(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-state-"));
  const previousStateFile = process.env.MERIDIAN_STATE_FILE;
  process.env.MERIDIAN_STATE_FILE = path.join(directory, "state.json");
  try {
    const state = await import(`../state.js?test=${Date.now()}-${Math.random()}`);
    await callback(state, process.env.MERIDIAN_STATE_FILE);
  } finally {
    if (previousStateFile === undefined) delete process.env.MERIDIAN_STATE_FILE;
    else process.env.MERIDIAN_STATE_FILE = previousStateFile;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("a missing position feed observation cannot close tracked state", async () => {
  await withTemporaryState(async (state) => {
    const position = "Position11111111111111111111111111111111111";
    state.trackPosition({ position, pool: "Pool111111111111111111111111111111111111" });

    state.syncOpenPositions([]);

    const tracked = state.getTrackedPosition(position);
    assert.equal(tracked.closed, false);
    assert.match(tracked.notes.at(-1), /awaiting direct on-chain close verification/i);
  });
});

test("a historical false-close can be restored only by a direct-proof caller", async () => {
  await withTemporaryState(async (state) => {
    const position = "Position11111111111111111111111111111111111";
    state.trackPosition({ position, pool: "Pool111111111111111111111111111111111111" });
    state.recordClose(position, "old feed reconciliation");

    assert.equal(state.reopenPositionFromOnChain(position), true);
    assert.equal(state.getTrackedPosition(position).closed, false);
  });
});

test("pending autoswaps survive retries and clear only after direct settlement", async () => {
  await withTemporaryState(async (state, stateFile) => {
    const queued = state.queuePendingAutoSwap({
      position_address: "Position11111111111111111111111111111111111",
      base_mint: "BaseMint111111111111111111111111111111111111",
      close_txs: ["close-signature"],
    });
    assert.equal(state.getPendingAutoSwaps().length, 1);

    state.recordPendingAutoSwapAttempt(queued.key, {
      error: "Jupiter route unavailable",
      observed_amount: 2.5,
    });
    const retried = state.getPendingAutoSwaps()[0];
    assert.equal(retried.attempt_count, 1);
    assert.equal(retried.last_error, "Jupiter route unavailable");

    state.completePendingAutoSwap(queued.key, {
      settlement_status: "settled_to_sol",
      tx: "swap-signature",
    });
    assert.equal(state.getPendingAutoSwaps().length, 0);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).pendingAutoSwaps[queued.key].status, "settled_to_sol");
  });
});
