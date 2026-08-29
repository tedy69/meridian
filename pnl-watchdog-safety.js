/**
 * The PnL watchdog is safe to read while a management, screening, or claim
 * workflow is using the transaction lane. It must only avoid overlapping its
 * own RPC read, and defer a close until that transaction lane is free.
 */
export function getPnlWatchdogGate({
  pnlPollBusy = false,
  managementBusy = false,
  screeningBusy = false,
  claimAllBusy = false,
} = {}) {
  if (pnlPollBusy) {
    return {
      shouldPoll: false,
      canExecuteExit: false,
      executionBlocker: "pnl_poll",
    };
  }

  const executionBlocker = managementBusy
    ? "management"
    : screeningBusy
      ? "screening"
      : claimAllBusy
        ? "claim_all"
        : null;

  return {
    shouldPoll: true,
    canExecuteExit: executionBlocker == null,
    executionBlocker,
  };
}
