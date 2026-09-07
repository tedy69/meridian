import fs from "node:fs";
import path from "node:path";
import { repoPath } from "../repo-root.js";
import { replaySpotExits, summarizeSpotPerformance } from "../spot-performance.js";

// No wallet loading, network, signing, state writes, or automatic strategy tuning.
try {
  const [flag, inputPath, ...extra] = process.argv.slice(2);
  if (extra.length || (flag && !["--state", "--replay"].includes(flag)) || (flag && !inputPath)) {
    throw new Error("Usage: npm run evaluate:spot -- [--state <spot-state.json> | --replay <quotes.json>]");
  }
  const data = JSON.parse(fs.readFileSync(inputPath ? path.resolve(inputPath) : repoPath("spot-state.json"), "utf8"));
  if (flag !== "--replay" && !Array.isArray(data.history)) throw new Error("Expected a spot state file containing history");
  console.log(JSON.stringify(flag === "--replay" ? replaySpotExits(data) : summarizeSpotPerformance(data.history), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
