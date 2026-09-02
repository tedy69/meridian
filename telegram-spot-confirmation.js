import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

export const DEFAULT_SPOT_CONFIRMATION_TTL_MS = 120_000;

const AFFIRMATIVE_REPLIES = new Set([
  "ya",
  "iya",
  "yes",
  "y",
  "ok",
  "oke",
  "gas",
  "gaskan",
  "lanjut",
  "confirm",
  "/confirm",
]);

const CANCELLATION_REPLIES = new Set([
  "batal",
  "cancel",
  "/cancel",
  "tidak",
  "nggak",
  "enggak",
  "no",
]);

function cleanText(value, maxLength = 160) {
  return String(value ?? "")
    .replace(/[\r\n\t<>`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeReply(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

function compactCandidate(candidate) {
  const poolValue = candidate?.pool ?? candidate?.pool_address;
  const pool = new PublicKey(poolValue).toBase58();
  const symbol = cleanText(candidate?.base?.symbol ?? candidate?.symbol, 32) || "UNKNOWN";
  const quoteSymbol = cleanText(candidate?.quote?.symbol, 16) || "SOL";
  const name = cleanText(candidate?.name, 64) || `${symbol}-${quoteSymbol}`;
  const score = Number(candidate?.spot_score);
  return {
    pool,
    name,
    symbol,
    spotScore: Number.isFinite(score) ? score : null,
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function createSpotConfirmationStore({
  ttlMs = DEFAULT_SPOT_CONFIRMATION_TTL_MS,
  now = () => Date.now(),
  createId = () => randomUUID(),
} = {}) {
  const boundedTtlMs = Math.max(1_000, Number(ttlMs) || DEFAULT_SPOT_CONFIRMATION_TTL_MS);
  let pending = null;

  function clearExpired() {
    if (pending && now() >= pending.expiresAt) pending = null;
  }

  return {
    arm(candidate) {
      const normalized = compactCandidate(candidate);
      const createdAt = now();
      pending = {
        ...normalized,
        id: cleanText(createId(), 80),
        createdAt,
        expiresAt: createdAt + boundedTtlMs,
      };
      return clone(pending);
    },

    peek() {
      clearExpired();
      return clone(pending);
    },

    clear() {
      const previous = pending;
      pending = null;
      return clone(previous);
    },

    resolveReply(text) {
      const reply = normalizeReply(text);
      const affirmative = AFFIRMATIVE_REPLIES.has(reply);
      const cancellation = CANCELLATION_REPLIES.has(reply);
      if (!affirmative && !cancellation) return { handled: false, status: "not_confirmation" };

      if (pending && now() >= pending.expiresAt) {
        pending = null;
        return affirmative
          ? { handled: true, status: "expired" }
          : { handled: true, status: "missing" };
      }

      if (cancellation) {
        if (!pending && reply !== "/cancel") return { handled: false, status: "not_confirmation" };
        const confirmation = pending;
        pending = null;
        return confirmation
          ? { handled: true, status: "cancelled", confirmation: clone(confirmation) }
          : { handled: true, status: "missing" };
      }

      if (!pending) return { handled: true, status: "missing" };
      const confirmation = pending;
      pending = null;
      return { handled: true, status: "confirmed", confirmation: clone(confirmation) };
    },
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsLabel(text, value) {
  const label = cleanText(value, 80).toLowerCase();
  if (label.length < 2) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(label)}([^a-z0-9]|$)`, "i").test(text);
}

function explicitlyRequestsConfirmation(text) {
  return /\b(?:mau|boleh|setuju|konfirmasi|confirm|want|shall|should)\b[\s\S]{0,120}\b(?:buka|beli|entry|open|buy)\b/i.test(text)
    || /\b(?:buka|beli|entry|open|buy)\b[\s\S]{0,120}(?:\?|\bbalas\b|\breply\b|\bkonfirmasi\b|\bconfirm\b|\bsetuju\b)/i.test(text);
}

export function selectSpotConfirmationCandidate({ assistantText, candidates } = {}) {
  const text = String(assistantText ?? "");
  if (!explicitlyRequestsConfirmation(text) || !Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const matches = [];
  for (const candidate of candidates) {
    let normalized;
    try {
      normalized = compactCandidate(candidate);
    } catch {
      continue;
    }
    const labels = [normalized.pool, normalized.name, normalized.symbol];
    if (labels.some((label) => containsLabel(text, label))) matches.push(normalized);
  }

  return matches.length === 1 ? matches[0] : null;
}

export function hasUngroundedSpotExecutionClaim(text) {
  return /\b(?:mengirim|kirim)\s+transaksi\b|\btransaksi\s+(?:sedang\s+)?dikirim\b|\bsending\s+(?:the\s+)?transaction\b|\btransaction\s+(?:was\s+)?sent\b|\bmencoba\s+buka\s+posisi\b|\bopening\s+(?:the\s+)?position\b/i.test(String(text ?? ""));
}

function formatConfirmation(confirmation, amountSol) {
  const ttlSeconds = Math.max(1, Math.ceil((confirmation.expiresAt - confirmation.createdAt) / 1_000));
  return [
    "KANDIDAT SPOT SIAP DIKONFIRMASI",
    "",
    `Pair: ${confirmation.name}`,
    `Pool: ${confirmation.pool}`,
    `Amount: ${Number(amountSol)} SOL`,
    "Status: belum ada transaksi yang dikirim.",
    "",
    `Balas ya atau /confirm dalam ${ttlSeconds} detik untuk menjalankan fresh preflight satu kali.`,
    "Balas batal atau /cancel untuk membatalkan.",
  ].join("\n");
}

function formatReason(result) {
  return cleanText(result?.reason ?? result?.error ?? "Backend tidak memberikan hasil yang dapat dipercaya.", 500);
}

function formatOpenResult(result, amountSol) {
  if (result?.dry_run === true) {
    return {
      kind: "open_dry_run",
      text: [
        "DRY RUN",
        "Fresh preflight lulus, tetapi tidak ada transaksi live yang dikirim.",
      ].join("\n"),
    };
  }

  if (result?.success === true && result?.trade_status === "open" && result?.tx) {
    const symbol = cleanText(result?.position?.symbol ?? result?.position?.poolName, 64) || "spot token";
    return {
      kind: "open_confirmed",
      text: [
        "POSISI SPOT DIBUKA",
        "",
        `Token: ${symbol}`,
        `Amount: ${Number(result?.amount_sol ?? amountSol)} SOL`,
        `Transaction: ${cleanText(result.tx, 160)}`,
        "Status: backend mengonfirmasi posisi open.",
      ].join("\n"),
    };
  }

  const uncertain = result?.pending === true
    || Boolean(result?.tx)
    || result?.success === true
    || String(result?.trade_status ?? "").includes("pending");
  if (uncertain) {
    return {
      kind: "open_uncertain",
      text: [
        "STATUS TRANSAKSI BELUM PASTI",
        "",
        formatReason(result),
        result?.tx ? `Transaction: ${cleanText(result.tx, 160)}` : null,
        "JANGAN kirim ulang konfirmasi. Cek status posisi dan chain terlebih dahulu.",
      ].filter(Boolean).join("\n"),
    };
  }

  return {
    kind: "open_blocked",
    text: [
      "NO TRADE",
      "",
      `Reason: ${formatReason(result)}`,
      "Fresh preflight berhenti sebelum submission; tidak ada transaksi yang dikirim.",
    ].join("\n"),
  };
}

export function groundSpotAgentOutcome({
  assistantText,
  candidateResult,
  openResult,
  confirmationStore,
  amountSol,
} = {}) {
  if (openResult != null) {
    confirmationStore?.clear();
    return formatOpenResult(openResult, amountSol);
  }

  if (candidateResult != null) confirmationStore?.clear();

  const selected = selectSpotConfirmationCandidate({
    assistantText,
    candidates: candidateResult?.candidates,
  });
  if (selected && confirmationStore) {
    const confirmation = confirmationStore.arm(selected);
    return {
      kind: "confirmation_armed",
      confirmation,
      text: formatConfirmation(confirmation, amountSol),
    };
  }

  if (hasUngroundedSpotExecutionClaim(assistantText)) {
    return {
      kind: "ungrounded_claim",
      text: [
        "NO TRANSACTION",
        "",
        "AI menghasilkan teks progres tanpa hasil tool eksekusi yang sah.",
        "Tidak ada transaksi yang dikirim. Jalankan screening lagi untuk membuat konfirmasi baru.",
      ].join("\n"),
    };
  }

  return { kind: "assistant_text", text: String(assistantText ?? "") };
}

export function formatSpotConfirmationResolution(resolution) {
  if (resolution?.status === "expired") {
    return "Konfirmasi entry sudah kedaluwarsa. Tidak ada transaksi yang dikirim; jalankan screening lagi.";
  }
  if (resolution?.status === "cancelled") {
    return "Konfirmasi entry dibatalkan. Tidak ada transaksi yang dikirim.";
  }
  return "Tidak ada konfirmasi entry spot yang aktif. Tidak ada transaksi yang dikirim; jalankan screening lagi.";
}

export function formatConfirmedSpotOpenResult(result, amountSol) {
  return formatOpenResult(result, amountSol);
}
