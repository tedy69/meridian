import fs from "node:fs";

const clean = (value) => String(value ?? "").replace(/https?:\/\/\S+/g, "[URL]").slice(0, 240);

export function createRuntimeHealth({ now = Date.now, write = () => {} } = {}) {
  const state = { version: 1, pid: process.pid, heartbeatAt: null, startedAt: null,
    scanner: { enabled: false, phase: "paused", lastCompletedAt: null, consecutiveErrors: 0 } };
  const save = () => write(structuredClone(state));
  return {
    start({ monitorScanner = true, maxScanAgeMs = 60_000 } = {}) {
      state.startedAt ??= now();
      state.heartbeatAt = now();
      Object.assign(state.scanner, { enabled: monitorScanner, maxScanAgeMs });
      if (state.scanner.phase === "paused") {
        Object.assign(state.scanner, { phase: "idle", phaseStartedAt: now(), lastCompletedAt: now() });
      }
      save();
    },
    heartbeat() { state.heartbeatAt = now(); save(); },
    stage(phase, detail = "") {
      Object.assign(state.scanner, { phase, detail: clean(detail), phaseStartedAt: now() });
      save();
    },
    complete(status, reason = "") {
      Object.assign(state.scanner, { phase: "idle", lastCompletedAt: now(), status, reason: clean(reason),
        consecutiveErrors: status === "error" ? state.scanner.consecutiveErrors + 1 : 0 });
      save();
    },
    skipped(reason) {
      // A timer firing is not proof that its previous scan made progress.
      Object.assign(state.scanner, { lastTickAt: now(), skipped: clean(reason) });
      save();
    },
    pause() {
      state.scanner.enabled = false;
      if (!["executing", "reading"].includes(state.scanner.phase)) state.scanner.phase = "paused";
      save();
    },
    snapshot() { return structuredClone(state); },
  };
}

export function evaluateRuntimeHealth(state, now = Date.now()) {
  const fail = (reason) => ({ healthy: false, reason });
  if (state?.version !== 1 || !Number.isFinite(state.heartbeatAt)) return fail("Runtime heartbeat unavailable");
  if (now - state.heartbeatAt > 30_000 || state.heartbeatAt > now + 5_000) return fail("Runtime heartbeat is stale or invalid");
  const scanner = state.scanner;
  if (!scanner) return fail("Scanner health unavailable");
  if (scanner.phase === "executing") {
    return now - scanner.phaseStartedAt > 180_000
      ? fail("Entry execution is unresolved; inspect reconciliation, never unlock automatically")
      : { healthy: true, reason: "Entry execution in progress" };
  }
  if (!scanner.enabled) return { healthy: true, reason: "Scanner explicitly paused or not monitored in this mode" };
  if (scanner.consecutiveErrors >= 3) return fail("Scanner failed for at least three consecutive cycles");
  const progressAt = scanner.phase === "reading" ? scanner.phaseStartedAt : scanner.lastCompletedAt;
  if (!Number.isFinite(progressAt) || now - progressAt > scanner.maxScanAgeMs || progressAt > now + 5_000) {
    return fail(`Scanner progress is stale (${clean(scanner.detail || scanner.reason || scanner.phase)})`);
  }
  return { healthy: true, reason: "Scanner is progressing" };
}

export function persistRuntimeHealth(filePath, state) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export function readRuntimeHealth(filePath) {
  try {
    const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Number.isInteger(state.pid) || state.pid <= 0) throw new Error("Invalid daemon PID");
    process.kill(state.pid, 0);
    return { ...evaluateRuntimeHealth(state), scanner: state.scanner, heartbeatAt: state.heartbeatAt };
  } catch { return { healthy: false, reason: "Daemon process or runtime health snapshot unavailable" }; }
}
