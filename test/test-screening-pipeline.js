import assert from "node:assert/strict";
import test from "node:test";
import { runScreeningPipeline, queueScreeningAfterManagement } from "../screening-pipeline.js";

async function settleWithin(promise, ms = 300) {
  let watchdog;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("Regression probe did not settle")), ms);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

test("a hung screening read is aborted at its deadline without executing an entry", { timeout: 1_000 }, async () => {
  let readSignal;
  let executions = 0;
  const pending = runScreeningPipeline({
    timeoutMs: 20,
    read: (options) => {
      readSignal = options?.signal;
      return new Promise(() => {});
    },
    execute: async () => { executions += 1; },
  });

  await assert.rejects(settleWithin(pending), /timeout|timed out|deadline/i);
  assert.ok(readSignal instanceof AbortSignal);
  assert.equal(readSignal.aborted, true);
  assert.equal(executions, 0);
});

test("a timed-out read cannot execute a late selection or prevent an independent screening run", { timeout: 1_000 }, async () => {
  let finishOldRead;
  const executedPools = [];
  const execute = async (result) => {
    executedPools.push(result.selected.candidate.pool);
    return { submitted: true };
  };
  const oldPending = runScreeningPipeline({
    timeoutMs: 20,
    read: () => new Promise((resolve) => { finishOldRead = resolve; }),
    execute,
  });
  await assert.rejects(settleWithin(oldPending), /timeout|timed out|deadline/i);

  const freshRead = { selected: { strategy: "spot", candidate: { pool: "fresh" } } };
  const freshResult = await settleWithin(runScreeningPipeline({
    timeoutMs: 20,
    read: async () => freshRead,
    execute,
  }));
  assert.deepEqual(freshResult, { ...freshRead, execution: { submitted: true } });

  finishOldRead({ selected: { strategy: "spot", candidate: { pool: "expired" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(executedPools, ["fresh"], "late read completion must never submit an expired entry");
});

test("selected execution remains pending past the read deadline without aborting, retrying, or releasing its caller guard", { timeout: 1_000 }, async () => {
  const readResult = { selected: { strategy: "lp", candidate: { pool: "qualified" } } };
  let finishExecution;
  const executionWait = new Promise((resolve) => { finishExecution = resolve; });
  let readSignal;
  let executions = 0;
  let busy = false;
  let settled = false;
  const invocation = (async () => {
    busy = true;
    try {
      return await runScreeningPipeline({
        timeoutMs: 20,
        read: async (options) => {
          readSignal = options?.signal;
          return readResult;
        },
        execute: (result) => {
          executions += 1;
          assert.equal(result, readResult, "execution receives the successfully completed read result");
          return executionWait;
        },
      });
    } finally {
      busy = false;
    }
  })();
  const observed = invocation.then(
    (value) => { settled = true; return { status: "fulfilled", value }; },
    (error) => { settled = true; return { status: "rejected", error }; },
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(executions, 1);
    assert.equal(settled, false, "a read deadline must not settle a pending execution");
    assert.equal(busy, true, "the caller's transaction guard stays held until execution settles");
    assert.ok(readSignal instanceof AbortSignal);
    assert.equal(readSignal.aborted, false, "a completed read has no lingering cancellation timer");

    finishExecution({ signature: "confirmed-signature" });
    const outcome = await settleWithin(observed);
    assert.equal(outcome.status, "fulfilled");
    assert.deepEqual(outcome.value, { ...readResult, execution: { signature: "confirmed-signature" } });
    assert.equal(executions, 1);
    assert.equal(busy, false);
  } finally {
    finishExecution({ signature: "test-cleanup" });
  }
});

test("a selected candidate executes exactly once with the completed read result", { timeout: 1_000 }, async () => {
  const readResult = {
    selected: { strategy: "spot", candidate: { pool: "qualified" } },
    diagnostics: { screened: 12 },
  };
  let executions = 0;
  const result = await settleWithin(runScreeningPipeline({
    timeoutMs: 20,
    read: async () => readResult,
    execute: async (input) => {
      executions += 1;
      assert.equal(input, readResult);
      return { signature: "one-submission" };
    },
  }));

  assert.equal(executions, 1);
  assert.deepEqual(result, { ...readResult, execution: { signature: "one-submission" } });
});

test("a completed screening with no candidate preserves its result without executing", { timeout: 1_000 }, async () => {
  const readResult = { selected: null, candidates: [], error: "No eligible momentum" };
  const result = await settleWithin(runScreeningPipeline({
    timeoutMs: 20,
    read: async () => readResult,
    execute: () => assert.fail("there is no candidate to execute"),
  }));

  assert.equal(result, readResult);
  assert.equal(Object.hasOwn(result, "execution"), false);
});

test("management queues screening after its finally block releases the busy flag", { timeout: 1_000 }, async () => {
  let busy = true;
  let calls = 0;
  let finishObservation;
  const observed = new Promise((resolve) => { finishObservation = resolve; });

  try {
    queueScreeningAfterManagement(() => {
      calls += 1;
      finishObservation(busy);
    });
    assert.equal(calls, 0, "screening must not run synchronously under the management guard");
  } finally {
    busy = false;
  }

  assert.equal(await settleWithin(observed), false);
  assert.equal(calls, 1);
});
