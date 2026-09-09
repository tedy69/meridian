import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateAutoSwapBalance,
  evaluateCloseProof,
} from "../close-settlement.js";
import * as settlement from "../close-settlement.js";

test("a verified single atomic residual is retained as dust without requesting a swap", async () => {
  assert.equal(typeof settlement.reconcileCloseResidual, "function");
  const balance = { mint: "mint", raw_amount: "1", amount: 1e-9, decimals: 9, source: "rpc-finalized" };
  const now = Date.now();
  const result = await settlement.reconcileCloseResidual({ base_mint: "mint", close_txs: ["close"] }, balance, {
    readCloseProof: async () => ({ transactionFinalized: true, positionAccountPresent: false }),
    readPrice: async () => ({ mint: "mint", usdPrice: 0.0023, updatedAt: new Date(now).toISOString() }),
    readBalance: async () => balance, now: () => now,
  });
  assert.equal(result.settlement_status, "settled_dust_remaining");
  assert.equal(result.swapped, false);
  assert.equal(result.residual.raw_amount, "1");
  assert.equal(result.residual.amount, 1e-9);
});

test("dust reconciliation fails closed for valuable, unverified, stale or growing balances", async () => {
  assert.equal(typeof settlement.reconcileCloseResidual, "function");
  const now = Date.now();
  const balance = { mint: "mint", raw_amount: "1", amount: 1e-9, decimals: 9, source: "rpc-finalized" };
  const proof = { transactionFinalized: true, positionAccountPresent: false };
  const price = { mint: "mint", usdPrice: 0.0023, updatedAt: new Date(now).toISOString() };
  for (const change of [
    { balance: { ...balance, raw_amount: "2", amount: 2e-9 } },
    { balance: { ...balance, decimals: 0, amount: 1 } },
    { balance: { ...balance, source: "indexer" } },
    { balance: { ...balance, amount: 2e-9 } },
    { proof: { ...proof, transactionFinalized: false } },
    { proof: { ...proof, positionAccountPresent: true } },
    { proof: { ...proof, positionAccountPresent: undefined } },
    { price: { ...price, usdPrice: 1e9 } },
    { price: { ...price, usdPrice: 0 } },
    { price: { ...price, mint: "other" } },
    { price: { ...price, updatedAt: new Date(now - 60001).toISOString() } },
    { after: { ...balance, raw_amount: "100", amount: 1e-7 } },
  ]) {
    const result = await settlement.reconcileCloseResidual({ base_mint: "mint", close_txs: ["close"] }, change.balance || balance, {
      readCloseProof: async () => change.proof || proof,
      readPrice: async () => change.price || price,
      readBalance: async () => change.after || balance, now: () => now,
    });
    assert.equal(result, null, JSON.stringify(change));
  }
});

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

test("failed settlement retries are persisted, bounded and reset by newly queued close work", async () => {
  await withTemporaryState(async (state) => {
    const args = { position_address: "position", base_mint: "mint", close_txs: ["close"] };
    const queued = state.queuePendingAutoSwap(args);
    assert.equal(settlement.isSettlementRetryDue(queued), true);
    const failed = state.recordPendingAutoSwapAttempt(queued.key, { error: "No route", observed_amount: 1.25 });
    const at = Date.parse(failed.last_attempt_at);
    assert.equal(Date.parse(failed.next_attempt_at) - at, 30_000);
    assert.equal(settlement.isSettlementRetryDue(state.getPendingAutoSwaps()[0], at + 1), false);
    assert.equal(settlement.isSettlementRetryDue(failed, at + 30_000), true);
    assert.equal(settlement.settlementRetryDelayMs(1665), 15 * 60_000);
    assert.equal(settlement.isSettlementRetryDue(state.queuePendingAutoSwap(args), at + 1), true);
  });
});

test("dust completion preserves balance proof and is visible separately from pending SOL conversion", async () => {
  await withTemporaryState(async (state, stateFile) => {
    const queued = state.queuePendingAutoSwap({ position_address: "position", base_mint: "mint" });
    const residual = { mint: "mint", raw_amount: "1", amount: 1e-9, decimals: 9, source: "rpc-finalized",
      value_usd: 2.3e-12, close_proof: { transactionFinalized: true, positionAccountPresent: false } };
    state.completePendingAutoSwap(queued.key, { settlement_status: "settled_dust_remaining", observed_amount: 1e-9, residual });
    assert.equal(state.getPendingAutoSwaps().length, 0);
    assert.deepEqual(state.getAutoSwapStatus().residuals[0].residual, residual);
    assert.equal(JSON.parse(fs.readFileSync(stateFile)).pendingAutoSwaps[queued.key].last_observed_amount, 1e-9);
  });
});

test("an unreadable settlement registry cannot look like an empty queue", async () => {
  await withTemporaryState(async (state, stateFile) => {
    fs.writeFileSync(stateFile, "{broken");
    assert.throws(() => state.getPendingAutoSwaps(), /state unavailable/i);
    assert.throws(() => state.getAutoSwapStatus(), /state unavailable/i);
  });
});
