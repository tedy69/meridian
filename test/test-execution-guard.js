import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAutonomousSwapAllowed,
  assertMainnetRpc,
  assertNoPendingCloseSettlement,
  assertLiveTradingEnabled,
  SOLANA_MAINNET_GENESIS_HASH,
  SOL_MINT,
} from "../execution-guard.js";
import { simulateThenSendAndConfirmTransaction } from "../tools/dlmm.js";
import { swapToken } from "../tools/wallet.js";

async function withEnv(overrides, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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

test("a live deploy is blocked while confirmed-close settlement remains pending", () => {
  assert.throws(
    () => assertNoPendingCloseSettlement([{ key: "pending-close" }], { DRY_RUN: "false" }),
    /Cannot open a new position while 1 confirmed-close settlement/i,
  );
  assert.doesNotThrow(() => {
    assertNoPendingCloseSettlement([], { DRY_RUN: "false" });
  });
  assert.doesNotThrow(() => {
    assertNoPendingCloseSettlement([{ key: "pending-close" }], { DRY_RUN: "true" });
  });
});

test("dry-run blocks the DLMM sender before simulation or transmission", async () => {
  let simulations = 0;
  let sends = 0;
  const connection = {
    async simulateTransaction() {
      simulations += 1;
      return { value: { err: null, logs: [] } };
    },
    async sendTransaction() {
      sends += 1;
      return "unexpected-signature";
    },
  };

  await withEnv({ DRY_RUN: "true", LIVE_TRADING_ENABLED: "true" }, async () => {
    await assert.rejects(
      () => simulateThenSendAndConfirmTransaction(connection, {}, []),
      /DRY_RUN=true.*on-chain submission is disabled/i,
    );
  });

  assert.equal(simulations, 0);
  assert.equal(sends, 0);
});

test("the complete Solana mainnet genesis hash is accepted", async () => {
  const connection = {
    async getGenesisHash() {
      return SOLANA_MAINNET_GENESIS_HASH;
    },
  };

  await assert.doesNotReject(() => assertMainnetRpc(connection, "runtime startup"));
});

test("a non-mainnet RPC blocks a live DLMM transaction before simulation or transmission", async () => {
  let simulations = 0;
  let sends = 0;
  const connection = {
    async getGenesisHash() {
      return "not-solana-mainnet";
    },
    async simulateTransaction() {
      simulations += 1;
      return { value: { err: null, logs: [] } };
    },
    async sendTransaction() {
      sends += 1;
      return "unexpected-signature";
    },
  };

  await withEnv({ DRY_RUN: "false", LIVE_TRADING_ENABLED: "true" }, async () => {
    await assert.rejects(
      () => simulateThenSendAndConfirmTransaction(connection, {}, []),
      /Solana mainnet RPC verification/i,
    );
  });

  await assert.rejects(
    () => assertMainnetRpc(connection, "DLMM transaction submission"),
    /Solana mainnet RPC verification/i,
  );
  assert.equal(simulations, 0);
  assert.equal(sends, 0);
});

test("dry-run swaps never fetch, sign, or submit a transaction", async () => {
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("network access must not occur in dry-run");
  };

  try {
    await withEnv({ DRY_RUN: "true", LIVE_TRADING_ENABLED: "true" }, async () => {
      const result = await swapToken({
        input_mint: "TokenMint111111111111111111111111111111111",
        output_mint: SOL_MINT,
        amount: 1,
      });
      assert.equal(result.dry_run, true);
      assert.match(result.message, /no transaction sent/i);
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(fetches, 0);
});
