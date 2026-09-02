export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

const mainnetRpcChecks = new WeakMap();

function isTrue(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

export function isDryRun(env = process.env) {
  return isTrue(env.DRY_RUN);
}

/**
 * Prevent an accidentally live process from signing transactions. Mainnet is
 * supported, but it must be deliberately acknowledged in addition to turning
 * off DRY_RUN.
 */
export function assertLiveTradingEnabled(operation, env = process.env) {
  if (isDryRun(env)) return;
  if (isTrue(env.LIVE_TRADING_ENABLED)) return;

  throw new Error(
    `${operation} blocked: set LIVE_TRADING_ENABLED=true only after reviewing your mainnet risk limits.`,
  );
}

/**
 * Fail closed unless the configured RPC proves that it serves Solana mainnet.
 * Endpoint hostnames are not chain identities. Cache only successful checks
 * per connection so a repaired RPC is always checked again after a failure.
 */
export async function assertMainnetRpc(connection, operation) {
  if (!connection || typeof connection.getGenesisHash !== "function") {
    throw new Error(`${operation} blocked: Solana mainnet RPC verification is unavailable.`);
  }

  let check = mainnetRpcChecks.get(connection);
  if (!check) {
    check = Promise.resolve().then(async () => {
      let genesisHash;
      try {
        genesisHash = await connection.getGenesisHash();
      } catch {
        throw new Error(`${operation} blocked: Solana mainnet RPC verification failed.`);
      }
      if (genesisHash !== SOLANA_MAINNET_GENESIS_HASH) {
        throw new Error(`${operation} blocked: Solana mainnet RPC verification failed.`);
      }
    });
    mainnetRpcChecks.set(connection, check);
  }

  try {
    await check;
  } catch (error) {
    mainnetRpcChecks.delete(connection);
    throw error;
  }
}

/**
 * Guard the last irreversible step in every transaction path. Callers must
 * use this immediately before simulation/signing/submission so a process
 * cannot submit a transaction if DRY_RUN changes after an earlier preflight.
 */
export function assertOnChainWriteAllowed(operation, env = process.env) {
  if (isDryRun(env)) {
    throw new Error(`${operation} blocked: DRY_RUN=true; on-chain submission is disabled.`);
  }
  assertLiveTradingEnabled(operation, env);
}

/**
 * A confirmed close is not economically settled until its base token has
 * either been converted to SOL or verified absent. Fail closed in live mode
 * when that state cannot be determined.
 */
export function assertNoPendingCloseSettlement(pendingSettlements, env = process.env) {
  if (isDryRun(env)) return;
  if (!Array.isArray(pendingSettlements)) {
    throw new Error("Cannot verify confirmed-close settlements; refusing to open a new position.");
  }
  if (pendingSettlements.length > 0) {
    throw new Error(
      `Cannot open a new position while ${pendingSettlements.length} confirmed-close settlement(s) still await base→SOL conversion.`,
    );
  }
}

/**
 * The autonomous agent may liquidate a position's base token to SOL, but it
 * must never use SOL to acquire an arbitrary token from model-provided input.
 */
export function assertAutonomousSwapAllowed({ inputMint, outputMint, amount }) {
  if (!inputMint || !outputMint) {
    throw new Error("Autonomous swap requires both input and output mints.");
  }
  if (inputMint === SOL_MINT) {
    throw new Error("Autonomous swap cannot swap SOL into a token.");
  }
  if (outputMint !== SOL_MINT) {
    throw new Error("Autonomous swap output must be SOL.");
  }

  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Autonomous swap requires a positive finite amount.");
  }

  return numericAmount;
}

/**
 * Spot swaps use a dedicated path. A buy is only allowed while spot_momentum
 * mode is active and must use the exact backend-configured SOL size. A
 * risk-reducing sell remains available after a mode change, but can only return
 * the tracked token to SOL. This deliberately does not weaken the generic
 * autonomous swap guard above.
 */
export function assertSpotSwapAllowed({
  mode,
  direction,
  inputMint,
  outputMint,
  amount,
  configuredTradeAmountSol,
  maxTradeAmountSol,
}) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Spot swap requires a positive finite amount.");
  }

  if (direction === "buy") {
    if (mode !== "spot_momentum") {
      throw new Error("Spot buy is blocked unless tradingMode=spot_momentum.");
    }
    if (inputMint !== SOL_MINT || !outputMint || outputMint === SOL_MINT) {
      throw new Error("Spot buy must swap SOL into one validated non-SOL token.");
    }
    const configured = Number(configuredTradeAmountSol);
    const maximum = Number(maxTradeAmountSol);
    if (!Number.isFinite(configured) || configured <= 0 || !Number.isFinite(maximum) || maximum <= 0) {
      throw new Error("Spot buy limits are invalid.");
    }
    if (Math.abs(numericAmount - configured) > 1e-9) {
      throw new Error(`Spot buy amount must equal the backend-configured ${configured} SOL.`);
    }
    if (numericAmount > maximum + 1e-9) {
      throw new Error(`Spot buy amount ${numericAmount} SOL exceeds the ${maximum} SOL hard cap.`);
    }
    return numericAmount;
  }

  if (direction === "sell") {
    if (!inputMint || inputMint === SOL_MINT || outputMint !== SOL_MINT) {
      throw new Error("Spot sell must return one non-SOL token to SOL.");
    }
    return numericAmount;
  }

  throw new Error("Spot swap direction must be buy or sell.");
}
