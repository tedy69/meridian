import assert from "node:assert/strict";
import test from "node:test";
import { getTradingStatus, formatTradingStatus } from "../tools/trading-status.js";

test("status distinguishes a provider outage, pending conversion and retained dust", () => {
  const text = formatTradingStatus({ mode: "hybrid", health: { healthy: true, ready: false, status: "degraded", reason: "Spot feed unavailable" },
    risk: { pending_settlements: [{ base_mint: "TOKEN", last_observed_amount: 2, next_attempt_at: "retry-time", last_error: "No route" }],
      residual_settlements: [{ base_mint: "DUST", residual: { raw_amount: "1", observed_at: "proof-time" } }] } });
  assert.match(text, /Scanner: degraded/);
  assert.match(text, /Trading ready: false/);
  assert.match(text, /Pending LP settlements: 1/);
  assert.match(text, /TOKEN.*retry-time.*No route/);
  assert.match(text, /Retained dust: DUST.*1 atomic unit.*not converted to SOL/);
});

test("trading status exposes stalled screening even when both positions are empty", async () => {
  const result = await getTradingStatus({}, { getLp: async () => ({ total_positions: 0, positions: [] }),
    getSpot: async () => ({ position: null, status: "none" }), getRisk: () => ({ mode: "hybrid" }),
    getHealth: () => ({ healthy: false, reason: "Scanner progress is stale" }) });
  assert.match(formatTradingStatus(result), /Scanner: unhealthy.*stale/i);
});

test("an LP API error with zero-valued fields is displayed as unknown exposure", async () => {
  const result = await getTradingStatus({}, { getLp: async () => ({ total_positions: 0, positions: [], error: "RPC unavailable" }),
    getSpot: async () => ({ position: null, status: "none" }), getRisk: () => ({ mode: "hybrid" }) });
  assert.equal(result.total_open_positions, null);
  assert.match(formatTradingStatus(result), /LP: unknown/);
});

test("no spot position does not hide an open LP position", async () => {
  const result = await getTradingStatus({}, { getLp: async () => ({ total_positions: 1, positions: [{ position: "lp1", pair: "MEME-SOL" }] }),
    getSpot: async () => ({ position: null, status: "none" }), getRisk: () => ({ mode: "hybrid" }) });
  assert.equal(result.total_open_positions, 1);
  assert.match(formatTradingStatus(result), /Spot: none/);
  assert.match(formatTradingStatus(result), /LP: 1/);
});
test("missing LP state is unknown, never zero, while spot remains visible", async () => {
  const result = await getTradingStatus({}, { getLp: async () => { throw new Error("RPC offline"); },
    getSpot: async () => ({ position: { symbol: "MEME", venue: "orca", status: "open" }, priceable: false, reason: "quote stale" }),
    getRisk: () => ({ mode: "hybrid" }) });
  assert.equal(result.total_open_positions, null);
  assert.match(formatTradingStatus(result), /LP: unknown/);
  assert.match(formatTradingStatus(result), /MEME.*orca/);
  assert.match(formatTradingStatus(result), /quote stale/);
});
