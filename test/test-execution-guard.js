import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAutonomousSwapAllowed,
  assertLiveTradingEnabled,
  SOL_MINT,
} from "../execution-guard.js";

test("dry-run operations do not need a live-trading acknowledgement", () => {
  assert.doesNotThrow(() => {
    assertLiveTradingEnabled("deploy_position", { DRY_RUN: "true" });
  });
});

test("live operations require an explicit acknowledgement", () => {
  assert.throws(
    () => assertLiveTradingEnabled("deploy_position", { DRY_RUN: "false" }),
    /LIVE_TRADING_ENABLED=true/,
  );
  assert.throws(
    () => assertLiveTradingEnabled("deploy_position", {
      DRY_RUN: "false",
      LIVE_TRADING_ENABLED: "false",
    }),
    /LIVE_TRADING_ENABLED=true/,
  );
  assert.doesNotThrow(() => {
    assertLiveTradingEnabled("deploy_position", {
      DRY_RUN: "false",
      LIVE_TRADING_ENABLED: "true",
    });
  });
});

test("autonomous swaps can only sell a token back to SOL", () => {
  assert.doesNotThrow(() => {
    assertAutonomousSwapAllowed({
      inputMint: "TokenMint111111111111111111111111111111111",
      outputMint: SOL_MINT,
      amount: 1.25,
    });
  });

  assert.throws(
    () => assertAutonomousSwapAllowed({ inputMint: SOL_MINT, outputMint: "TokenMint", amount: 1 }),
    /SOL.*token/i,
  );
  assert.throws(
    () => assertAutonomousSwapAllowed({ inputMint: "TokenMint", outputMint: "OtherMint", amount: 1 }),
    /output must be SOL/i,
  );
  assert.throws(
    () => assertAutonomousSwapAllowed({ inputMint: "TokenMint", outputMint: SOL_MINT, amount: 0 }),
    /positive finite amount/i,
  );
});
