import assert from "node:assert/strict";
import test from "node:test";
import { getPnlWatchdogGate } from "../pnl-watchdog-safety.js";

test("the PnL watchdog continues sampling while another workflow owns the transaction lane", () => {
  assert.deepEqual(
    getPnlWatchdogGate({
      pnlPollBusy: false,
      managementBusy: true,
      screeningBusy: false,
      claimAllBusy: false,
    }),
    {
      shouldPoll: true,
      canExecuteExit: false,
      executionBlocker: "management",
    },
  );
});

test("the PnL watchdog prevents overlapping polls and identifies transaction blockers", () => {
  assert.deepEqual(
    getPnlWatchdogGate({
      pnlPollBusy: true,
      managementBusy: false,
      screeningBusy: false,
      claimAllBusy: false,
    }),
    {
      shouldPoll: false,
      canExecuteExit: false,
      executionBlocker: "pnl_poll",
    },
  );

  assert.deepEqual(
    getPnlWatchdogGate({
      pnlPollBusy: false,
      managementBusy: false,
      screeningBusy: true,
      claimAllBusy: false,
    }),
    {
      shouldPoll: true,
      canExecuteExit: false,
      executionBlocker: "screening",
    },
  );
});
