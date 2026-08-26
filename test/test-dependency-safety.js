import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertNoVulnerableBigintBufferNativeBinding,
  findVulnerableBigintBufferNativeBindings,
} from "../scripts/dependency-safety.js";

function withTemporaryRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-dependency-safety-"));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("dependency safety rejects a native bigint-buffer binding", () => {
  withTemporaryRoot((root) => {
    const nativeBinding = path.join(
      root,
      "node_modules",
      "bigint-buffer",
      "build",
      "Release",
      "bigint_buffer.node",
    );
    fs.mkdirSync(path.dirname(nativeBinding), { recursive: true });
    fs.writeFileSync(nativeBinding, "test");

    assert.deepEqual(findVulnerableBigintBufferNativeBindings(root), [nativeBinding]);
    assert.throws(
      () => assertNoVulnerableBigintBufferNativeBinding(root),
      /bigint-buffer native binding/i,
    );
  });
});

test("dependency safety also rejects a symbolic native binding", () => {
  withTemporaryRoot((root) => {
    const target = path.join(root, "outside.node");
    const nativeBinding = path.join(
      root,
      "node_modules",
      "bigint-buffer",
      "build",
      "Release",
      "bigint_buffer.node",
    );
    fs.writeFileSync(target, "test");
    fs.mkdirSync(path.dirname(nativeBinding), { recursive: true });
    fs.symlinkSync(target, nativeBinding);

    assert.deepEqual(findVulnerableBigintBufferNativeBindings(root), [nativeBinding]);
    assert.throws(
      () => assertNoVulnerableBigintBufferNativeBinding(root),
      /bigint-buffer native binding/i,
    );
  });
});

test("dependency safety permits the pure-JavaScript bigint-buffer fallback", () => {
  withTemporaryRoot((root) => {
    assert.deepEqual(findVulnerableBigintBufferNativeBindings(root), []);
    assert.doesNotThrow(() => assertNoVulnerableBigintBufferNativeBinding(root));
  });
});
