import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import {
  assertAutonomousSwapAllowed,
  assertLiveTradingEnabled,
  assertMainnetRpc,
  assertOnChainWriteAllowed,
  isDryRun,
  SOL_MINT,
} from "../execution-guard.js";

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
function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || "";
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

async function simulateJupiterTransaction(connection, transaction) {
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: true,
    commitment: "confirmed",
  });
  if (simulation.value.err) {
    const logs = Array.isArray(simulation.value.logs)
      ? simulation.value.logs.slice(-12).join(" | ")
      : "no simulation logs";
    throw new Error(
      `Jupiter swap simulation failed: ${JSON.stringify(simulation.value.err)} (${logs})`,
    );
  }
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

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);
  const numericAmount = assertAutonomousSwapAllowed({
    inputMint: input_mint,
    outputMint: output_mint,
    amount,
  });

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
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountAtomic = Math.floor(numericAmount * Math.pow(10, decimals));
    if (!Number.isFinite(amountAtomic) || amountAtomic <= 0) {
      throw new Error("Swap amount rounds to zero atomic units");
    }
    const amountStr = amountAtomic.toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    assertOnChainWriteAllowed("swap_token");
    await assertMainnetRpc(connection, "swap_token");
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    await simulateJupiterTransaction(connection, tx);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    assertOnChainWriteAllowed("swap_token");
    await assertMainnetRpc(connection, "swap_token");
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }
    if (!result.signature) {
      throw new Error("Swap execute response did not include a transaction signature");
    }

    const confirmation = await connection.confirmTransaction(result.signature, "finalized");
    if (confirmation.value.err) {
      throw new Error(`Swap finalized with on-chain error: ${JSON.stringify(confirmation.value.err)}`);
    }

    log("swap", `SUCCESS finalized tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
      finalized: true,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
