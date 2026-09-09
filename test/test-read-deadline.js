import assert from "node:assert/strict";
import test from "node:test";
import * as reads from "../read-deadline.js";
import { Connection, PublicKey } from "@solana/web3.js";

test("a Jupiter rate-limit response stops another endpoint before another HTTP request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("{}", { status: 429, headers: {
      "x-ratelimit-remaining": "-1", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 30),
    } });
  });
  await assert.rejects(reads.readJson("https://api.jup.ag/tokens/v2/toptrending"), /429/);
  await assert.rejects(reads.readJson("https://api.jup.ag/price/v3?ids=mint"), /provider.*reset/i);
  assert.equal(calls, 1, "price and token requests share the same provider quota");
});

test("market body stalls abort the fetch as well as releasing the caller", async (t) => {
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    signal = options.signal;
    return { ok: true, json: () => new Promise(() => {}) };
  });
  await assert.rejects(reads.readJson("https://example.invalid", {}, { timeoutMs: 20 }), /timed out/i);
  assert.equal(signal.aborted, true);
});

test("nested reads receive parent cancellation and cannot start fresh requests after expiry", async (t) => {
  let signal;
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests++;
    signal = options.signal;
    return new Promise(() => {});
  });
  await assert.rejects(reads.withReadDeadline(() => reads.readJson("https://example.invalid"), { timeoutMs: 20 }), /timed out/i);
  assert.equal(signal.aborted, true);
  assert.equal(requests, 1);
});

test("Solana read RPC transport consumes its body inside the cancellation boundary", async (t) => {
  assert.equal(typeof reads.boundedRpcFetch, "function");
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    signal = options.signal;
    return { arrayBuffer: () => new Promise(() => {}) };
  });
  await assert.rejects(reads.withReadDeadline(() => reads.boundedRpcFetch("https://example.invalid", {
    method: "POST", body: JSON.stringify({ method: "getBalance", params: [] }),
  }), { timeoutMs: 20 }), /timed out/i);
  assert.equal(signal.aborted, true);
});

test("RPC submission is not wrapped in the read timeout or retried by read infrastructure", async (t) => {
  assert.equal(typeof reads.boundedRpcFetch, "function");
  let calls = 0;
  const options = { method: "POST", body: JSON.stringify({ method: "sendTransaction", params: [] }) };
  const expected = new Response("confirmed");
  t.mock.method(globalThis, "fetch", async (_url, actual) => {
    calls++;
    assert.equal(actual, options);
    return expected;
  });
  assert.equal(await reads.boundedRpcFetch("https://example.invalid", options), expected);
  assert.equal(calls, 1);
});

test("the bounded read transport remains compatible with the actual Solana SDK", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.method, "getBalance");
    assert.equal(request.params[1].commitment, "finalized");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { context: { slot: 123 }, value: 624545822 } }));
  });
  const connection = new Connection("https://example.invalid", { fetch: reads.boundedRpcFetch });
  assert.equal(await connection.getBalance(new PublicKey("So11111111111111111111111111111111111111112"), "finalized"), 624545822);
});
