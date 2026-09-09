import assert from "node:assert/strict";
import test from "node:test";
import { createProviderBudget } from "../provider-budget.js";

const response = (remaining, resetMs, status = 200, retryAfter) => ({ status, headers: new Headers({
  "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(resetMs / 1000),
  ...(retryAfter ? { "retry-after": retryAfter } : {}),
}) });

test("background reads preserve the last two slots for an immediate exit", async () => {
  const budget = createProviderBudget({ now: () => 1000 });
  const initial = await budget.acquire();
  initial.observe(response(2, 10000));
  initial.release();
  await assert.rejects(budget.acquire({ priority: "background" }), (error) => error.status === 429 && error.retryAt === 10050);
  const exit = await budget.acquire({ priority: "critical" });
  assert.equal(budget.snapshot().admitted, 2);
  exit.release();
});

test("an expired sliding-window reset allows one probe, never refills the bucket", async () => {
  let now = 1000;
  const budget = createProviderBudget({ now: () => now });
  const first = await budget.acquire();
  first.observe(response(-1, 10000, 429));
  first.release();
  await assert.rejects(budget.acquire({ priority: "critical" }), { status: 429 });
  now = 10051;
  const probe = await budget.acquire({ priority: "critical" });
  const pending = budget.acquire({ priority: "critical" });
  const rejected = assert.rejects(pending, { status: 429 });
  probe.observe(response(0, 20000));
  probe.release();
  await rejected;
  assert.equal(budget.snapshot().admitted, 2);
});

test("queued exit requests take priority and canceled discovery never calls a provider", async () => {
  const budget = createProviderBudget();
  const held = await budget.acquire();
  const aborted = new AbortController();
  const canceled = budget.acquire({ priority: "background", signal: aborted.signal });
  const rejection = assert.rejects(canceled, /expired/);
  const background = budget.acquire({ priority: "background" });
  const critical = budget.acquire({ priority: "critical" });
  aborted.abort(new Error("expired"));
  await rejection;
  held.release();
  const exit = await critical;
  assert.equal(budget.snapshot().queued, 1);
  exit.release();
  (await background).release();
  assert.equal(budget.snapshot().admitted, 3);
  assert.equal(budget.snapshot().queued, 0);
});

test("Retry-After and server reset both constrain admission without an arbitrary 60-second cap", async () => {
  const budget = createProviderBudget({ now: () => 1000 });
  const permit = await budget.acquire();
  permit.observe(response(0, 10000, 429, "120"));
  permit.release();
  await assert.rejects(budget.acquire(), (error) => error.retryAt === 121000);
});
