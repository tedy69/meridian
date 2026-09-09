// Jupiter Token, Price and Swap order share a bucket. Admission is for GETs
// only; never wrap transaction submission, retries or signer ownership here.
export function createProviderBudget({ now = Date.now, reserve = 2, maxPending = 32 } = {}) {
  let active = false;
  let remaining = null;
  let resetAt = 0;
  let blockedUntil = 0;
  let admitted = 0;
  let rejected = 0;
  let rateLimits = 0;
  let lastResponseAt = null;
  const queue = [];
  const ranks = { critical: 2, entry: 1, background: 0 };
  const headerNumber = (headers, name) => {
    const raw = headers?.get?.(name);
    return raw == null || raw === "" || !Number.isFinite(Number(raw)) ? null : Number(raw);
  };
  function observe(response) {
    const current = now();
    lastResponseAt = current;
    const available = headerNumber(response.headers, "x-ratelimit-remaining");
    const reset = headerNumber(response.headers, "x-ratelimit-reset");
    if (available !== null) remaining = available;
    // A reset frees ONE slot, not the entire sliding window. Serialize the
    // probe after reset and learn the next budget from its response.
    if (reset !== null) resetAt = reset * 1000 + 50;
    else if (available !== null && available <= reserve) resetAt = current + 1000;
    if (response.status === 429) {
      rateLimits++;
      const retry = response.headers?.get?.("retry-after");
      const seconds = retry == null || retry === "" ? NaN : Number(retry);
      const retryAt = Number.isFinite(seconds) ? current + seconds * 1000 : Date.parse(retry);
      blockedUntil = Math.max(current + 1000, resetAt, Number.isFinite(retryAt) ? retryAt : 0);
    } else if (available !== null && available <= 0) {
      blockedUntil = Math.max(current + 50, resetAt > current ? resetAt : current + 1000);
    } else {
      blockedUntil = 0;
    }
  }
  function pump() {
    if (active) return;
    queue.sort((a, b) => (ranks[b.priority] ?? 1) - (ranks[a.priority] ?? 1));
    while (queue.length) {
      const request = queue.shift();
      request.signal?.removeEventListener("abort", request.cancel);
      if (request.signal?.aborted) { request.reject(request.signal.reason); continue; }
      const current = now();
      const floor = request.priority === "critical" ? 0 : reserve;
      const retryAt = Math.max(blockedUntil, remaining !== null && remaining <= floor ? resetAt : 0);
      if (retryAt > current) {
        rejected++;
        request.reject(Object.assign(new Error("Provider request deferred until rate-limit reset"), {
          status: 429, code: "PROVIDER_BUDGET_UNAVAILABLE", retryAt,
          retryAfter: Math.ceil((retryAt - current) / 1000),
        }));
        continue;
      }
      active = true;
      admitted++;
      if (remaining !== null) remaining--;
      let released = false;
      request.resolve({ observe, release() {
        if (released) return;
        released = true;
        active = false;
        pump();
      } });
      return;
    }
  }
  return {
    acquire({ priority = "entry", signal } = {}) {
      signal?.throwIfAborted();
      if (queue.length >= maxPending) return Promise.reject(Object.assign(new Error("Provider read capacity reached"), { code: "PROVIDER_CAPACITY" }));
      return new Promise((resolve, reject) => {
        const request = { priority, signal, resolve, reject, cancel() {
          const index = queue.indexOf(request);
          if (index >= 0) queue.splice(index, 1);
          signal.removeEventListener("abort", request.cancel);
          reject(signal.reason);
        } };
        queue.push(request);
        signal?.addEventListener("abort", request.cancel, { once: true });
        pump();
      });
    },
    snapshot() { return { remaining, resetAt, blockedUntil, admitted, rejected, rateLimits, lastResponseAt,
      active, queued: queue.length }; },
  };
}

const budgets = new Map();
export function getProviderBudget(url) {
  const host = new URL(url).hostname;
  if (!budgets.has(host)) budgets.set(host, createProviderBudget({ reserve: host === "api.jup.ag" ? 2 : 0 }));
  return budgets.get(host);
}
export function getProviderBudgetStatus() {
  return Object.fromEntries([...budgets].map(([host, budget]) => [host, budget.snapshot()]));
}
