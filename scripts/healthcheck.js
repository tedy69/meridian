import { repoPath } from "../repo-root.js";
import { readRuntimeHealth } from "../runtime-health.js";

try {
  const result = readRuntimeHealth(repoPath("runtime-health.json"));
  console.log(result.reason);
  process.exitCode = result.healthy ? 0 : 1;
} catch {
  console.error("Daemon process or runtime health snapshot unavailable");
  process.exitCode = 1;
}
