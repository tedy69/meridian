import { blankRealtimeTelemetry, createAccountRealtimeMonitor, getRealtimeMonitorTelemetry } from "./account-realtime.js";

const ACTIVE_STATUSES = new Set(["opening", "open", "closing"]);

export function getSpotRealtimeTelemetry() {
  return getRealtimeMonitorTelemetry().spot ?? blankRealtimeTelemetry();
}

export function createSpotRealtimeMonitor({ getPosition, ...options } = {}) {
  if (typeof getPosition !== "function") throw new Error("Spot realtime monitor requires getPosition");
  return createAccountRealtimeMonitor({
    monitorName: "spot",
    watchLogs: true,
    ...options,
    getAccountAddresses: async () => {
      const position = await getPosition();
      return position?.pool && ACTIVE_STATUSES.has(position.status)
        ? [position.pool, ...(position.watchAccounts || [])] : [];
    },
  });
}
