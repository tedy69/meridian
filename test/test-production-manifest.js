import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("runtime node-fetch fallback is declared directly", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(manifest.dependencies?.["node-fetch"] || "", /^\^?2\./);
});

test("the runtime dependency volume is mounted at a node_modules path", () => {
  const compose = fs.readFileSync(new URL("../compose.yaml", import.meta.url), "utf8");
  const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

  assert.match(compose, /target:\s*\/runtime\/node_modules/);
  assert.match(dockerfile, /\/runtime\/node_modules/);
});
