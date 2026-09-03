import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getExtensionTypes,
  unpackMint,
} from "@solana/spl-token";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import {
  assertAutonomousSwapAllowed,
  assertLiveTradingEnabled,
  assertMainnetRpc,
  assertOnChainWriteAllowed,
  assertSpotSwapAllowed,
  isDryRun,
  SOL_MINT,
} from "../execution-guard.js";
import { normalizeSlippageBps } from "../trailing-safety.js";
import { evaluateSpotRoundTripQuote } from "../spot-momentum.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
export const LEGACY_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID_STRING = TOKEN_2022_PROGRAM_ID.toBase58();
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || "";
}

function requireJupiterApiKey() {
  const apiKey = String(getJupiterApiKey()).trim();
  if (!apiKey) {
    throw new Error("JUPITER_API_KEY is required for Jupiter Price and Swap V2 APIs");
  }
  return apiKey;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

export function deriveAssociatedTokenAddress(owner, mint, tokenProgramId = LEGACY_TOKEN_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([
    owner.toBuffer(),
    new PublicKey(tokenProgramId).toBuffer(),
    new PublicKey(mint).toBuffer(),
  ], new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID))[0];
}

async function mintTokenProgram(connection, mint) {
  const account = await connection.getAccountInfo(new PublicKey(mint), "finalized");
  if (!account) throw new Error(`Token mint ${mint} does not exist at finalized commitment`);
  const programId = account.owner?.toBase58?.() || String(account.owner || "");
  if (![LEGACY_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID_STRING].includes(programId)) {
    throw new Error(`Token mint ${mint} is owned by unsupported program ${programId || "unknown"}`);
  }
  return programId;
}

function tokenRawAmountFromAccount(account) {
  if (!account) return 0n;
  const data = Buffer.isBuffer(account.data)
    ? account.data
    : Array.isArray(account.data) && typeof account.data[0] === "string"
    ? Buffer.from(account.data[0], "base64")
    : null;
  if (!data || data.length < 72) throw new Error("Simulated SPL token account data is invalid");
  return data.readBigUInt64LE(64);
}

function nonNegativeInteger(value, label) {
  const text = String(value ?? "");
  if (!/^[0-9]+$/.test(text)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(text);
}

export function validateSimulatedSwapEffects({
  inputMint,
  outputMint,
  inAmount,
  minimumOutAmount,
  totalFeeLamports,
  walletLamportsBefore,
  walletLamportsAfter,
  inputTokenRawBefore = null,
  inputTokenRawAfter = null,
  outputTokenRawBefore = null,
  outputTokenRawAfter = null,
} = {}) {
  const input = nonNegativeInteger(inAmount, "inAmount");
  const minimumOut = nonNegativeInteger(minimumOutAmount, "minimumOutAmount");
  const fees = nonNegativeInteger(totalFeeLamports, "totalFeeLamports");
  const walletBefore = nonNegativeInteger(walletLamportsBefore, "walletLamportsBefore");
  const walletAfter = nonNegativeInteger(walletLamportsAfter, "walletLamportsAfter");

  if (inputMint === SOL_MINT) {
    const debit = walletBefore - walletAfter;
    if (debit < input) throw new Error("Simulation does not debit the exact requested SOL input");
    if (debit > input + fees) throw new Error("Simulation exceeds the requested SOL input plus bounded transaction fees");
  } else {
    const tokenBefore = nonNegativeInteger(inputTokenRawBefore, "inputTokenRawBefore");
    const tokenAfter = nonNegativeInteger(inputTokenRawAfter, "inputTokenRawAfter");
    if (tokenBefore - tokenAfter !== input) throw new Error("Simulation does not debit the exact requested token input");
  }

  if (outputMint === SOL_MINT) {
    const netCredit = walletAfter - walletBefore;
    if (netCredit + fees < minimumOut) throw new Error("Simulation returns less SOL than the bounded minimum output");
  } else {
    const tokenBefore = nonNegativeInteger(outputTokenRawBefore, "outputTokenRawBefore");
    const tokenAfter = nonNegativeInteger(outputTokenRawAfter, "outputTokenRawAfter");
    if (tokenAfter - tokenBefore < minimumOut) throw new Error("Simulation returns less token output than the bounded minimum");
  }

  return true;
}

async function simulateJupiterTransaction(connection, transaction, {
  walletPublicKey,
  inputMint,
  outputMint,
  inAmount,
  minimumOutAmount,
  totalFeeLamports,
} = {}) {
  const wallet = new PublicKey(walletPublicKey);
  const [inputTokenProgram, outputTokenProgram] = await Promise.all([
    inputMint === SOL_MINT ? null : mintTokenProgram(connection, inputMint),
    outputMint === SOL_MINT ? null : mintTokenProgram(connection, outputMint),
  ]);
  const inputTokenAccount = inputMint === SOL_MINT
    ? null
    : deriveAssociatedTokenAddress(wallet, inputMint, inputTokenProgram);
  const outputTokenAccount = outputMint === SOL_MINT
    ? null
    : deriveAssociatedTokenAddress(wallet, outputMint, outputTokenProgram);
  const addresses = [wallet, inputTokenAccount, outputTokenAccount].filter(Boolean);
  const before = await connection.getMultipleAccountsInfo(addresses, "finalized");
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: true,
    commitment: "confirmed",
    accounts: {
      encoding: "base64",
      addresses: addresses.map((address) => address.toBase58()),
    },
  });
  if (simulation.value.err) {
    const logs = Array.isArray(simulation.value.logs)
      ? simulation.value.logs.slice(-12).join(" | ")
      : "no simulation logs";
    throw new Error(
      `Jupiter swap simulation failed: ${JSON.stringify(simulation.value.err)} (${logs})`,
    );
  }
  const after = simulation.value.accounts;
  if (!Array.isArray(after) || after.length !== addresses.length || !before[0] || !after[0]) {
    throw new Error("Jupiter simulation did not return the required wallet account effects");
  }
  let cursor = 1;
  const inputBefore = inputTokenAccount ? before[cursor] : null;
  const inputAfter = inputTokenAccount ? after[cursor++] : null;
  const outputBefore = outputTokenAccount ? before[cursor] : null;
  const outputAfter = outputTokenAccount ? after[cursor] : null;
  validateSimulatedSwapEffects({
    inputMint,
    outputMint,
    inAmount,
    minimumOutAmount,
    totalFeeLamports,
    walletLamportsBefore: before[0].lamports,
    walletLamportsAfter: after[0].lamports,
    inputTokenRawBefore: inputTokenAccount ? tokenRawAmountFromAccount(inputBefore) : null,
    inputTokenRawAfter: inputTokenAccount ? tokenRawAmountFromAccount(inputAfter) : null,
    outputTokenRawBefore: outputTokenAccount ? tokenRawAmountFromAccount(outputBefore) : null,
    outputTokenRawAfter: outputTokenAccount ? tokenRawAmountFromAccount(outputAfter) : null,
  });
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);
    
    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    return {
      wallet: walletAddress,
      sol: 0,
      sol_price: 0,
      sol_usd: 0,
      usdc: 0,
      tokens: [],
      total_usd: 0,
      error: error.message,
    };
  }
}

/**
 * Read a token balance directly from Solana RPC at finalized commitment.
 *
 * Settlement code must not depend on an indexed portfolio response or a USD
 * price being present: either can lag after a close and incorrectly make an
 * unswapped token look like it no longer exists.
 */
export async function getTokenBalanceByMint(mint) {
  const normalizedMint = normalizeMint(mint);
  const wallet = getWallet();
  const connection = getConnection();

  if (normalizedMint === SOL_MINT) {
    const lamports = await connection.getBalance(wallet.publicKey, "finalized");
    return {
      mint: normalizedMint,
      amount: lamports / LAMPORTS_PER_SOL,
      raw_amount: String(lamports),
      decimals: 9,
      source: "rpc-finalized",
    };
  }

  const response = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    { mint: new PublicKey(normalizedMint) },
    "finalized",
  );
  let rawAmount = 0n;
  let decimals = null;
  for (const account of response.value || []) {
    const tokenAmount = account.account?.data?.parsed?.info?.tokenAmount;
    if (!tokenAmount?.amount) continue;
    const accountDecimals = Number(tokenAmount.decimals);
    if (!Number.isInteger(accountDecimals) || accountDecimals < 0) {
      throw new Error(`Invalid decimals returned for token ${normalizedMint}`);
    }
    decimals = decimals ?? accountDecimals;
    if (decimals !== accountDecimals) {
      throw new Error(`Inconsistent token decimals returned for ${normalizedMint}`);
    }
    rawAmount += BigInt(String(tokenAmount.amount));
  }

  const resolvedDecimals = decimals ?? 0;
  const rawText = rawAmount.toString();
  const padded = rawText.padStart(resolvedDecimals + 1, "0");
  const amountText = resolvedDecimals === 0
    ? padded
    : `${padded.slice(0, -resolvedDecimals)}.${padded.slice(-resolvedDecimals)}`;
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid token balance returned for ${normalizedMint}`);
  }

  return {
    mint: normalizedMint,
    amount,
    raw_amount: rawText,
    decimals: resolvedDecimals,
    source: "rpc-finalized",
  };
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

function atomicAmount(amount, decimals) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error("Swap amount must be a positive finite number");
  const scaled = Math.floor(numeric * Math.pow(10, decimals));
  if (!Number.isSafeInteger(scaled) || scaled <= 0) throw new Error("Swap amount is outside the safe atomic-unit range");
  return String(scaled);
}

async function mintDecimals(connection, mint) {
  if (mint === SOL_MINT) return 9;
  const mintInfo = await connection.getParsedAccountInfo(new PublicKey(mint), "finalized");
  const decimals = Number(mintInfo.value?.data?.parsed?.info?.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Could not verify decimals for token ${mint}`);
  }
  return decimals;
}

function integerString(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value) && BigInt(value) > 0n;
}

export function validateJupiterQuote(order, {
  inputMint,
  outputMint,
  inAmount,
  maxSlippageBps = null,
  maxPriceImpactPct = null,
  maxFeeBps = null,
} = {}) {
  if (!order || typeof order !== "object") throw new Error("Jupiter quote is missing");
  if (order.errorCode || order.errorMessage || order.error) {
    throw new Error(`Jupiter quote error: ${order.errorMessage || order.error || order.errorCode}`);
  }
  if (order.swapMode !== "ExactIn") throw new Error("Jupiter quote must use ExactIn mode");
  if (order.inputMint !== inputMint || order.outputMint !== outputMint) {
    throw new Error("Jupiter quote mint pair does not match the requested swap");
  }
  if (String(order.inAmount) !== String(inAmount)) throw new Error("Jupiter quote input amount does not match the requested swap");
  if (!integerString(String(order.outAmount || ""))) throw new Error("Jupiter quote output amount is invalid");
  if (!integerString(String(order.otherAmountThreshold || ""))) throw new Error("Jupiter quote minimum output is required");
  if (BigInt(String(order.otherAmountThreshold)) > BigInt(String(order.outAmount))) {
    throw new Error("Jupiter quote minimum output exceeds its expected output");
  }
  const slippage = Number(order.slippageBps);
  if (!Number.isFinite(slippage) || slippage < 0 || (maxSlippageBps != null && slippage > Number(maxSlippageBps))) {
    throw new Error(`Jupiter quote slippage ${order.slippageBps ?? "unknown"} bps exceeds ${maxSlippageBps} bps`);
  }
  const impact = Number(order.priceImpact);
  if (maxPriceImpactPct != null && (!Number.isFinite(impact) || Math.abs(impact) > Number(maxPriceImpactPct))) {
    throw new Error(`Jupiter quote price impact ${order.priceImpact ?? "unknown"}% exceeds ${maxPriceImpactPct}%`);
  }
  const feeBps = Number(order.feeBps);
  if (!Number.isFinite(feeBps) || feeBps < 0 || (maxFeeBps != null && feeBps > Number(maxFeeBps))) {
    throw new Error(`Jupiter quote fee ${order.feeBps ?? "unknown"} bps exceeds ${maxFeeBps} bps`);
  }
  if (feeBps > 0 && order.feeMint !== inputMint && order.feeMint !== outputMint) {
    throw new Error("Jupiter quote fee mint is not part of the requested pair");
  }
  return {
    outAmount: String(order.outAmount),
    minimumOutAmount: String(order.otherAmountThreshold),
    priceImpactPct: impact,
    feeBps,
    router: String(order.router || "unknown"),
    mode: String(order.mode || "unknown"),
  };
}

export function validateJupiterOrder(order, {
  inputMint,
  outputMint,
  inAmount,
  expectedTaker = null,
  allowedRouters = null,
  requireTakerPaysFees = false,
  maxSlippageBps = null,
  maxPriceImpactPct = null,
  maxFeeBps = null,
  maxPriorityFeeLamports = null,
  maxTotalFeeLamports = null,
  minimumNetOutputLamports = null,
  requestedAt = Date.now(),
  now = Date.now(),
  quoteMaxAgeMs = null,
} = {}) {
  if (!order || typeof order !== "object") throw new Error("Jupiter order is missing");
  if (order.errorCode || order.errorMessage || order.error) {
    throw new Error(`Jupiter order error: ${order.errorMessage || order.error || order.errorCode}`);
  }
  if (!order.transaction || !order.requestId) throw new Error("Jupiter order is not executable");
  if (order.swapMode !== "ExactIn") throw new Error("Jupiter order must use ExactIn mode");
  if (expectedTaker != null && order.taker !== expectedTaker) {
    throw new Error("Jupiter order taker does not match the signing wallet");
  }
  const router = String(order.router || "").trim().toLowerCase();
  if (Array.isArray(allowedRouters) && !allowedRouters.map((value) => String(value).toLowerCase()).includes(router)) {
    throw new Error(`Jupiter order router ${order.router || "unknown"} is not allowed`);
  }
  if (Array.isArray(allowedRouters) && (!integerString(String(order.lastValidBlockHeight || "")))) {
    throw new Error("Jupiter aggregator order requires a valid lastValidBlockHeight");
  }
  if (order.inputMint !== inputMint || order.outputMint !== outputMint) {
    throw new Error("Jupiter order mint pair does not match the requested swap");
  }
  if (String(order.inAmount) !== String(inAmount)) throw new Error("Jupiter order input amount does not match the requested swap");
  if (!integerString(String(order.outAmount || ""))) throw new Error("Jupiter order output amount is invalid");
  if (!integerString(String(order.otherAmountThreshold || ""))) throw new Error("Jupiter order minimum output is required");
  if (BigInt(String(order.otherAmountThreshold)) > BigInt(String(order.outAmount))) {
    throw new Error("Jupiter order minimum output exceeds its expected output");
  }

  const slippage = Number(order.slippageBps);
  if (!Number.isFinite(slippage) || slippage < 0 || (maxSlippageBps != null && slippage > Number(maxSlippageBps))) {
    throw new Error(`Jupiter order slippage ${order.slippageBps ?? "unknown"} bps exceeds ${maxSlippageBps} bps`);
  }
  const impact = Number(order.priceImpact);
  if (maxPriceImpactPct != null && (!Number.isFinite(impact) || Math.abs(impact) > Number(maxPriceImpactPct))) {
    throw new Error(`Jupiter order price impact ${order.priceImpact ?? "unknown"}% exceeds ${maxPriceImpactPct}%`);
  }
  const feeBps = Number(order.feeBps);
  if (!Number.isFinite(feeBps) || feeBps < 0 || (maxFeeBps != null && feeBps > Number(maxFeeBps))) {
    throw new Error(`Jupiter order fee ${order.feeBps ?? "unknown"} bps exceeds ${maxFeeBps} bps`);
  }
  if (feeBps > 0 && order.feeMint !== inputMint && order.feeMint !== outputMint) {
    throw new Error("Jupiter order fee mint is not part of the requested pair");
  }
  const transactionFees = [order.signatureFeeLamports, order.prioritizationFeeLamports, order.rentFeeLamports]
    .map(Number);
  const requiresTransactionFeeBreakdown = maxTotalFeeLamports != null || minimumNetOutputLamports != null;
  if (requiresTransactionFeeBreakdown && transactionFees.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Jupiter order transaction fee breakdown is missing or invalid");
  }
  const priorityFeeLamports = Number(order.prioritizationFeeLamports);
  if (maxPriorityFeeLamports != null && (!Number.isFinite(priorityFeeLamports) || priorityFeeLamports < 0 || priorityFeeLamports > Number(maxPriorityFeeLamports))) {
    throw new Error(`Jupiter order priority fee ${order.prioritizationFeeLamports ?? "unknown"} lamports exceeds ${maxPriorityFeeLamports}`);
  }
  const totalFeeLamports = transactionFees
    .reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  if (requiresTransactionFeeBreakdown && !Number.isSafeInteger(totalFeeLamports)) {
    throw new Error("Jupiter order total transaction fee is outside the safe integer range");
  }
  if (maxTotalFeeLamports != null && totalFeeLamports > Number(maxTotalFeeLamports)) {
    throw new Error(`Jupiter order transaction fees ${totalFeeLamports} lamports exceed ${maxTotalFeeLamports}`);
  }
  let minimumNetOutputAmount = null;
  if (minimumNetOutputLamports != null) {
    if (outputMint !== SOL_MINT) {
      throw new Error("Jupiter net output floor is only supported for SOL output");
    }
    const requiredNetOutput = nonNegativeInteger(minimumNetOutputLamports, "minimumNetOutputLamports");
    const grossMinimumOutput = BigInt(String(order.otherAmountThreshold));
    const transactionFeeAmount = BigInt(totalFeeLamports);
    if (grossMinimumOutput < transactionFeeAmount) {
      throw new Error("Jupiter order net output floor cannot be met after transaction fees");
    }
    const netMinimumOutput = grossMinimumOutput - transactionFeeAmount;
    if (netMinimumOutput < requiredNetOutput) {
      throw new Error(`Jupiter order net output floor ${netMinimumOutput} lamports is below required ${requiredNetOutput} lamports`);
    }
    minimumNetOutputAmount = netMinimumOutput.toString();
  }
  if (requireTakerPaysFees) {
    if (!expectedTaker) throw new Error("Expected taker is required to validate Jupiter fee payers");
    if (order.gasless === true) throw new Error("Jupiter gasless orders are not allowed for autonomous spot execution");
    const payerChecks = [
      [transactionFees[0], order.signatureFeePayer, "signature"],
      [transactionFees[1], order.prioritizationFeePayer, "priority"],
      [transactionFees[2], order.rentFeePayer, "rent"],
    ];
    for (const [fee, payer, label] of payerChecks) {
      if (Number.isFinite(fee) && fee > 0 && payer !== expectedTaker) {
        throw new Error(`Jupiter ${label} fee payer does not match the signing wallet`);
      }
    }
  }
  if (quoteMaxAgeMs != null && now - requestedAt > Number(quoteMaxAgeMs)) {
    throw new Error(`Jupiter order is older than ${quoteMaxAgeMs}ms`);
  }
  if (order.expireAt) {
    const expiresAt = Date.parse(order.expireAt);
    if (!Number.isFinite(expiresAt) || now >= expiresAt) throw new Error("Jupiter RFQ order is expired");
  }

  return {
    outAmount: String(order.outAmount),
    minimumOutAmount: String(order.otherAmountThreshold),
    priceImpactPct: impact,
    feeBps,
    totalFeeLamports,
    minimumNetOutputAmount,
  };
}

export function validateJupiterExecutionResult(result, {
  expectedSignature,
  inAmount,
  minimumOutAmount,
} = {}) {
  if (!result || typeof result !== "object") throw new Error("Jupiter execution result is missing");
  if (result.status !== "Success" || Number(result.code) !== 0 || !result.signature) {
    throw new Error(`Swap failed: status=${result.status ?? "unknown"} code=${result.code ?? "unknown"} ${result.error || ""}`.trim());
  }
  if (result.signature !== expectedSignature) {
    throw new Error("Jupiter execution signature does not match the locally signed transaction");
  }
  const inputAmount = String(result.totalInputAmount ?? result.inputAmountResult ?? "");
  const outputAmount = String(result.totalOutputAmount ?? result.outputAmountResult ?? "");
  if (!integerString(inputAmount) || inputAmount !== String(inAmount)) {
    throw new Error("Jupiter execution input amount does not match the exact requested input");
  }
  if (!integerString(outputAmount) || BigInt(outputAmount) < BigInt(String(minimumOutAmount))) {
    throw new Error("Jupiter execution output amount is below the bounded minimum output");
  }
  return { inputAmount, outputAmount, signature: result.signature };
}

export function validateJupiterTransactionEnvelope(transaction, expectedFeePayer) {
  const feePayer = transaction?.message?.staticAccountKeys?.[0]?.toBase58?.();
  const requiredSignatures = Number(transaction?.message?.header?.numRequiredSignatures);
  if (feePayer !== expectedFeePayer) {
    throw new Error("Jupiter transaction fee payer does not match the signing wallet");
  }
  if (requiredSignatures !== 1) {
    throw new Error(`Jupiter transaction requires ${Number.isFinite(requiredSignatures) ? requiredSignatures : "an unknown number of"} signers; exactly one is allowed`);
  }
  return true;
}

const SAFE_TOKEN_2022_MINT_EXTENSIONS = new Set(["MetadataPointer", "TokenMetadata"]);

function extensionTypeName(extensionType) {
  if (typeof extensionType === "string") return extensionType;
  const numericType = Number(extensionType);
  const knownName = Number.isInteger(numericType) ? ExtensionType[numericType] : null;
  return typeof knownName === "string" ? knownName : `Unknown(${String(extensionType)})`;
}

export function validateMintProgramSafety({
  mint,
  programId,
  decimals,
  isInitialized = true,
  mintAuthority,
  freezeAuthority,
  extensionTypes = [],
} = {}, {
  requireLegacyTokenProgram = true,
  allowMetadataOnlyToken2022 = false,
} = {}) {
  const normalizedExtensions = [...new Set((extensionTypes || []).map(extensionTypeName))];
  const legacyTokenProgram = programId === LEGACY_TOKEN_PROGRAM_ID;
  const token2022Program = programId === TOKEN_2022_PROGRAM_ID_STRING;

  if (!legacyTokenProgram && !token2022Program) {
    throw new Error(`Token ${mint} is owned by unsupported program ${programId || "unknown"}`);
  }
  if (!legacyTokenProgram && (requireLegacyTokenProgram || !allowMetadataOnlyToken2022)) {
    throw new Error(`Token ${mint} is not owned by the legacy SPL Token program`);
  }
  if (legacyTokenProgram && normalizedExtensions.length > 0) {
    throw new Error(`Legacy token ${mint} unexpectedly contains extensions: ${normalizedExtensions.join(", ")}`);
  }
  if (token2022Program) {
    const unsupported = normalizedExtensions.filter((extension) => !SAFE_TOKEN_2022_MINT_EXTENSIONS.has(extension));
    if (unsupported.length > 0) {
      throw new Error(`Token ${mint} has unsupported Token-2022 extension(s): ${unsupported.join(", ")}`);
    }
  }
  if (isInitialized !== true) throw new Error(`Token ${mint} mint is not initialized`);

  const result = {
    mint,
    programId,
    decimals: Number(decimals),
    isInitialized: true,
    mintAuthorityDisabled: mintAuthority == null,
    freezeAuthorityDisabled: freezeAuthority == null,
    legacyTokenProgram,
    token2022Program,
    metadataOnlyToken2022: token2022Program,
    extensionTypes: normalizedExtensions,
  };
  if (!result.mintAuthorityDisabled) throw new Error(`Token ${mint} still has a mint authority`);
  if (!result.freezeAuthorityDisabled) throw new Error(`Token ${mint} still has a freeze authority`);
  return result;
}

export async function inspectMintSafety(mint, {
  requireLegacyTokenProgram = true,
  allowMetadataOnlyToken2022 = false,
  connection = getConnection(),
} = {}) {
  const normalized = normalizeMint(mint);
  if (!normalized || normalized === SOL_MINT) throw new Error("A non-SOL token mint is required");
  const mintAddress = new PublicKey(normalized);
  const account = await connection.getAccountInfo(mintAddress, "finalized");
  if (!account) throw new Error(`Token mint ${normalized} does not exist at finalized commitment`);
  const programId = account.owner?.toBase58?.() || String(account.owner || "");
  let unpacked;
  try {
    unpacked = unpackMint(mintAddress, account, new PublicKey(programId));
  } catch (error) {
    throw new Error(`Token mint ${normalized} could not be parsed safely: ${error.message}`);
  }
  const extensionTypes = programId === TOKEN_2022_PROGRAM_ID_STRING
    ? getExtensionTypes(unpacked.tlvData)
    : [];
  return validateMintProgramSafety({
    mint: normalized,
    programId,
    decimals: unpacked.decimals,
    isInitialized: unpacked.isInitialized,
    mintAuthority: unpacked.mintAuthority,
    freezeAuthority: unpacked.freezeAuthority,
    extensionTypes,
  }, { requireLegacyTokenProgram, allowMetadataOnlyToken2022 });
}

export async function getJupiterPrices(mints) {
  const normalized = [...new Set((mints || []).map(normalizeMint).filter(Boolean))];
  if (normalized.length === 0) return {};
  const apiKey = requireJupiterApiKey();
  const response = await fetch(`${JUPITER_PRICE_API}?ids=${encodeURIComponent(normalized.join(","))}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) throw new Error(`Jupiter Price API failed: ${response.status} ${await response.text()}`);
  return response.json();
}

export async function getFinalizedSlot() {
  return getConnection().getSlot("finalized");
}

async function fetchJupiterQuoteOnly({
  inputMint,
  outputMint,
  amountAtomic,
  slippageBps,
  maxPriceImpactPct,
}) {
  const apiKey = requireJupiterApiKey();
  const search = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountAtomic),
    swapMode: "ExactIn",
    slippageBps: String(slippageBps),
    excludeRouters: "jupiterz",
  });
  const referralParams = getJupiterReferralParams();
  if (referralParams) {
    search.set("referralAccount", referralParams.referralAccount);
    search.set("referralFee", String(referralParams.referralFee));
  }
  const response = await fetch(`${JUPITER_SWAP_V2_API}/order?${search.toString()}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) throw new Error(`Swap V2 quote failed: ${response.status} ${await response.text()}`);
  const order = await response.json();
  return validateJupiterQuote(order, {
    inputMint,
    outputMint,
    inAmount: String(amountAtomic),
    maxSlippageBps: slippageBps,
    maxPriceImpactPct,
    maxFeeBps: config.spot.maxFeeBps,
  });
}

export async function getSpotRoundTripQuote({ mint, amountSol }) {
  const outputMint = normalizeMint(mint);
  const amount = assertSpotSwapAllowed({
    mode: config.trading.mode,
    direction: "buy",
    inputMint: SOL_MINT,
    outputMint,
    amount: amountSol,
    configuredTradeAmountSol: config.spot.tradeAmountSol,
    maxTradeAmountSol: config.spot.maxTradeAmountSol,
  });
  const inputLamports = atomicAmount(amount, 9);
  const startedAt = Date.now();
  const buy = await fetchJupiterQuoteOnly({
    inputMint: SOL_MINT,
    outputMint,
    amountAtomic: inputLamports,
    slippageBps: config.spot.entrySlippageBps,
    maxPriceImpactPct: config.spot.maxEntryPriceImpactPct,
  });
  const sell = await fetchJupiterQuoteOnly({
    inputMint: outputMint,
    outputMint: SOL_MINT,
    amountAtomic: buy.outAmount,
    slippageBps: config.spot.profitExitSlippageBps,
    maxPriceImpactPct: config.spot.maxExitPriceImpactPct,
  });
  const viability = evaluateSpotRoundTripQuote({
    inputLamports,
    expectedReturnLamports: sell.outAmount,
    maxLossPct: config.spot.maxEntryRoundTripLossPct,
  });
  return {
    ...viability,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    inputLamports,
    expectedReturnLamports: sell.outAmount,
    minimumReturnLamports: sell.minimumOutAmount,
    buy: { router: buy.router, mode: buy.mode, priceImpactPct: buy.priceImpactPct, feeBps: buy.feeBps },
    sell: { router: sell.router, mode: sell.mode, priceImpactPct: sell.priceImpactPct, feeBps: sell.feeBps },
  };
}

async function executeJupiterSwap({
  inputMint,
  outputMint,
  amount,
  amountAtomic = null,
  slippageBps = null,
  operation,
  orderPolicy = {},
  excludeRouters = "jupiterz",
  priorityFeeLamports = null,
}) {
  const jupiterApiKey = requireJupiterApiKey();
  const wallet = getWallet();
  const connection = getConnection();
  const amountStr = amountAtomic == null
    ? atomicAmount(amount, await mintDecimals(connection, inputMint))
    : String(amountAtomic);
  if (!integerString(amountStr)) throw new Error("Swap atomic amount must be a positive integer string");
  const search = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountStr,
    taker: wallet.publicKey.toString(),
    swapMode: "ExactIn",
  });
  if (slippageBps != null) search.set("slippageBps", String(slippageBps));
  if (excludeRouters) search.set("excludeRouters", excludeRouters);
  if (priorityFeeLamports != null) {
    search.set("priorityFeeLamports", String(priorityFeeLamports));
    search.set("broadcastFeeType", "maxCap");
  }
  const referralParams = getJupiterReferralParams();
  if (referralParams) {
    search.set("referralAccount", referralParams.referralAccount);
    search.set("referralFee", String(referralParams.referralFee));
  }

  const requestedAt = Date.now();
  const orderRes = await fetch(`${JUPITER_SWAP_V2_API}/order?${search.toString()}`, {
    headers: { "x-api-key": jupiterApiKey },
  });
  if (!orderRes.ok) throw new Error(`Swap V2 order failed: ${orderRes.status} ${await orderRes.text()}`);
  const order = await orderRes.json();
  const validatedOrder = validateJupiterOrder(order, {
    inputMint,
    outputMint,
    inAmount: amountStr,
    expectedTaker: wallet.publicKey.toString(),
    allowedRouters: ["metis", "dflow", "okx"],
    requireTakerPaysFees: true,
    maxSlippageBps: slippageBps,
    requestedAt,
    ...orderPolicy,
  });

  assertOnChainWriteAllowed(operation);
  await assertMainnetRpc(connection, operation);
  if (order.lastValidBlockHeight != null) {
    const lastValidBlockHeight = Number(order.lastValidBlockHeight);
    const blockHeight = await connection.getBlockHeight("confirmed");
    if (!Number.isFinite(lastValidBlockHeight) || blockHeight >= lastValidBlockHeight) {
      throw new Error("Jupiter order block height is expired");
    }
  }
  validateJupiterOrder(order, {
    inputMint,
    outputMint,
    inAmount: amountStr,
    expectedTaker: wallet.publicKey.toString(),
    allowedRouters: ["metis", "dflow", "okx"],
    requireTakerPaysFees: true,
    maxSlippageBps: slippageBps,
    requestedAt,
    now: Date.now(),
    ...orderPolicy,
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  validateJupiterTransactionEnvelope(tx, wallet.publicKey.toString());
  tx.sign([wallet]);
  const expectedSignature = bs58.encode(tx.signatures[0]);
  await simulateJupiterTransaction(connection, tx, {
    walletPublicKey: wallet.publicKey.toString(),
    inputMint,
    outputMint,
    inAmount: amountStr,
    minimumOutAmount: validatedOrder.minimumOutAmount,
    totalFeeLamports: validatedOrder.totalFeeLamports,
  });
  const signedTransaction = Buffer.from(tx.serialize()).toString("base64");

  assertOnChainWriteAllowed(operation);
  await assertMainnetRpc(connection, operation);
  validateJupiterOrder(order, {
    inputMint,
    outputMint,
    inAmount: amountStr,
    expectedTaker: wallet.publicKey.toString(),
    allowedRouters: ["metis", "dflow", "okx"],
    requireTakerPaysFees: true,
    maxSlippageBps: slippageBps,
    requestedAt,
    now: Date.now(),
    ...orderPolicy,
  });
  const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": jupiterApiKey,
    },
    body: JSON.stringify({ signedTransaction, requestId: order.requestId, lastValidBlockHeight: order.lastValidBlockHeight }),
  });
  if (!execRes.ok) {
    const error = new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    error.submissionAttempted = true;
    throw error;
  }
  const result = await execRes.json();
  let executed;
  try {
    executed = validateJupiterExecutionResult(result, {
      expectedSignature,
      inAmount: amountStr,
      minimumOutAmount: validatedOrder.minimumOutAmount,
    });
  } catch (cause) {
    const error = new Error(cause.message);
    error.submissionAttempted = true;
    error.signature = result.signature || null;
    throw error;
  }
  const confirmation = await connection.confirmTransaction(executed.signature, "finalized");
  if (confirmation.value.err) {
    const error = new Error(`Swap finalized with on-chain error: ${JSON.stringify(confirmation.value.err)}`);
    error.submissionAttempted = true;
    error.signature = executed.signature;
    throw error;
  }

  return {
    success: true,
    tx: executed.signature,
    input_mint: inputMint,
    output_mint: outputMint,
    input_amount_atomic: executed.inputAmount,
    output_amount_atomic: executed.outputAmount,
    minimum_output_amount: validatedOrder.minimumOutAmount,
    minimum_net_output_amount: validatedOrder.minimumNetOutputAmount,
    expected_output_amount: validatedOrder.outAmount,
    price_impact_pct: validatedOrder.priceImpactPct,
    slippage_bps: Number(order.slippageBps),
    fee_bps_applied: validatedOrder.feeBps,
    total_transaction_fee_lamports: validatedOrder.totalFeeLamports,
    finalized: true,
  };
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
  slippage_bps = undefined,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);
  const numericAmount = assertAutonomousSwapAllowed({
    inputMint: input_mint,
    outputMint: output_mint,
    amount,
  });
  const normalizedSlippageBps = slippage_bps === undefined
    ? null
    : normalizeSlippageBps(slippage_bps);
  if (slippage_bps !== undefined && normalizedSlippageBps == null) {
    return { success: false, error: "Invalid slippage_bps: use an integer from 0 to 10000" };
  }

  if (isDryRun()) {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount: numericAmount },
      message: "DRY RUN — no transaction sent",
    };
  }

  assertLiveTradingEnabled("swap_token");

  try {
    log("swap", `${numericAmount} of ${input_mint} → ${output_mint}`);
    const result = await executeJupiterSwap({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: numericAmount,
      slippageBps: normalizedSlippageBps,
      operation: "swap_token",
    });
    log("swap", `SUCCESS finalized tx: ${result.tx}`);
    return {
      ...result,
      amount_in: result.input_amount_atomic,
      amount_out: result.output_amount_atomic,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message, submission_attempted: error.submissionAttempted === true, tx: error.signature || null };
  }
}

export async function buySpotToken({ mint, amountSol }) {
  const outputMint = normalizeMint(mint);
  const amount = assertSpotSwapAllowed({
    mode: config.trading.mode,
    direction: "buy",
    inputMint: SOL_MINT,
    outputMint,
    amount: amountSol,
    configuredTradeAmountSol: config.spot.tradeAmountSol,
    maxTradeAmountSol: config.spot.maxTradeAmountSol,
  });
  if (isDryRun()) {
    return { dry_run: true, would_swap: { input_mint: SOL_MINT, output_mint: outputMint, amount }, message: "DRY RUN — no spot buy sent" };
  }
  assertLiveTradingEnabled("open_spot_position");
  try {
    return await executeJupiterSwap({
      inputMint: SOL_MINT,
      outputMint,
      amount,
      slippageBps: config.spot.entrySlippageBps,
      operation: "open_spot_position",
      excludeRouters: "jupiterz",
      priorityFeeLamports: config.spot.maxPriorityFeeLamports,
      orderPolicy: {
        maxPriceImpactPct: config.spot.maxEntryPriceImpactPct,
        maxFeeBps: config.spot.maxFeeBps,
        maxPriorityFeeLamports: config.spot.maxPriorityFeeLamports,
        maxTotalFeeLamports: config.spot.maxTotalFeeLamports,
        quoteMaxAgeMs: config.spot.quoteMaxAgeMs,
      },
    });
  } catch (error) {
    return { success: false, error: error.message, submission_attempted: error.submissionAttempted === true, tx: error.signature || null };
  }
}

export async function sellSpotToken({
  mint,
  amount,
  rawAmount = null,
  slippageBps = null,
  minimumNetOutputLamports = null,
}) {
  const inputMint = normalizeMint(mint);
  const numericAmount = assertSpotSwapAllowed({
    mode: config.trading.mode,
    direction: "sell",
    inputMint,
    outputMint: SOL_MINT,
    amount,
    configuredTradeAmountSol: config.spot.tradeAmountSol,
    maxTradeAmountSol: config.spot.maxTradeAmountSol,
  });
  if (isDryRun()) {
    return { dry_run: true, would_swap: { input_mint: inputMint, output_mint: SOL_MINT, amount: numericAmount }, message: "DRY RUN — no spot sell sent" };
  }
  assertLiveTradingEnabled("close_spot_position");
  const resolvedSlippageBps = slippageBps ?? config.spot.exitSlippageBps;
  try {
    return await executeJupiterSwap({
      inputMint,
      outputMint: SOL_MINT,
      amount: numericAmount,
      amountAtomic: rawAmount,
      slippageBps: resolvedSlippageBps,
      operation: "close_spot_position",
      excludeRouters: "jupiterz",
      priorityFeeLamports: config.spot.maxPriorityFeeLamports,
      orderPolicy: {
        maxPriceImpactPct: config.spot.maxExitPriceImpactPct,
        maxFeeBps: config.spot.maxFeeBps,
        maxPriorityFeeLamports: config.spot.maxPriorityFeeLamports,
        maxTotalFeeLamports: config.spot.maxTotalFeeLamports,
        minimumNetOutputLamports,
        quoteMaxAgeMs: config.spot.quoteMaxAgeMs,
      },
    });
  } catch (error) {
    return { success: false, error: error.message, submission_attempted: error.submissionAttempted === true, tx: error.signature || null };
  }
}
