import assert from "node:assert/strict";
import test from "node:test";
import { getTradingStatus, formatTradingStatus } from "../tools/trading-status.js";

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
