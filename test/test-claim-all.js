import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  prepareClaimAll,
  executeClaimAll,
  formatClaimAllOutcome,
  formatClaimAllPreflight,
} from "../claim-all.js";

test("claim-all preflight selects every position with a positive reported fee", () => {
  const plan = prepareClaimAll([
    { position: "PositionA", pair: "AAA-SOL", unclaimed_fees_usd: 1.25 },
    { position: "PositionB", pair: "BBB-SOL", unclaimed_fees_usd: 0 },
    { position: "PositionC", pair: "CCC-SOL", unclaimed_fees_usd: 2.5 },
  ]);

  assert.equal(plan.totalPositions, 3);
  assert.equal(plan.claimable.length, 2);
  assert.deepEqual(plan.claimable.map((position) => position.position), ["PositionA", "PositionC"]);
  assert.equal(plan.totalReportedFees, 3.75);
});

test("claim-all preflight ignores missing positions and invalid fee values", () => {
  const plan = prepareClaimAll([
    { position: "PositionA", pair: "AAA-SOL", unclaimed_fees_usd: "not-a-number" },
    { pair: "BBB-SOL", unclaimed_fees_usd: 2 },
    { position: "PositionC", pair: "CCC-SOL", unclaimed_fees_usd: -1 },
  ]);

  assert.equal(plan.claimable.length, 0);
  assert.equal(plan.totalReportedFees, 0);
});

test("claim-all preflight is read-only and requires an explicit confirmation", () => {
  const plan = prepareClaimAll([
    { position: "PositionA", pair: "AAA-SOL", unclaimed_fees_usd: 1.25 },
  ]);

  const message = formatClaimAllPreflight(plan, { autoSwapAfterClaim: true });

  assert.match(message, /No transaction sent/i);
  assert.match(message, /\/claimall confirm/i);
  assert.match(message, /base-token → SOL settlement will be attempted/i);
});

test("Telegram registers the claim-all command in its command menu", () => {
  const telegramSource = fs.readFileSync(new URL("../telegram.js", import.meta.url), "utf8");

  assert.match(telegramSource, /command: "claimall"/);
});

test("claim-all executes sequentially and stops after the first failed claim", async () => {
  const plan = prepareClaimAll([
    { position: "PositionA", pair: "AAA-SOL", unclaimed_fees_usd: 1 },
    { position: "PositionB", pair: "BBB-SOL", unclaimed_fees_usd: 2 },
    { position: "PositionC", pair: "CCC-SOL", unclaimed_fees_usd: 3 },
  ]);
  const calls = [];

  const outcome = await executeClaimAll(plan.claimable, async ({ position_address }) => {
    calls.push(position_address);
    if (position_address === "PositionB") return { success: false, error: "RPC rejected transaction" };
    return { success: true, txs: ["claim-signature"] };
  });

  assert.deepEqual(calls, ["PositionA", "PositionB"]);
  assert.equal(outcome.attempted, 2);
  assert.equal(outcome.succeeded, 1);
  assert.equal(outcome.failed, 1);
  assert.equal(outcome.stoppedAfterFailure, true);
  assert.equal(outcome.results[1].error, "RPC rejected transaction");
});

test("claim-all outcome reports a stopped run without claiming the remaining positions", async () => {
  const plan = prepareClaimAll([
    { position: "PositionA", pair: "AAA-SOL", unclaimed_fees_usd: 1 },
    { position: "PositionB", pair: "BBB-SOL", unclaimed_fees_usd: 2 },
    { position: "PositionC", pair: "CCC-SOL", unclaimed_fees_usd: 3 },
  ]);
  const outcome = await executeClaimAll(plan.claimable, async ({ position_address }) => (
    position_address === "PositionA"
      ? { success: true, txs: ["claim-signature"] }
      : { success: false, error: "transaction rejected" }
  ));

  const message = formatClaimAllOutcome(outcome, { autoSwapAfterClaim: true });
  assert.match(message, /stopped/i);
  assert.match(message, /1 position\(s\) not attempted/i);
  assert.match(message, /automatic base-token → SOL settlement attempt/i);
});

test("claim-all treats a dry-run claim as non-failing execution", async () => {
  const plan = prepareClaimAll([
    { position: "PositionA", pair: "AAA-SOL", unclaimed_fees_usd: 1 },
  ]);

  const outcome = await executeClaimAll(plan.claimable, async () => ({
    dry_run: true,
    message: "DRY RUN — no transaction sent",
  }));

  assert.equal(outcome.attempted, 1);
  assert.equal(outcome.succeeded, 1);
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.results[0].dryRun, true);
});
