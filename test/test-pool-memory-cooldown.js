import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../config.js";

async function withTemporaryPoolMemory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-pool-memory-"));
  const previousFile = process.env.MERIDIAN_POOL_MEMORY_FILE;
  const previousCooldownHours = config.management.trailingLossCooldownHours;
  const previousStopLossCooldownHours = config.management.stopLossCooldownHours;
  process.env.MERIDIAN_POOL_MEMORY_FILE = path.join(directory, "pool-memory.json");
  config.management.trailingLossCooldownHours = 12;
  config.management.stopLossCooldownHours = 12;
  try {
    const memory = await import(`../pool-memory.js?cooldown-test=${Date.now()}-${Math.random()}`);
    await callback(memory);
  } finally {
    config.management.trailingLossCooldownHours = previousCooldownHours;
    config.management.stopLossCooldownHours = previousStopLossCooldownHours;
    if (previousFile === undefined) delete process.env.MERIDIAN_POOL_MEMORY_FILE;
    else process.env.MERIDIAN_POOL_MEMORY_FILE = previousFile;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("a losing trailing exit cools down both its pool and base mint", async () => {
  await withTemporaryPoolMemory(async (memory) => {
    const pool = "Pool111111111111111111111111111111111111";
    const baseMint = "Mint111111111111111111111111111111111111";
    memory.recordPoolDeploy(pool, {
      pool_name: "TEST-SOL",
      base_mint: baseMint,
      close_reason: "Trailing TP: peak 3.14% → current 0.11%",
      pnl_pct: -1.22,
    });

    assert.equal(memory.isPoolOnCooldown(pool), true);
    assert.equal(memory.isBaseMintOnCooldown(baseMint), true);
    assert.match(memory.getPoolMemory({ pool_address: pool }).cooldown_reason, /losing trailing exit/i);
  });
});

test("a profitable trailing exit does not create a trailing-loss cooldown", async () => {
  await withTemporaryPoolMemory(async (memory) => {
    const pool = "Pool222222222222222222222222222222222222";
    const baseMint = "Mint222222222222222222222222222222222222";
    memory.recordPoolDeploy(pool, {
      pool_name: "TEST-SOL",
      base_mint: baseMint,
      close_reason: "Trailing TP: peak 4% → current 2%",
      pnl_pct: 1.1,
    });

    assert.equal(memory.isPoolOnCooldown(pool), false);
    assert.equal(memory.isBaseMintOnCooldown(baseMint), false);
  });
});

test("a losing stop-loss exit cools down both its pool and base mint", async () => {
  await withTemporaryPoolMemory(async (memory) => {
    const pool = "Pool333333333333333333333333333333333333";
    const baseMint = "Mint333333333333333333333333333333333333";
    memory.recordPoolDeploy(pool, {
      pool_name: "TEST-SOL",
      base_mint: baseMint,
      close_reason: "Stop loss: PnL -8.53% <= trigger -8%",
      pnl_pct: -6.37,
    });

    assert.equal(memory.isPoolOnCooldown(pool), true);
    assert.equal(memory.isBaseMintOnCooldown(baseMint), true);
    assert.match(memory.getPoolMemory({ pool_address: pool }).cooldown_reason, /stop-loss exit/i);
  });
});

test("a stop-loss that settles profitable does not create a cooldown", async () => {
  await withTemporaryPoolMemory(async (memory) => {
    const pool = "Pool444444444444444444444444444444444444";
    const baseMint = "Mint444444444444444444444444444444444444";
    memory.recordPoolDeploy(pool, {
      pool_name: "TEST-SOL",
      base_mint: baseMint,
      close_reason: "Stop loss: PnL -8.01% <= trigger -8%",
      pnl_pct: 0.2,
    });

    assert.equal(memory.isPoolOnCooldown(pool), false);
    assert.equal(memory.isBaseMintOnCooldown(baseMint), false);
  });
});

test("a zero stop-loss cooldown explicitly permits re-entry", async () => {
  await withTemporaryPoolMemory(async (memory) => {
    const pool = "Pool555555555555555555555555555555555555";
    const baseMint = "Mint555555555555555555555555555555555555";
    const previousCooldownHours = config.management.stopLossCooldownHours;
    config.management.stopLossCooldownHours = 0;
    try {
      memory.recordPoolDeploy(pool, {
        pool_name: "TEST-SOL",
        base_mint: baseMint,
        close_reason: "Stop loss: PnL -8.01% <= trigger -8%",
        pnl_pct: -2,
      });

      assert.equal(memory.isPoolOnCooldown(pool), false);
      assert.equal(memory.isBaseMintOnCooldown(baseMint), false);
    } finally {
      config.management.stopLossCooldownHours = previousCooldownHours;
    }
  });
});
