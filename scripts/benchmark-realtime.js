// Synthetic scheduler benchmark only: no RPC, wallet, order or transaction.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const root = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL("..", import.meta.url));
const { createSpotRealtimeMonitor } = await import(pathToFileURL(path.join(root, "spot-realtime.js")));
const { buildSpotConfig } = await import(pathToFileURL(path.join(root, "config.js")));
const policy = buildSpotConfig({});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let accountCallback;
let complete = 0;
const monitor = createSpotRealtimeMonitor({
  connection: {
    onAccountChange: (_key, callback) => { accountCallback = callback; return 1; },
    removeAccountChangeListener: async () => {},
  },
  getPosition: () => ({ pool: "11111111111111111111111111111111", status: "open" }),
  onRefresh: async () => { await wait(25); complete += 1; },
  eventDebounceMs: policy.realtimeEventDebounceMs,
  minRefreshMs: policy.realtimeMinRefreshMs,
  fallbackIntervalMs: 60_000,
  logger: () => {},
});
async function untilComplete(count) {
  const deadline = Date.now() + 2_000;
  while (complete < count) {
    if (Date.now() > deadline) throw new Error("Synthetic benchmark timed out");
    await wait(2);
  }
}
try {
  await monitor.start();
  await untilComplete(1);
  for (let sample = 0; sample < 12; sample += 1) {
    const target = complete + 1;
    // Same three-event burst, same simulated 25ms read on both revisions.
    for (let event = 0; event < 3; event += 1) accountCallback({}, { slot: sample * 3 + event });
    await untilComplete(target);
  }
  const telemetry = monitor.getTelemetry();
  console.log(JSON.stringify({
    kind: "synthetic scheduler; excludes provider and transaction latency",
    debounceMs: policy.realtimeEventDebounceMs,
    minRefreshMs: policy.realtimeMinRefreshMs,
    websocketEvents: telemetry.websocket_events,
    refreshRuns: telemetry.refresh_runs,
    latencyMs: telemetry.latency_ms,
  }, null, 2));
} finally {
  await monitor.stop();
}
