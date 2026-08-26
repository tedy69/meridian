export const SOL_MINT = "So11111111111111111111111111111111111111112";

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
