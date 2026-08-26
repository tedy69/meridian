import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

function collectNativeModules(directory, matches = []) {
  if (!fs.existsSync(directory)) return matches;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectNativeModules(entryPath, matches);
    } else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".node")) {
      matches.push(entryPath);
    }
  }
  return matches;
}

/**
 * bigint-buffer 1.1.5 has an unfixed native-addon overflow advisory. Its
 * built-in JavaScript fallback is safe for Meridian's small, infrequent
 * conversions, so production installs must not contain the native binding.
 */
export function findVulnerableBigintBufferNativeBindings(root = REPO_ROOT) {
  return collectNativeModules(path.join(root, "node_modules", "bigint-buffer"));
}

export function assertNoVulnerableBigintBufferNativeBinding(root = REPO_ROOT) {
  const bindings = findVulnerableBigintBufferNativeBindings(root);
  if (bindings.length > 0) {
    throw new Error(
      "Unsafe bigint-buffer native binding detected. Reinstall with npm ci --ignore-scripts, then run npm run postinstall.",
    );
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  assertNoVulnerableBigintBufferNativeBinding();
  console.log("Dependency safety: bigint-buffer JavaScript fallback verified");
}
