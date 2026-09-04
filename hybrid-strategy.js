import { selectSpotEntryCandidate } from "./spot-momentum.js";

// Scores between spot momentum and fee-generating LP are not comparable.
// Prefer the requested fast-momentum strategy. LP is an independent candidate,
// not a bypass for rejected tokens; executor revalidates its audit and mint.
export function selectHybridCandidate({ spot = [], lp = [] } = {}) {
  const selectedSpot = selectSpotEntryCandidate(spot.filter((p) => p?.round_trip_quote?.pass === true));
  if (selectedSpot) return { strategy: "spot", candidate: selectedSpot };
  const selectedLp = lp.filter((p) => p?.pool && p?.indicator_confirmation?.enabled === true
    && p.indicator_confirmation.confirmed === true && p.indicator_confirmation.skipped !== true
    && p.indicator_confirmation.intervals?.some((i) => i.ok === true && i.confirmed === true))
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0];
  return selectedLp ? { strategy: "lp", candidate: selectedLp } : null;
}

export async function scanHybridCandidates({ scanSpot, scanLp }) {
  const safeScan = async (scan) => {
    try { return await scan(); }
    catch (error) { return { candidates: [], error: error.message }; }
  };
  const lpPending = safeScan(scanLp);
  const spot = await safeScan(scanSpot);
  const fastSpot = selectHybridCandidate({ spot: spot?.candidates });
  if (fastSpot) return { spot, lp: { candidates: [], pending: true }, selected: fastSpot };
  const lp = await lpPending;
  return { spot, lp, selected: selectHybridCandidate({ spot: spot?.candidates, lp: lp?.candidates }) };
}
