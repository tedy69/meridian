import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("executor blocks a live deploy before pool checks while close settlement is pending", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-settlement-gate-"));
  const previousStateFile = process.env.MERIDIAN_STATE_FILE;
  const previousDryRun = process.env.DRY_RUN;
  const previousLiveTrading = process.env.LIVE_TRADING_ENABLED;

  process.env.MERIDIAN_STATE_FILE = path.join(directory, "state.json");
  process.env.DRY_RUN = "false";
  process.env.LIVE_TRADING_ENABLED = "true";

  try {
    const state = await import("../state.js");
    const { runSafetyChecks } = await import("../tools/executor.js");
    state.queuePendingAutoSwap({
      position_address: "Position11111111111111111111111111111111111",
      base_mint: "BaseMint111111111111111111111111111111111111",
      close_txs: ["finalized-close-signature"],
    });

    const result = await runSafetyChecks("deploy_position", {
      pool_address: "Pool111111111111111111111111111111111111",
      amount_y: 0.1,
    });

    assert.equal(result.pass, false);
    assert.match(result.reason, /confirmed-close settlement/i);
  } finally {
    restoreEnv("MERIDIAN_STATE_FILE", previousStateFile);
    restoreEnv("DRY_RUN", previousDryRun);
    restoreEnv("LIVE_TRADING_ENABLED", previousLiveTrading);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
