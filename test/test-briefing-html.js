import assert from "node:assert/strict";
import test from "node:test";
import { formatBriefing } from "../briefing.js";

test("briefing escapes lesson text before sending Telegram HTML", () => {
  const now = new Date("2026-08-28T00:00:00.000Z");
  const briefing = formatBriefing({
    now,
    state: { positions: {} },
    lessonsData: {
      performance: [],
      lessons: [{
        created_at: now.toISOString(),
        rule: "Exit if pnl <= -15% & review <unknown=broken>",
      }],
    },
    perfSummary: null,
  });

  assert.match(
    briefing,
    /Exit if pnl &lt;= -15% &amp; review &lt;unknown=broken&gt;/,
  );
  assert.match(briefing, /<b>Morning Briefing<\/b>/);
});
