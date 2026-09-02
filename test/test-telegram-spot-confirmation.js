import assert from "node:assert/strict";
import test from "node:test";
import {
  createSpotConfirmationStore,
  groundSpotAgentOutcome,
  hasUngroundedSpotExecutionClaim,
  selectSpotConfirmationCandidate,
} from "../telegram-spot-confirmation.js";

const POOL_A = "11111111111111111111111111111111";
const POOL_B = "SysvarC1ock11111111111111111111111111111111";

function candidate(pool = POOL_A, name = "CTO-SOL", symbol = "CTO") {
  return {
    pool,
    name,
    base: { symbol },
    quote: { symbol: "SOL" },
    spot_score: 88,
  };
}

test("a backend candidate is armed when the assistant explicitly asks for spot confirmation", () => {
  const selected = selectSpotConfirmationCandidate({
    assistantText: [
      "CTO-SOL is the best current candidate.",
      "Mau saya coba buka posisi di CTO-SOL?",
      "Pool: hallucinated-address",
    ].join("\n"),
    candidates: [candidate()],
  });

  assert.equal(selected.pool, POOL_A);
  assert.equal(selected.name, "CTO-SOL");
});

test("ambiguous or non-confirmation assistant text cannot arm a trade", () => {
  assert.equal(selectSpotConfirmationCandidate({
    assistantText: "Mau saya buka salah satu kandidat?",
    candidates: [candidate(), candidate(POOL_B, "MEME-SOL", "MEME")],
  }), null);

  const fakeProgress = "Mencoba buka posisi CTO-SOL. Mengirim transaksi...";
  assert.equal(selectSpotConfirmationCandidate({
    assistantText: fakeProgress,
    candidates: [candidate()],
  }), null);
  assert.equal(hasUngroundedSpotExecutionClaim(fakeProgress), true);
});

test("affirmative confirmation is single-use and expires fail-closed", () => {
  let now = 1_000;
  const store = createSpotConfirmationStore({ now: () => now, ttlMs: 120_000 });
  store.arm(candidate());

  const confirmed = store.resolveReply("iya");
  assert.equal(confirmed.handled, true);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.confirmation.pool, POOL_A);

  const duplicate = store.resolveReply("ya");
  assert.equal(duplicate.handled, true);
  assert.equal(duplicate.status, "missing");

  store.arm(candidate());
  now += 120_000;
  const expired = store.resolveReply("/confirm");
  assert.equal(expired.handled, true);
  assert.equal(expired.status, "expired");
  assert.equal(store.peek(), null);
});

test("cancellation clears a pending confirmation without executing it", () => {
  const store = createSpotConfirmationStore();
  store.arm(candidate());

  const cancelled = store.resolveReply("batal");
  assert.equal(cancelled.handled, true);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(store.peek(), null);
});

test("grounded confirmation text replaces model progress claims and uses backend data", () => {
  const store = createSpotConfirmationStore({ now: () => 1_000, ttlMs: 120_000 });
  const grounded = groundSpotAgentOutcome({
    assistantText: "Mau saya buka CTO-SOL? Mengirim transaksi... Pool: wrong-address",
    candidateResult: { candidates: [candidate()] },
    openResult: null,
    confirmationStore: store,
    amountSol: 0.5,
  });

  assert.equal(grounded.kind, "confirmation_armed");
  assert.match(grounded.text, /CTO-SOL/);
  assert.match(grounded.text, new RegExp(POOL_A));
  assert.match(grounded.text, /belum ada transaksi/i);
  assert.doesNotMatch(grounded.text, /wrong-address/);
  assert.equal(store.peek().pool, POOL_A);
});

test("a newer screening result clears an older confirmation when no candidate is recommended", () => {
  const store = createSpotConfirmationStore();
  store.arm(candidate());

  const grounded = groundSpotAgentOutcome({
    assistantText: "NO TRADE. Belum ada momentum yang cukup aman.",
    candidateResult: { candidates: [] },
    openResult: null,
    confirmationStore: store,
    amountSol: 0.5,
  });

  assert.equal(grounded.kind, "assistant_text");
  assert.equal(store.peek(), null);
});

test("a blocked preflight is reported as no trade and never as transaction progress", () => {
  const grounded = groundSpotAgentOutcome({
    assistantText: "Mengirim transaksi...",
    candidateResult: null,
    openResult: {
      success: false,
      blocked: true,
      reason: "5-minute price move exceeds chase limit 12%.",
    },
    confirmationStore: createSpotConfirmationStore(),
    amountSol: 0.5,
  });

  assert.equal(grounded.kind, "open_blocked");
  assert.match(grounded.text, /NO TRADE/);
  assert.match(grounded.text, /tidak ada transaksi yang dikirim/i);
  assert.doesNotMatch(grounded.text, /mengirim transaksi/i);
});

test("an uncertain submission tells the user not to retry", () => {
  const grounded = groundSpotAgentOutcome({
    assistantText: "done",
    candidateResult: null,
    openResult: {
      success: false,
      pending: true,
      blocked: true,
      reason: "Spot buy outcome is uncertain",
      tx: "signature-123",
    },
    confirmationStore: createSpotConfirmationStore(),
    amountSol: 0.5,
  });

  assert.equal(grounded.kind, "open_uncertain");
  assert.match(grounded.text, /JANGAN kirim ulang/i);
  assert.match(grounded.text, /signature-123/);
});

test("a confirmed open is reported only from an authoritative tool result", () => {
  const grounded = groundSpotAgentOutcome({
    assistantText: "anything",
    candidateResult: null,
    openResult: {
      success: true,
      trade_status: "open",
      amount_sol: 0.5,
      tx: "signature-456",
      position: { symbol: "CTO", poolName: "CTO-SOL" },
    },
    confirmationStore: createSpotConfirmationStore(),
    amountSol: 0.5,
  });

  assert.equal(grounded.kind, "open_confirmed");
  assert.match(grounded.text, /POSISI SPOT DIBUKA/);
  assert.match(grounded.text, /signature-456/);
});

test("an open status without a transaction signature is treated as uncertain", () => {
  const grounded = groundSpotAgentOutcome({
    assistantText: "opened",
    candidateResult: null,
    openResult: {
      success: true,
      trade_status: "open",
      amount_sol: 0.5,
      position: { symbol: "CTO" },
    },
    confirmationStore: createSpotConfirmationStore(),
    amountSol: 0.5,
  });

  assert.equal(grounded.kind, "open_uncertain");
  assert.match(grounded.text, /JANGAN kirim ulang/i);
  assert.doesNotMatch(grounded.text, /POSISI SPOT DIBUKA/);
});
