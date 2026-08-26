import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("runtime node-fetch fallback is declared directly", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(manifest.dependencies?.["node-fetch"] || "", /^\^?2\./);
});
