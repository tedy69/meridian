import { AsyncLocalStorage } from "node:async_hooks";
import { getProviderBudget } from "./provider-budget.js";

const readContext = new AsyncLocalStorage();

export function assertReadActive() {
  readContext.getStore()?.throwIfAborted();
}

/** Only wrap reads. Never race a signer, submission, settlement, or transaction lock. */
export async function withReadDeadline(read, { timeoutMs = 10_000, signal, label = "Market read" } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Read timeout must be positive and finite");
  const controller = new AbortController();
  const parents = [...new Set([signal, readContext.getStore()].filter(Boolean))];
  let timer;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const cancel = (reason) => {
    if (controller.signal.aborted) return;
    const error = reason instanceof Error ? reason : new Error(`${label} aborted`);
    controller.abort(error);
    rejectAbort(error);
  };
  const listeners = parents.map((parent) => {
    const listener = () => cancel(parent.reason);
    parent.addEventListener("abort", listener, { once: true });
    if (parent.aborted) listener();
    return [parent, listener];
  });
  timer = setTimeout(() => cancel(Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), {
    code: "READ_TIMEOUT",
  })), timeoutMs);
  try {
    const pending = readContext.run(controller.signal, async () => {
      controller.signal.throwIfAborted();
      const result = await read({ signal: controller.signal });
      controller.signal.throwIfAborted();
      return result;
    });
    return await Promise.race([pending, aborted]);
  } finally {
    clearTimeout(timer);
    for (const [parent, listener] of listeners) parent.removeEventListener("abort", listener);
  }
}

/** Deadline covers headers AND body consumption; HTTP status errors omit URLs. */
export function readJson(url, options = {}, { timeoutMs = 4_000, label = "Market API", priority = "entry" } = {}) {
  if (options.method && options.method.toUpperCase() !== "GET") throw new Error("readJson only accepts GET requests");
  return withReadDeadline(async ({ signal }) => {
    const budget = getProviderBudget(url);
    const permit = await budget.acquire({ priority, signal });
    // Abort must release admission even if a broken transport ignores signal.
    signal.addEventListener("abort", permit.release, { once: true });
    try {
      signal.throwIfAborted();
      const response = await fetch(url, { ...options, signal });
      signal.throwIfAborted();
      permit.observe(response);
      // Headers establish quota ownership. Do not hold an exit behind a slow
      // discovery response body; its existing read deadline still covers JSON.
      permit.release();
      if (!response.ok) throw Object.assign(new Error(`${label} HTTP ${response.status}`), {
        status: response.status,
        retryAfter: response.headers?.get?.("retry-after"),
        retryAt: response.status === 429 ? budget.snapshot().blockedUntil : undefined,
      });
      return await response.json();
    } finally {
      signal.removeEventListener("abort", permit.release);
      permit.release();
    }
  }, { timeoutMs, label, signal: options.signal });
}

/** Solana SDK transport: bound reads, but leave submission semantics to execution guards. */
export function boundedRpcFetch(url, options = {}) {
  let method;
  try { method = JSON.parse(options.body).method; } catch { /* not a recognized RPC read */ }
  if (typeof method !== "string" || !(/^(get[A-Z]|isBlockhashValid$)/.test(method) || method === "simulateTransaction")) {
    return fetch(url, options);
  }
  return withReadDeadline(async ({ signal }) => {
    const response = await fetch(url, { ...options, signal });
    const body = await response.arrayBuffer();
    return new Response([204, 205, 304].includes(response.status) ? null : body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  }, { timeoutMs: 5_000, signal: options.signal, label: "Solana RPC read" });
}
