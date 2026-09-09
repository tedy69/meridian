import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { evaluateAutoSwapBalance, reconcileCloseResidual, isSettlementRetryDue } from "../close-settlement.js";
import { getFinalizedCloseProof } from "../tools/wallet.js";
import { SOLANA_MAINNET_GENESIS_HASH } from "../execution-guard.js";

// Run the production drain without initializing a daemon, signer or live state.
const source = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
const start = source.indexOf("const sleep = (ms)");
const end = source.indexOf("async function settleCloseToSol", start);
assert.ok(start >= 0 && end > start);
const drainSource = source.slice(start, end).replace("export async function drainPendingAutoSwaps", "async function drainPendingAutoSwaps");
const balance = { mint: "mint", amount: 1e-9, raw_amount: "1", decimals: 9, source: "rpc-finalized" };

function harness(overrides = {}, entryOverrides = {}) {
  let pending = [{ key: "position:mint", base_mint: "mint", position_address: "position", close_txs: ["signature"], ...entryOverrides }];
  const completions = [];
  const failures = [];
  const dependencies = {
    normalizeMint: (mint) => mint, isDryRun: () => false, log: () => {},
    config: { tokens: { SOL: "sol" }, management: { autoSwapRetryAttempts: 3, autoSwapRetryDelayMs: 1 } },
    evaluateAutoSwapBalance, reconcileCloseResidual, isSettlementRetryDue,
    getPendingAutoSwaps: () => pending,
    getTokenBalanceByMint: async () => balance,
    getFinalizedCloseProof: async () => ({ transactionFinalized: true, positionAccountPresent: false }),
    getSettlementDustPrice: async () => ({ mint: "mint", usdPrice: 0.0023, updatedAt: new Date().toISOString() }),
    swapToken: () => assert.fail("a retained atomic residual must not call a swap"),
    completePendingAutoSwap: (key, result) => { completions.push({ key, result }); pending = []; },
    recordPendingAutoSwapAttempt: (key, error) => failures.push({ key, error }),
    ...overrides,
  };
  const run = new Function(...Object.keys(dependencies), `${drainSource}; return drainPendingAutoSwaps;`)(...Object.values(dependencies));
  return { run, completions, failures };
}

test("production queue drain records proof of retained dust and performs no swap", async () => {
  const run = harness();
  const result = await run.run();
  assert.equal(result.pending, 0);
  assert.equal(result.settled, 1);
  assert.equal(run.completions[0].result.settlement_status, "settled_dust_remaining");
  assert.equal(run.completions[0].result.residual.raw_amount, "1");
  assert.equal(run.failures.length, 0);
});

test("production queue drain makes only one failed attempt before persisting retry work", async () => {
  let swaps = 0;
  const run = harness({
    getTokenBalanceByMint: async () => ({ ...balance, raw_amount: "1000000", amount: 0.001 }),
    swapToken: async () => { swaps++; return { success: false, error: "No route" }; },
  });
  const result = await run.run();
  assert.equal(result.pending, 1);
  assert.equal(swaps, 1);
  assert.equal(run.failures.length, 1);
});

test("dry runs and scheduled retry deferrals stop before RPC reads or swaps", async () => {
  const rejectRead = () => assert.fail("no RPC call should occur");
  const dry = harness({ isDryRun: () => true, getTokenBalanceByMint: rejectRead });
  assert.equal((await dry.run()).skipped, "dry_run");
  const deferred = harness({ getTokenBalanceByMint: rejectRead }, { next_attempt_at: new Date(Date.now() + 60000).toISOString() });
  assert.equal((await deferred.run()).processed, 0);
});

test("close proof checks all signatures and an account snapshot no older than the close slot", async () => {
  const entry = { position_address: "So11111111111111111111111111111111111111112", close_txs: ["close"] };
  let accountRead = false;
  const connection = {
    getGenesisHash: async () => SOLANA_MAINNET_GENESIS_HASH,
    getSignatureStatuses: async (signatures, options) => {
      assert.deepEqual(signatures, entry.close_txs);
      assert.equal(options.searchTransactionHistory, true);
      return { value: [{ confirmationStatus: "finalized", err: null, slot: 100 }] };
    },
    getAccountInfoAndContext: async (_address, options) => {
      accountRead = true;
      assert.deepEqual(options, { commitment: "finalized", minContextSlot: 100 });
      return { value: null, context: { slot: 101 } };
    },
  };
  assert.equal((await getFinalizedCloseProof(entry, { connection })).positionAccountPresent, false);
  assert.equal(accountRead, true);
  accountRead = false;
  connection.getSignatureStatuses = async () => ({ value: [{ confirmationStatus: "confirmed", err: null, slot: 100 }] });
  assert.equal((await getFinalizedCloseProof(entry, { connection })).transactionFinalized, false);
  assert.equal(accountRead, false);
});
